"""Dependency preparation and source isolation for the local source launcher.

Only generated application directories are synchronized. Runtime uploads,
databases and private settings are never replaced by a source refresh.
"""
from __future__ import annotations

import hashlib
from functools import lru_cache
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import platform
import re
import time


ROOT = Path(__file__).resolve().parents[2]
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "outputs", "work"}
SKIP_SUFFIXES = {".pyc", ".pyo", ".log", ".db", ".db-shm", ".db-wal"}
BACKEND_FILES = (
    "requirements.txt", "requirements-runner.txt", "alembic.ini", "runner_main.py", "db_admin.py",
    "full_backup.py", "pack_plugin.py", "client-update-trust.json",
)
ELECTRON_DOWNLOAD_TIMEOUT = 600


class StartupError(RuntimeError):
    """A recoverable setup failure with a user-facing explanation."""


def stop_child(child: subprocess.Popen) -> None:
    """Reap only this launcher's child tree, including npm's build subprocesses."""
    if child.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, check=False)
    else:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name != "nt":
            os.killpg(child.pid, signal.SIGKILL)
        else:
            child.kill()
        child.wait(timeout=5)


def spawn_options() -> dict:
    return ({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
            else {"start_new_session": True})


def wait_child(child: subprocess.Popen, *, progress_label: str | None = None,
               timeout: float | None = None) -> int:
    # Windows' infinite WaitForSingleObject defers Python signal handlers.
    # Bounded waits keep Ctrl+C responsive during both installs and serving.
    started = last_progress = time.monotonic()
    while True:
        try:
            return child.wait(timeout=.5)
        except subprocess.TimeoutExpired:
            now = time.monotonic()
            if timeout is not None and now - started >= timeout:
                raise subprocess.TimeoutExpired(child.args, timeout)
            if progress_label and now - last_progress >= 15:
                print(f"  正在进行 / Still running: {progress_label} ({int(now - started)}s). "
                      "请保持窗口打开 / Keep this window open.", flush=True)
                last_progress = now


def run(command: list[str], *, cwd: Path, log: Path, label: str,
        env: dict | None = None, timeout: float | None = None) -> None:
    print(label, flush=True)
    started = time.monotonic()
    with log.open("ab") as output:
        output.write(("\n--- " + label + " ---\n").encode("utf-8"))
        output.flush()
        with subprocess.Popen(command, cwd=cwd, env=env, stdout=output,
                              stderr=subprocess.STDOUT, **spawn_options()) as child:
            try:
                code = wait_child(child, progress_label=label, timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                stop_child(child)
                raise StartupError(f"{label} timed out after {timeout:g}s. See {log}. "
                                   "Check the network/proxy and retry; completed steps are reused.") from exc
            except BaseException:
                stop_child(child)
                raise
    if code:
        raise StartupError(f"{label} failed (exit {code}). See {log}. "
                           "Check the network/proxy and retry; completed steps are reused.")
    print(f"  完成 / Done ({time.monotonic() - started:.1f}s)", flush=True)


def check_dependencies() -> tuple[str, str]:
    if sys.version_info < (3, 12):
        raise StartupError("Python 3.12 or newer is required: https://www.python.org/downloads/")
    node, npm = shutil.which("node"), shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not node or not npm:
        raise StartupError("请先安装 Node.js 22.19+，安装后关闭并重新打开启动窗口。\n"
                           "Install Node.js 22.19 or newer: https://nodejs.org/; then reopen this terminal.")
    try:
        version = subprocess.check_output([node, "--version"], text=True,
                                          timeout=15, **spawn_options()).strip()
        parsed = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version)
        if parsed is None or tuple(map(int, parsed.groups())) < (22, 19, 0):
            raise ValueError(version)
    except (ValueError, subprocess.SubprocessError) as exc:
        raise StartupError("Node.js 22.19 or newer is required. Check node --version.") from exc
    return node, npm


def dependency_report(*, desktop: bool = False) -> None:
    """Read-only prerequisite check; never initialize an instance or install software."""
    node, npm = check_dependencies()
    print(f"Python: {platform.python_version()} ({sys.executable})")
    print(f"Node.js: {subprocess.check_output([node, '--version'], text=True, **spawn_options()).strip()}")
    print(f"npm: {npm}\nPlatform: {platform.system()} {platform.machine()}")
    if desktop:
        if sys.platform.startswith('linux') and not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
            raise StartupError("Desktop startup requires a graphical Linux session. Use start.py without --desktop on a server.")
        print("Desktop: Electron will be installed in this instance's private application directory.")
    print("Prerequisites are ready. First-time setup needs internet access; no files were changed.")


@lru_cache(maxsize=1)
def checkout_files() -> set[Path] | None:
    """Honor Git's ignored/untracked boundary when running a development checkout.

    Official source archives contain only shipped source and need no Git binary.
    A checkout must not import a developer's ignored screenshots or private files.
    """
    git = shutil.which("git")
    if not git or not (ROOT / ".git").exists():
        return None
    try:
        output = subprocess.check_output([git, "-C", str(ROOT), "ls-files", "-co",
                                          "--exclude-standard", "-z"], timeout=20,
                                         stderr=subprocess.DEVNULL, **spawn_options())
    except subprocess.SubprocessError as exc:
        raise StartupError("Cannot inspect source checkout files. Check Git access or use a clean source archive.") from exc
    return {ROOT / item.decode("utf-8") for item in output.split(b"\0") if item}


def source_files(source: Path):
    """Do not follow user symlinks or copy ignored credentials/runtime files."""
    manifest = checkout_files() if source.is_relative_to(ROOT) else None
    for directory, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name not in SKIP_DIRS
                         and not name.startswith(".") and not (Path(directory) / name).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink() or name.startswith(".env") or path.suffix in SKIP_SUFFIXES:
                continue
            if manifest is not None and path not in manifest:
                continue
            yield path


def sync_source(source: Path, target: Path, *, preserve: frozenset[str] = frozenset()) -> None:
    """Target is a dedicated generated-code directory, never a runtime root."""
    target.mkdir(parents=True, exist_ok=True)
    wanted = set()
    for path in source_files(source):
        relative = path.relative_to(source)
        wanted.add(relative)
        dest = target / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists() or path.read_bytes() != dest.read_bytes():
            shutil.copyfile(path, dest)
    for directory, dirs, files in os.walk(target, followlinks=False):
        if Path(directory) == target:
            dirs[:] = [name for name in dirs if name not in preserve]
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()
                   and not (Path(directory) / name).is_junction()]
        for name in files:
            path = Path(directory) / name
            if path.relative_to(target) not in wanted:
                path.unlink()


