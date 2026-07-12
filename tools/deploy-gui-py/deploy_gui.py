import json
import os
import queue
import re
import sys
import subprocess
import threading
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from tkinter import Tk, StringVar, BooleanVar, END, filedialog, messagebox, Text
from tkinter import ttk


PROD_URL_RE = re.compile(r"https://prod-app\d+-[a-z0-9]+\.pages-ac\.vk-apps\.com/index\.html", re.I)


def app_dir() -> Path:
    # If packaged (PyInstaller), write outputs next to exe, not in _MEI temp.
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


APP_DIR = app_dir()
TOKEN_FILE = APP_DIR / "vk-miniapps-access-token.txt"


def parse_pairs(raw: str) -> list[tuple[str, str]]:
    """
    Input format (one pair per line):
      VK_ID,OK_ID
    Extra spaces are allowed. Non-digits are stripped.
    """
    out: list[tuple[str, str]] = []
    seen = set()
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line:
            continue
        # allow separators: comma / space / semicolon
        parts = re.split(r"[\s,;]+", line)
        nums = [re.sub(r"[^\d]", "", p) for p in parts if re.sub(r"[^\d]", "", p)]
        if len(nums) < 2:
            continue
        vk_id, ok_id = nums[0], nums[1]
        key = (vk_id, ok_id)
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def with_temp_app_id(base_dir: Path, app_id: str, fn):
    cfg_path = base_dir / "vk-hosting-config.json"
    original = cfg_path.read_text(encoding="utf-8")
    try:
        parsed = json.loads(original)
        parsed["app_id"] = int(app_id)
        cfg_path.write_text(json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception:
        # fallback: replace first app_id number
        patched = re.sub(r'"app_id"\s*:\s*\d+', f'"app_id": {int(app_id)}', original, count=1)
        cfg_path.write_text(patched, encoding="utf-8")

    try:
        return fn()
    finally:
        cfg_path.write_text(original, encoding="utf-8")


def _run_quiet(cmd, cwd: Path, env: dict) -> tuple[int, str]:
    p = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=True,
        env=env,
    )
    out = p.communicate()[0] or ""
    return p.returncode or 0, out


def ensure_node_npm(log_fn) -> dict:
    """
    Returns env overrides: PATH prefix so that `npm` is available.
    If system Node/npm is missing, downloads portable Node to APP_DIR\\.portable-node\\ and uses it.
    """
    env = os.environ.copy()
    # Try system node/npm first
    try:
        code, _ = _run_quiet("node -v", APP_DIR, env)
        code2, _ = _run_quiet("npm -v", APP_DIR, env)
        if code == 0 and code2 == 0:
            return {}
    except Exception:
        pass

    portable_dir = APP_DIR / ".portable-node"
    node_exe = portable_dir / "node.exe"
    npm_cmd = portable_dir / "npm.cmd"

    if node_exe.exists() and npm_cmd.exists():
        log_fn(f"[INFO] Using portable Node from {portable_dir}\n")
        return {"PATH": str(portable_dir) + os.pathsep + env.get("PATH", "")}

    # Download Node Windows x64 zip (portable)
    node_ver = "v22.22.0"
    zip_name = f"node-{node_ver}-win-x64.zip"
    url = f"https://nodejs.org/dist/{node_ver}/{zip_name}"
    zip_path = APP_DIR / zip_name

    log_fn(f"[INFO] Node/npm not found. Downloading portable Node {node_ver}...\n")
    urllib.request.urlretrieve(url, zip_path)  # nosec - user requested auto bootstrap

    # Extract only once
    if portable_dir.exists():
        for p in portable_dir.glob("*"):
            try:
                if p.is_file():
                    p.unlink()
            except Exception:
                pass
    else:
        portable_dir.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path, "r") as z:
        root_prefix = f"node-{node_ver}-win-x64/"
        for m in z.namelist():
            if not m.startswith(root_prefix):
                continue
            rel = m[len(root_prefix) :]
            if not rel:
                continue
            target = portable_dir / rel
            if m.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(m) as src, open(target, "wb") as dst:
                    dst.write(src.read())

    try:
        zip_path.unlink()
    except Exception:
        pass

    log_fn(f"[INFO] Portable Node installed at {portable_dir}\n")
    return {"PATH": str(portable_dir) + os.pathsep + env.get("PATH", "")}


def ensure_deps(base: Path, log_fn, env: dict):
    # If node_modules exists we assume deps are installed
    if (base / "node_modules").exists():
        return
    log_fn("[INFO] Installing npm dependencies (first run)...\n")
    # Use npm install (not ci) for maximum compatibility
    cmd = "cmd /c chcp 65001>nul & npm install"
    code, out = _run_quiet(cmd, base, env)
    log_fn(out)
    if code != 0:
        raise RuntimeError("npm install failed")


