import { spawn } from "node:child_process";
import path from "node:path";

const cf = path.join(process.cwd(), "tools", "cloudflared", "cloudflared.exe");
const port = process.env.PORT || "8080";

const child = spawn(cf, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
  stdio: ["ignore", "pipe", "pipe"],
});

function onLine(line) {
  process.stdout.write(line + "\n");
  const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m) {
    const base = m[0].replace(/\/$/, "");
    console.log("\n=== VK: Размещение → Режим разработки → URL ===");
    console.log(base + "/index.html");
    console.log("=== Открыть: https://vk.ru/app54660972 ===\n");
  }
}

child.stdout.on("data", (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach(onLine));
child.stderr.on("data", (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach(onLine));
child.on("exit", (code) => process.exit(code ?? 0));

process.on("SIGINT", () => child.kill("SIGINT"));