def digest_files(files, root: Path) -> str:
    result = hashlib.sha256()
    for file in sorted(files):
        result.update(file.relative_to(root).as_posix().encode("utf-8") + b"\0")
        result.update(file.read_bytes())
    return result.hexdigest()


def read_stamp(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip() if path.is_file() else ""


def prepare(state: Path, log: Path) -> tuple[Path, Path]:
    _, npm = check_dependencies()
    runtime = state / "application"
    backend = runtime / "hub-backend"
    backend.mkdir(parents=True, exist_ok=True)
    for name in ("app", "migrations", "installers", "plugins"):
        sync_source(ROOT / "hub-backend" / name, backend / name)
    for name in BACKEND_FILES:
        shutil.copyfile(ROOT / "hub-backend" / name, backend / name)
    shutil.copyfile(ROOT / "tools/dev/local_server.py", backend / "_soduwork_source_server.py")
    sync_source(ROOT / "skills", runtime / "skills")
    # hub-frontend builds reference client source with relative imports (for example, ConnectorIcon.jsx ->
    # ../../../client/core/connector-brand.js), so the isolated runtime must preserve the same layout.
    sync_source(ROOT / "client", runtime / "client",
                preserve=frozenset({'node_modules', '.runtime', '.runtime-cache'}))
    sync_source(ROOT / "third-party", runtime / "third-party")
    shutil.copyfile(ROOT / "LICENSE", runtime / "LICENSE")

    venv = state / "venv"
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        run([sys.executable, "-m", "venv", str(venv)], cwd=state, log=log,
            label="[1/4] 创建独立环境 / Creating a private Python environment")
    requirements = ROOT / "hub-backend/requirements.txt"
    py_stamp = state / "python-dependencies.sha256"
    wanted = hashlib.sha256(requirements.read_bytes()).hexdigest()
    if read_stamp(py_stamp) != wanted:
        run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
             "-r", str(requirements)], cwd=state, log=log,
            label="[2/4] 安装服务依赖 / Installing server dependencies (first run needs internet)")
        py_stamp.write_text(wanted, encoding="utf-8")

    source = ROOT / "hub-frontend"
    frontend = runtime / "hub-frontend"
    frontend.mkdir(parents=True, exist_ok=True)
    for name in ("src", "public"):
        if (source / name).is_dir():
            sync_source(source / name, frontend / name)
    for name in ("package.json", "package-lock.json", "index.html", "vite.config.js"):
        shutil.copyfile(source / name, frontend / name)
    npm_stamp = state / "node-dependencies.sha256"
    wanted = hashlib.sha256((source / "package-lock.json").read_bytes()).hexdigest()
    if read_stamp(npm_stamp) != wanted or not (frontend / "node_modules/vite").is_dir():
        run([npm, "ci", "--no-audit", "--no-fund"], cwd=frontend, log=log,
            label="[3/4] 安装页面依赖 / Installing management UI dependencies")
        npm_stamp.write_text(wanted, encoding="utf-8")
    build_stamp = state / "frontend.sha256"
    files = [source / name for name in ("package.json", "package-lock.json", "index.html", "vite.config.js")]
    for name in ("src", "public"):
        if (source / name).is_dir():
            files.extend(source_files(source / name))
    files.extend((ROOT / "client" / name) for name in ("core/connector-brand.js", "components/panels/connector-config.js"))
    files.extend(source_files(ROOT / "client/assets/connector-brands"))
    wanted = digest_files(files, ROOT)
    if read_stamp(build_stamp) != wanted or not (frontend / "dist/index.html").is_file():
        run([npm, "run", "build"], cwd=frontend, log=log,
            label="[4/4] 构建管理页面 / Building the management UI")
        build_stamp.write_text(wanted, encoding="utf-8")
    return python, backend


