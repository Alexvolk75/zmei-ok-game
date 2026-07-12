import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.join(process.cwd(), "hosting-build");
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "0.0.0.0";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    let p = decodeURIComponent(reqUrl.pathname);
    if (p.endsWith("/")) p += "index.html";
    const filePath = path.join(root, p.replace(/^\/+/, ""));
    if (!filePath.startsWith(root)) {
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
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(buf);
  } catch (e) {
    res.writeHead(500);
    res.end("error");
  }
});

server.listen(port, host, () => {
  console.log(`local static server: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
});
