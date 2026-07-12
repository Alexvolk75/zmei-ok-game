/**
 * Локальная разработка БЕЗ VK hosting (не stage, не prod).
 * 1) static server на PORT
 * 2) HTTPS-туннель (cloudflared → localtunnel fallback)
 * 3) печатает URL для «Режим разработки» в VK
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const root = process.cwd();
const port = Number(process.env.PORT || 8080);
const host = "127.0.0.1";
const cf = path.join(root, "tools", "cloudflared", "cloudflared.exe");
const outFile = path.join(root, "LOCAL-DEV-URL.txt");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function startStaticServer() {
  const staticRoot = path.join(root, "hosting-build");
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", `http://${host}:${port}`);
        let p = decodeURIComponent(reqUrl.pathname);
        if (p.endsWith("/")) p += "index.html";
        const filePath = path.join(staticRoot, p.replace(/^\/+/, ""));
        if (!filePath.startsWith(staticRoot)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        if (!existsSync(filePath)) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const buf = await readFile(filePath);
        res.writeHead(200, { "content-type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
        res.end(buf);
      } catch {
        res.writeHead(500);
        res.end("error");
      }
    });
    server.on("error", reject);
    server.listen(port, host, () => {
      console.log(`[local] http://${host}:${port}`);
      resolve(server);
    });
  });
}

function waitForUrl(child, pattern, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), 90000);
    const onData = (buf) => {
      const text = String(buf);
      process.stderr.write(text);
      const m = text.match(pattern);
      if (m) {
        clearTimeout(timer);
        resolve(m[0].replace(/\/$/, ""));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      if (code) reject(new Error(`${label} exit ${code}`));
    });
  });
}

async function startLocalhostRun() {
  const child = spawn(
    "ssh",
    ["-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30", "-R", `80:${host}:${port}`, "nokey@localhost.run"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const url = await waitForUrl(child, /https:\/\/[a-z0-9]+\.lhr\.life/i, "localhost.run");
    return { url, child, kind: "localhost.run" };
  } catch {
    child.kill("SIGTERM");
    return null;
  }
}

async function startCloudflared() {
  if (!existsSync(cf)) return null;
  const child = spawn(cf, ["tunnel", "--url", `http://${host}:${port}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await waitForUrl(child, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i, "cloudflared");
    return { url, child, kind: "cloudflared" };
  } catch {
    child.kill("SIGTERM");
    return null;
  }
}

async function probe(url) {
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(url + "/index.html", {
        headers: { "Bypass-Tunnel-Reminder": "true" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  console.log("[dev-local] bundle…");
  const bundle = spawn("node", ["./scripts/bundle-hosting.mjs"], { cwd: root, stdio: "inherit", shell: true });
  await new Promise((res, rej) => bundle.on("exit", (c) => (c === 0 ? res() : rej(new Error("bundle failed")))));

  const server = await startStaticServer();

  console.log("[dev-local] tunnel…");
  let tunnel = await startLocalhostRun();
  if (!tunnel) tunnel = await startCloudflared();

  const base = tunnel.url;
  const vkUrl = base + "/index.html";
  const ok = await probe(base);

  const lines = [
    vkUrl,
    "",
    "VK: Размещение → Режим разработки → URL (web + mobile + mvk)",
    "Открыть: https://vk.ru/app54660972",
    "",
    `tunnel: ${tunnel.kind}`,
    `probe: ${ok ? "OK" : "FAIL — открой URL в браузере вручную"}`,
  ];
  writeFileSync(outFile, lines.join("\n"), "utf8");

  console.log("\n========== URL ДЛЯ VK (НЕ stage, НЕ prod) ==========");
  console.log(vkUrl);
  console.log("===================================================\n");
  console.log(`Сохранено: ${outFile}`);
  console.log("Ctrl+C — остановить сервер и туннель\n");

  const stop = () => {
    tunnel.child.kill("SIGTERM");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