def electron_binary(client: Path) -> Path:
    relative = ('electron.exe' if os.name == 'nt' else
                'Electron.app/Contents/MacOS/Electron' if sys.platform == 'darwin' else 'electron')
    return client / 'node_modules/electron/dist' / relative


def prepare_desktop(state: Path, log: Path) -> Path:
    """Install only in the launcher's generated copy, leaving the checkout untouched."""
    node, npm = check_dependencies()
    if sys.platform.startswith('linux') and not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        raise StartupError("Desktop startup requires a graphical Linux session. Use start.py without --desktop on a server.")
    client = state / 'application/client'
    stamp = state / 'desktop-dependencies.sha256'
    wanted = hashlib.sha256((client / 'package-lock.json').read_bytes()).hexdigest()
    if read_stamp(stamp) != wanted or not electron_binary(client).is_file():
        run([npm, 'ci', '--no-audit', '--no-fund', '--ignore-scripts'], cwd=client, log=log,
            label='[Desktop] 安装桌面端 / Installing the desktop application (first run needs internet)')
        # npm versions differ in install-script policy. Download the locked Electron
        # runtime explicitly without enabling unrelated dependencies' lifecycle scripts.
        if not electron_binary(client).is_file():
            print("桌面运行环境下载最多等待 10 分钟 / Electron download allows up to 10 minutes. "
                  "If GitHub is unreachable, configure ELECTRON_MIRROR or your proxy and retry.", flush=True)
            try:
                run([node, str(client / 'node_modules/electron/install.js')], cwd=client, log=log,
                    label='[Desktop] 下载桌面运行环境 / Downloading the Electron runtime',
                    timeout=ELECTRON_DOWNLOAD_TIMEOUT)
            except StartupError as exc:
                raise StartupError(
                    f"{exc}\nElectron 下载失败。检查网络、代理或设置 ELECTRON_MIRROR 后重试。\n"
                    "Set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ in your shell "
                    "if that mirror is reachable, then run the same launcher again. "
                    "See docs/getting-started.md for shell-specific commands."
                ) from exc
        if not electron_binary(client).is_file():
            raise StartupError(f"Electron was not downloaded. Check npm install-script policy and {log}; then retry.")
        stamp.write_text(wanted, encoding='utf-8')
    if sys.platform == 'win32':
        # Electron's dependency stamp does not cover the Shell payload. The
        # preparation script verifies its own manifest and probes the tools on
        # every launch, reusing the verified payload or an interrupted download.
        run([node, str(client / 'scripts/prepare-shell-runtime.cjs')], cwd=client, log=log,
            label='[Desktop] 准备命令运行环境 / Preparing the command runtime')
    return client
