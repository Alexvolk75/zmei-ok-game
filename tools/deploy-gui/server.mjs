import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

/** @type {Set<http.ServerResponse>} */
const clients = new Set();

let job = {
  running: false,
  queue: [],
  baseDir: "",
  environment: "production",
  current: null,
  results: [],
};

function sendEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function safeJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res) {
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const p = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
  const filePath = path.join(publicDir, p);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = path.extname(filePath);
  const ct =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".js"
        ? "text/javascript; charset=utf-8"
        : "text/plain; charset=utf-8";
  readFile(filePath)
    .then((buf) => {
      res.writeHead(200, { "content-type": ct });
      res.end(buf);
    })
    .catch(() => {
      res.writeHead(500);
      res.end("error");
    });
}

async function withTempAppId(baseDir, appId, fn) {
  const cfgPath = path.join(baseDir, "vk-hosting-config.json");
  const original = await readFile(cfgPath, "utf8");
  let next;
  try {
    const parsed = JSON.parse(original);
    parsed.app_id = Number(appId);
    next = JSON.stringify(parsed, null, 2) + "\n";
  } catch {
    // last-resort: simple replace of first number after "app_id":
    next = original.replace(/"app_id"\s*:\s*\d+/, `"app_id": ${Number(appId)}`);
  }

  await writeFile(cfgPath, next, "utf8");
  try {
    return await fn();
  } finally {
    await writeFile(cfgPath, original, "utf8");
  }
}

function parseProdUrlFromLog(line) {
  const m = line.match(/https:\/\/prod-app\d+-[a-z0-9]+\.pages-ac\.vk-apps\.com\/index\.html/i);
  return m ? m[0] : null;
}

async function runDeployOnce({ baseDir, appId, environment }) {
  return await withTempAppId(baseDir, appId, async () => {
    return await new Promise((resolve) => {
      const env = {
        ...process.env,
        MINI_APPS_ENVIRONMENT: environment,
        CI_URLS: "true",
      };

      // We run "npm run deploy" so it uses existing bundle+deploy pipeline.
      const child = spawn("npm", ["run", "deploy"], {
        cwd: baseDir,
        env,
        shell: true,
      });

      let prodUrl = null;
      let buf = "";
      const onData = (chunk, stream) => {
        const s = chunk.toString();
        buf += s;
        sendEvent("log", { appId, stream, text: s });
        const candidate = parseProdUrlFromLog(s);
        if (candidate) prodUrl = candidate;
      };

      child.stdout.on("data", (c) => onData(c, "stdout"));
      child.stderr.on("data", (c) => onData(c, "stderr"));

      child.on("close", (code) => {
        resolve({ ok: code === 0, code, appId, prodUrl, log: buf });
      });
    });
  });
}

async function runQueue() {
  if (job.running) return;
  job.running = true;
  sendEvent("state", { running: true });

  while (job.queue.length) {
    const appId = job.queue.shift();
    job.current = appId;
    sendEvent("state", { running: true, current: appId, remaining: job.queue.length });

    const res = await runDeployOnce({
      baseDir: job.baseDir,
      appId,
      environment: job.environment,
    });

    job.results.push(res);
    sendEvent("result", res);
  }

  job.current = null;
  job.running = false;
  sendEvent("state", { running: false });
}

function sanitizeIds(raw) {
  const ids = String(raw || "")
    .split(/[\s,;]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.replace(/[^\d]/g, ""))
    .filter(Boolean);
  // unique preserve order
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", "http://localhost");

  if (reqUrl.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write("\n");
    clients.add(res);
    res.on("close", () => clients.delete(res));
    // initial snapshot
    res.write(`event: state\ndata: ${JSON.stringify({ running: job.running, current: job.current, remaining: job.queue.length })}\n\n`);
    return;
  }

  if (reqUrl.pathname === "/api/status") {
    safeJson(res, 200, {
      running: job.running,
      current: job.current,
      remaining: job.queue.length,
      results: job.results.map((r) => ({ appId: r.appId, ok: r.ok, prodUrl: r.prodUrl, code: r.code })),
    });
    return;
  }

  if (reqUrl.pathname === "/api/start" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const baseDir = String(data.baseDir || "").trim();
        const environment = data.environment === "dev" ? "dev" : "production";
        const ids = sanitizeIds(data.appIds);

        if (!baseDir) return safeJson(res, 400, { ok: false, error: "baseDir_required" });
        if (!existsSync(path.join(baseDir, "vk-hosting-config.json"))) {
          return safeJson(res, 400, { ok: false, error: "vk-hosting-config.json_not_found" });
        }
        if (!ids.length) return safeJson(res, 400, { ok: false, error: "no_app_ids" });

        job.baseDir = baseDir;
        job.environment = environment;
        job.queue = ids.slice();
        job.results = [];
        safeJson(res, 200, { ok: true, queued: job.queue.length });
        void runQueue();
      } catch {
        safeJson(res, 400, { ok: false, error: "bad_json" });
      }
    });
    return;
  }

  if (reqUrl.pathname === "/api/stop" && req.method === "POST") {
    job.queue = [];
    safeJson(res, 200, { ok: true });
    sendEvent("state", { running: job.running, current: job.current, remaining: job.queue.length });
    return;
  }

  if (reqUrl.pathname === "/api/export" && req.method === "GET") {
    const lines = ["app_id,ok,prod_url,exit_code"];
    for (const r of job.results) {
      lines.push(`${r.appId},${r.ok ? 1 : 0},${r.prodUrl || ""},${r.code}`);
    }
    const csv = lines.join("\n") + "\n";
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"deploy-results.csv\"",
    });
    res.end(csv);
    return;
  }

  if (reqUrl.pathname === "/api/mkdir" && req.method === "POST") {
    // allows UI to create a suggested output folder later if needed
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const p = String(data.path || "");
        if (!p) return safeJson(res, 400, { ok: false });
        await mkdir(p, { recursive: true });
        safeJson(res, 200, { ok: true });
      } catch {
        safeJson(res, 400, { ok: false });
      }
    });
    return;
  }

  return serveStatic(req, res);
});

const port = Number(process.env.DEPLOY_GUI_PORT || "8787");
server.listen(port, "127.0.0.1", () => {
  // Intentionally minimal output. UI will show instructions.
  console.log(`Deploy GUI running on http://127.0.0.1:${port}`);
});