def ensure_bin_path(base: Path, env: dict) -> None:
    """
    Ensure node_modules/.bin is on PATH so we can call vk-miniapps-deploy directly.
    """
    bin_dir = base / "node_modules" / ".bin"
    p = env.get("PATH", "")
    if str(bin_dir) not in p:
        env["PATH"] = str(bin_dir) + os.pathsep + p


def run_bundle_hosting_once(base: Path, log_fn, env: dict) -> None:
    """
    Prepare hosting-build once per run (fast). Avoids rebuilding for every app_id.
    """
    log_fn("\n[STEP] bundle:hosting (one-time)\n")
    cmd = "cmd /c chcp 65001>nul & node .\\scripts\\bundle-hosting.mjs"
    code, out = _run_quiet(cmd, base, env)
    log_fn(out)
    if code != 0:
        raise RuntimeError("bundle:hosting failed")


def run_vk_deploy(base: Path, log_fn, env: dict, silence_timeout_s: int = 240) -> tuple[int, str | None]:
    """
    Run vk-miniapps-deploy only (no bundle). Returns (exit_code, prod_url).
    """
    cmd = "cmd /c chcp 65001>nul & vk-miniapps-deploy"
    proc = subprocess.Popen(
        cmd,
        cwd=str(base),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        universal_newlines=True,
        shell=True,
        env=env,
    )

    prod_url = None
    assert proc.stdout is not None

    last_output_at = time.time()
    confirmed = False

    q: queue.Queue[str | None] = queue.Queue()

    def reader():
        try:
            for ln in proc.stdout:
                q.put(ln)
        finally:
            q.put(None)

    t = threading.Thread(target=reader, daemon=True)
    t.start()

    while True:
        try:
            line = q.get(timeout=0.5)
        except queue.Empty:
            if proc.poll() is not None:
                break
            # after confirmation, give it more time; it often prints prod urls late
            limit = silence_timeout_s if not confirmed else max(silence_timeout_s, 420)
            if time.time() - last_output_at > limit:
                log_fn("\n[ERROR] vk-miniapps-deploy завис без вывода. Убиваю процесс.\n")
                try:
                    proc.kill()
                except Exception:
                    pass
                break
            continue

        if line is None:
            break

        last_output_at = time.time()
        low = line.lower()
        if "deploy confirmed successfully" in low:
            confirmed = True
        if "confirm deploy" in low:
            log_fn("\n[HINT] Видим запрос подтверждения. На некоторых токенах это может всплывать.\n")
        m = PROD_URL_RE.search(line)
        if m:
            prod_url = m.group(0)
        log_fn(line)

    code = proc.wait(timeout=10) if proc.poll() is None else proc.returncode
    if code is None:
        code = 1
    return int(code), prod_url


def load_token_from_disk() -> str | None:
    try:
        t = TOKEN_FILE.read_text(encoding="utf-8").strip()
        return t or None
    except Exception:
        return None


def save_token_to_disk(token: str) -> None:
    TOKEN_FILE.write_text(token.strip() + "\n", encoding="utf-8")


def load_token_from_configstore() -> str | None:
    # vk-miniapps-deploy stores it here on Windows
    p = Path(os.environ.get("USERPROFILE", "")) / ".config" / "configstore" / "@vkontakte" / "vk-miniapps-deploy.json"
    if not p.exists():
        return None
    try:
        j = json.loads(p.read_text(encoding="utf-8"))
        t = str(j.get("access_token") or "").strip()
        return t or None
    except Exception:
        return None


@dataclass
class DeployResult:
    vk_id: str
    ok_id: str
    ok: bool
    exit_code: int
    prod_url: str | None


