/**
 * Локальная разработка через официальный VK Tunnel (@vkontakte/vk-tunnel).
 * Файлы с ПК → tunnel_url от VK → dev URL в кабинете прописывается сам.
 *
 * Первый запуск: откроется oauth.vk.ru (можно QR) → Enter в консоли.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = process.env.PORT || "8080";

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { cwd: root, stdio: "inherit", shell: true, ...opts });
}

console.log("[dev:vk] bundle…");
const bundle = run("node", ["./scripts/bundle-hosting.mjs"]);
bundle.on("exit", (code) => {
  if (code !== 0) process.exit(code);

  console.log(`\n[dev:vk] local server http://127.0.0.1:${port}`);
  const server = run("node", ["./scripts/serve-local.mjs"], { env: { ...process.env, PORT: port } });

  setTimeout(() => {
    console.log("\n[dev:vk] VK Tunnel — жди ссылку https: … (не stage, не prod)\n");
    console.log("Если первый раз: открой oauth.vk.ru из консоли, залогинься, Enter.\n");
    const tunnel = run("npx", ["vk-tunnel"]);

    const stop = () => {
      tunnel.kill("SIGINT");
      server.kill("SIGINT");
      process.exit(0);
    };
    process.on("SIGINT", stop);
    tunnel.on("exit", (c) => {
      server.kill("SIGINT");
      process.exit(c ?? 0);
    });
  }, 1500);
});