class App:
    def __init__(self):
        self.root = Tk()
        self.root.title("VK Mini Apps массовый деплой (Python)")
        self.root.geometry("980x680")

        self.base_dir = StringVar(value=r"C:\Users\Administrator\Desktop\newgame")
        self.environment = StringVar(value="production")
        self.token = StringVar(value="")
        self.running = BooleanVar(value=False)
        self.current = StringVar(value="—")
        self.remaining = StringVar(value="0")

        self.log_q: queue.Queue[str] = queue.Queue()
        self.stop_flag = threading.Event()
        self.worker_thread: threading.Thread | None = None

        self.results: list[DeployResult] = []

        self._build_ui()
        self._tick()

    def _build_ui(self):
        pad = {"padx": 10, "pady": 8}

        top = ttk.Frame(self.root)
        top.pack(fill="x", **pad)

        ttk.Label(top, text="Папка-основа (где vk-hosting-config.json):").grid(row=0, column=0, sticky="w")
        entry = ttk.Entry(top, textvariable=self.base_dir, width=90)
        entry.grid(row=1, column=0, sticky="we")
        top.columnconfigure(0, weight=1)

        ttk.Button(top, text="Выбрать…", command=self._pick_dir).grid(row=1, column=1, padx=8, sticky="e")

        tok_row = ttk.Frame(self.root)
        tok_row.pack(fill="x", **pad)
        ttk.Label(tok_row, text="MINI_APPS_ACCESS_TOKEN (секрет):").pack(side="left")
        tok_entry = ttk.Entry(tok_row, textvariable=self.token, width=80, show="•")
        tok_entry.pack(side="left", padx=(8, 8), fill="x", expand=True)
        ttk.Button(tok_row, text="Загрузить", command=self._load_token).pack(side="left", padx=(0, 6))
        ttk.Button(tok_row, text="Сохранить", command=self._save_token).pack(side="left")

        env_row = ttk.Frame(self.root)
        env_row.pack(fill="x", **pad)

        ttk.Label(env_row, text="Окружение:").pack(side="left")
        env = ttk.Combobox(env_row, textvariable=self.environment, values=["production", "dev"], width=14, state="readonly")
        env.pack(side="left", padx=(6, 18))

        ttk.Label(env_row, text="Статус:").pack(side="left")
        ttk.Label(env_row, textvariable=self.current).pack(side="left", padx=6)
        ttk.Label(env_row, text="В очереди:").pack(side="left", padx=(18, 0))
        ttk.Label(env_row, textvariable=self.remaining).pack(side="left", padx=6)

        mid = ttk.Frame(self.root)
        mid.pack(fill="both", expand=True, **pad)
        mid.columnconfigure(0, weight=1)
        mid.columnconfigure(1, weight=1)
        mid.rowconfigure(1, weight=1)

        ttk.Label(mid, text="Пары VK_ID,OK_ID (по одной паре в строке):").grid(
            row=0, column=0, sticky="w"
        )
        self.ids = Text(mid, height=10)
        self.ids.grid(row=1, column=0, sticky="nsew", padx=(0, 8))

        ttk.Label(mid, text="Лог:").grid(row=0, column=1, sticky="w")
        self.log = Text(mid, height=10)
        self.log.grid(row=1, column=1, sticky="nsew", padx=(8, 0))
        self.log.configure(state="disabled")

        btns = ttk.Frame(self.root)
        btns.pack(fill="x", **pad)

        self.btn_start = ttk.Button(btns, text="Старт", command=self._start)
        self.btn_start.pack(side="left")
        self.btn_stop = ttk.Button(btns, text="Стоп", command=self._stop, state="disabled")
        self.btn_stop.pack(side="left", padx=8)
        ttk.Button(btns, text="Экспорт CSV…", command=self._export_csv).pack(side="left", padx=8)

        hint = ttk.Frame(self.root)
        hint.pack(fill="x", **pad)
        ttk.Label(
            hint,
            text=(
                "Подсказка: чтобы деплой шёл без подтверждения/логина, вставь MINI_APPS_ACCESS_TOKEN и нажми «Сохранить»."
            ),
            foreground="#777777",
        ).pack(anchor="w")

        # preload token if present
        t = os.environ.get("MINI_APPS_ACCESS_TOKEN") or load_token_from_disk() or load_token_from_configstore()
        if t and not self.token.get():
            self.token.set(t)

    def _load_token(self):
        t = os.environ.get("MINI_APPS_ACCESS_TOKEN") or load_token_from_disk() or load_token_from_configstore()
        if not t:
            messagebox.showinfo("Токен", "Токен не найден. Вставь вручную и нажми «Сохранить».")
            return
        self.token.set(t)
        messagebox.showinfo("Токен", "Токен загружен.")

    def _save_token(self):
        t = (self.token.get() or "").strip()
        if not t:
            messagebox.showerror("Токен", "Пусто.")
            return
        save_token_to_disk(t)
        messagebox.showinfo("Токен", f"Сохранено рядом с ботом:\n{TOKEN_FILE}")

    def _pick_dir(self):
        p = filedialog.askdirectory(initialdir=self.base_dir.get() or os.getcwd())
        if p:
            self.base_dir.set(p)

    def _append_log(self, text: str):
        self.log.configure(state="normal")
        self.log.insert(END, text)
        self.log.see(END)
        self.log.configure(state="disabled")

    def _tick(self):
        try:
            while True:
                msg = self.log_q.get_nowait()
                self._append_log(msg)
        except queue.Empty:
            pass
        self.root.after(80, self._tick)

    def _set_running(self, on: bool):
        self.running.set(on)
        self.btn_start.configure(state="disabled" if on else "normal")
        self.btn_stop.configure(state="normal" if on else "disabled")

    def _stop(self):
        self.stop_flag.set()
        self.log_q.put("\n[STOP] Остановка после текущего app_id…\n")

    def _export_csv(self):
        if not self.results:
            messagebox.showinfo("Экспорт", "Пока нет результатов.")
            return
        filename = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV", "*.csv")],
            initialfile="deploy-results.csv",
        )
        if not filename:
            return
        lines = ["vk_id,ok_id,ok,prod_url,exit_code"]
        for r in self.results:
            lines.append(f"{r.vk_id},{r.ok_id},{1 if r.ok else 0},{r.prod_url or ''},{r.exit_code}")
        Path(filename).write_text("\n".join(lines) + "\n", encoding="utf-8")
        messagebox.showinfo("Экспорт", "Готово.")

    def _write_txt_results(self):
        if not self.results:
            return None
        ts = time.strftime("%Y%m%d-%H%M%S")
        out_path = APP_DIR / f"deploy-results-{ts}.txt"
        lines = []
        for r in self.results:
            lines.append(f"{r.vk_id},{r.ok_id} - {r.prod_url or ''}")
        out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return out_path

    def _start(self):
        base = Path(self.base_dir.get().strip())
        if not base.exists():
            messagebox.showerror("Ошибка", "Папка-основа не найдена.")
            return
        if not (base / "vk-hosting-config.json").exists():
            messagebox.showerror("Ошибка", "В выбранной папке нет vk-hosting-config.json.")
            return

        pairs = parse_pairs(self.ids.get("1.0", END))
        if not pairs:
            messagebox.showerror("Ошибка", "Список пустой. Формат: VK_ID,OK_ID (по одной паре в строке).")
            return

        self.results = []
        self.stop_flag.clear()
        self.current.set("—")
        self.remaining.set(str(len(pairs)))
        self._set_running(True)
        self.log_q.put("\n[START] queued=" + str(len(pairs)) + "\n")

        token = (self.token.get() or "").strip()
        if not token:
            self.log_q.put(
                "\n[ERROR] Нет MINI_APPS_ACCESS_TOKEN. Вставь токен и нажми «Сохранить», иначе vk-miniapps-deploy будет просить логин/телефон.\n"
            )
            self._set_running(False)
            return

        env = self.environment.get()
        self.worker_thread = threading.Thread(target=self._worker, args=(base, pairs, env, token), daemon=True)
        self.worker_thread.start()

    def _run_deploy(self, base: Path, vk_id: str, ok_id: str, environment: str, token: str, common_env: dict) -> DeployResult:
        def run():
            env = dict(common_env)
            env["MINI_APPS_ENVIRONMENT"] = environment
            env["CI_URLS"] = "true"
            env["MINI_APPS_ACCESS_TOKEN"] = token
            env["MINI_APPS_APP_ID"] = vk_id
            env["CI"] = "true"
            ensure_bin_path(base, env)

            code, prod_url = run_vk_deploy(base, self.log_q.put, env)
            ok = code == 0
            return DeployResult(vk_id=vk_id, ok_id=ok_id, ok=ok, exit_code=code, prod_url=prod_url)

        return with_temp_app_id(base, vk_id, run)

    def _worker(self, base: Path, pairs: list[tuple[str, str]], environment: str, token: str):
        try:
            # One-time setup for speed on any PC
            common_env = os.environ.copy()
            path_override = ensure_node_npm(self.log_q.put)
            if path_override:
                common_env["PATH"] = path_override["PATH"]
            ensure_deps(base, self.log_q.put, common_env)
            ensure_bin_path(base, common_env)
            run_bundle_hosting_once(base, self.log_q.put, common_env)

            total = len(pairs)
            for i, (vk_id, ok_id) in enumerate(pairs):
                if self.stop_flag.is_set():
                    break
                self.current.set(vk_id)
                self.remaining.set(str(total - i))
                self.log_q.put(f"\n=== VK {vk_id} / OK {ok_id} ({i+1}/{total}) ===\n")

                started = time.time()
                try:
                    res = self._run_deploy(base, vk_id, ok_id, environment, token, common_env)
                except Exception as e:
                    self.log_q.put(f"[ERROR] {vk_id}: {e}\n")
                    res = DeployResult(vk_id=vk_id, ok_id=ok_id, ok=False, exit_code=1, prod_url=None)

                dt = int(time.time() - started)
                self.results.append(res)
                self.log_q.put(
                    f"[RESULT] vk_id={res.vk_id} ok_id={res.ok_id} ok={res.ok} prod_url={res.prod_url or ''} ({dt}s)\n"
                )

        finally:
            self.current.set("—")
            self.remaining.set("0")
            self._set_running(False)
            out_path = self._write_txt_results()
            if out_path:
                self.log_q.put(f"\n[SAVED] {out_path}\n")
            self.log_q.put("\n[DONE]\n")

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    # Tkinter ships with standard Python on Windows.
    App().run()

