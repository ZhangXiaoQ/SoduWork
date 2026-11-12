"""One-command, loopback-only SoduWork source startup with isolated persistent data."""
from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
import getpass
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
import webbrowser

from .local_environment import (ROOT, StartupError, check_dependencies, dependency_report,
                                prepare, prepare_desktop, spawn_options, stop_child, wait_child)


STATE_VERSION = 1
DEFAULT_PORT = 18989
HTTP = build_opener(ProxyHandler({}))


def default_state() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
        current, previous = base / "SoduWork/source-service", base / "SoduWork/source-service"
    elif sys.platform == "darwin":
        base = Path.home() / "Library/Application Support"
        current, previous = base / "SoduWork/source-service", base / "SoduWork/source-service"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
        current, previous = base / "soduwork/source-service", base / "soduwork/source-service"
    # Preserve existing source-service data in place; only fresh installs use the new name.
    return previous if not current.exists() and (previous / "local-service.json").is_file() else current


def secure_directory(state: Path) -> None:
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "nt":
        # Restrict newly created configuration/data to the current user and SYSTEM.
        # SIDs also work on localized Windows installations.
        result = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"],
                                capture_output=True, check=True,
                                **spawn_options())
        import re
        match = re.search(rb"S-\d+(?:-\d+)+", result.stdout)
        if not match:
            raise StartupError("Could not determine your Windows account for private data permissions.")
        sid = match.group().decode("ascii")
        subprocess.run(["icacls", str(state), "/inheritance:r", "/grant:r",
                        f"*{sid}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       **spawn_options())
    else:
        state.chmod(0o700)


def initialize(state: Path, username: str) -> dict:
    config_file = state / "local-service.json"
    if config_file.exists():
        try:
            config = json.loads(config_file.read_text(encoding="utf-8"))
            if (not isinstance(config, dict) or config.get("schema") != STATE_VERSION or not config.get("adminUser")
                    or len(config.get("authSecret", "")) < 40):
                raise ValueError("invalid local-service configuration")
            return config
        except (OSError, ValueError, TypeError) as exc:
            raise StartupError(f"Cannot read {config_file}; restore its backup. Existing data was not changed.") from exc
    if state.exists() and any(state.iterdir()):
        raise StartupError("The data directory is not empty and is not a SoduWork source-service directory. "
                           "Choose a new empty --data-dir; existing files were not changed.")
    secure_directory(state)
    config = {"schema": STATE_VERSION, "adminUser": username,
              "authSecret": secrets.token_urlsafe(48)}
    with config_file.open("x", encoding="utf-8") as output:
        json.dump(config, output, ensure_ascii=False, indent=2)
    return config


@contextmanager
def exclusive(state: Path):
    """OS-held lock is released on Ctrl+C, errors, or a killed launcher."""
    handle = (state / "service.lock").open("a+b")
    locked = False
    try:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            if os.fstat(handle.fileno()).st_size == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise StartupError("This SoduWork data directory is already running. Use its existing window.") from exc
        else:
            import fcntl
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise StartupError("This SoduWork data directory is already running. Use its existing window.") from exc
        locked = True
        yield
    finally:
        if locked:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


def initialized(state: Path) -> bool:
    db = state / "soduwork.db"
    if not db.exists():
        return False
    try:
        with closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)) as conn:
            return bool(conn.execute("SELECT COUNT(*) FROM app_user").fetchone()[0])
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc):
            return False
        raise StartupError("Cannot inspect the local database. See the data directory; no data was reset.") from exc


def password_for_start(state: Path, config: dict, stdin: bool) -> str:
    if initialized(state):
        # Existing users are authoritative; bootstrap never changes their passwords.
        return secrets.token_urlsafe(32)
    print(f"首次创建管理员 / Create the administrator account: {config['adminUser']}", flush=True)
    if stdin:
        password = sys.stdin.readline().rstrip("\r\n")
    elif sys.stdin.isatty():
        print("请设置并记住自己的密码；输入时不显示字符或星号，输入后按回车。\n"
              "Choose and remember your own password. Typing is hidden; press Enter when done.", flush=True)
        while True:
            password = getpass.getpass("设置密码 / Password (12-128 characters): ")
            if not 12 <= len(password) <= 128 or password.isspace():
                print("密码须为 12-128 个字符，请重试 / Use 12-128 characters; please try again.", flush=True)
                continue
            if password == getpass.getpass("再输一次 / Confirm password: "):
                break
            print("两次密码不一致，请重试 / Passwords did not match; please try again.", flush=True)
    else:
        raise StartupError("Run from an interactive terminal to choose the administrator password. "
                           "Automation may explicitly pass --password-stdin.")
    if not 12 <= len(password) <= 128 or password.isspace():
        raise StartupError("Choose an administrator password of 12-128 characters. No default password is provided.")
    return password


def assert_available(host: str, port: int) -> None:
    with socket.socket() as probe:
        if os.name == "nt":
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            # Match Uvicorn's POSIX listener: closed connections in TIME_WAIT
            # must not block restart, while a live listener still rejects bind.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError as exc:
            raise StartupError(f"Port {port} is already in use. Existing services were left running. "
                               "Choose another port with --port.") from exc


def runtime_environment(state: Path, config: dict, password: str, host: str, port: int) -> dict:
    # Deliberately do not inherit DATABASE_URL, model keys, remote stores,
    # deployment configuration, or the checkout's .env file.
    inherited = {"PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP",
                 "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
                 "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
                 "PUBLIC", "ALLUSERSPROFILE", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
                 "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "LD_LIBRARY_PATH",
                 "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                 "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"}
    env = {key: value for key, value in os.environ.items() if key.upper() in inherited}
    home = state / "home"
    for subdir in (home, home / "AppData/Roaming", home / "AppData/Local",
                   home / 'Documents', home / 'Downloads', home / 'Desktop', state / "runtime"):
        subdir.mkdir(parents=True, exist_ok=True)
    base = f"http://{host}:{port}"
    env.update({
        "HOME": str(home), "USERPROFILE": str(home),
        "APPDATA": str(home / "AppData/Roaming"), "LOCALAPPDATA": str(home / "AppData/Local"),
        "XDG_DATA_HOME": str(home / ".local/share"), "XDG_CONFIG_HOME": str(home / ".config"),
        "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1",
        "DATABASE_URL": "sqlite+aiosqlite:///" + (state / "soduwork.db").as_posix(),
        "SODUWORK_ENV": "development", "DB_MIGRATION_MODE": "auto",
        "ADMIN_USER": config["adminUser"], "ADMIN_PASS": password,
        "AUTH_SECRET": config["authSecret"], "HUB_PUBLIC_URL": base,
        "CORS_ORIGINS": base + ",null", "DEVICE_AUTH_COMPAT": "false",
        "SODUWORK_DATA_ROOT": str(state / "runtime"),
        "LIBRARY_STORAGE_DIR": str(state / "library"), "LIBRARY_STORAGE_BACKEND": "local",
        "CLIENT_UPDATE_DIR": str(state / "client-releases"),
        "REPORT_AUTO": "false", "REPOSITORY_SYNC_INTERVAL_SECONDS": "0",
        "SODUWORK_DEPLOY_COMMIT": "source-local",
    })
    return env


def wait_ready(child: subprocess.Popen, base: str, log: Path, timeout: float = 90) -> None:
    deadline = time.monotonic() + timeout
    last_progress = time.monotonic()
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise StartupError(f"The server stopped during initialization. See {log}; retry after fixing the reported error.")
        try:
            with HTTP.open(base + "/readyz", timeout=2) as response:
                if json.load(response).get("ready"):
                    # Readiness without a built UI is not a complete startup.
                    with HTTP.open(base + "/", timeout=2) as page:
                        if page.status == 200 and b"<html" in page.read(8192).lower():
                            return
        except (OSError, URLError, ValueError):
            pass
        if time.monotonic() - last_progress >= 15:
            print("正在等待服务就绪，首次数据库初始化可能较慢 / Waiting for the local service and database...", flush=True)
            last_progress = time.monotonic()
        time.sleep(.3)
    raise StartupError(f"The server did not become ready within {timeout:g}s. See {log}. "
                       "The failed server will be stopped; your data is retained.")


def open_management_page(base: str) -> None:
    try:
        if webbrowser.open(base):
            return
    except (webbrowser.Error, OSError):
        pass
    print(f"浏览器未自动打开，请手动访问 / Open this address in your browser: {base}", flush=True)


def serve(state: Path, config: dict, args) -> None:
    assert_available(args.host, args.port)
    initializing = not initialized(state)
    password = password_for_start(state, config, args.password_stdin)
    log = state / "startup.log"
    python, backend = prepare(state, log)
    client = prepare_desktop(state, log) if args.desktop else None
    env = runtime_environment(state, config, password, args.host, args.port)
    base = f"http://{args.host}:{args.port}"
    print("正在启动服务并准备数据库 / Starting SoduWork and applying database migrations...", flush=True)
    desktop = None
    desktop_output = None
    with log.open("ab") as output:
        child = subprocess.Popen([str(python), str(backend / "_soduwork_source_server.py"),
                                  "--port", str(args.port), "--host", args.host],
                                 cwd=backend, env=env, stdin=subprocess.PIPE,
                                 stdout=output, stderr=subprocess.STDOUT,
                                 **spawn_options())
        try:
            # Cold migrations need a larger bounded budget on slower filesystems.
            wait_ready(child, base, log, timeout=600 if initializing else 90)
            print(f"\nSoduWork is ready: {base}\nAdministrator: {config['adminUser']}"
                  f"\nData and logs: {state}\nKeep this window open. Press Ctrl+C to stop."
                  f"\n启动成功！管理页面：{base}\n登录账号：{config['adminUser']}；密码为刚才自己设置的密码。"
                  "\n请保持此窗口打开；下次仍运行同一个启动文件。"
                  "\n下一步：管理页面 → 能力配置 → 模型目录，添加自己的模型服务。"
                  "\nNext: management UI → Capabilities → Model catalog. Add your own model service before using AI.\n", flush=True)
            if not args.no_browser:
                open_management_page(base)
            if client is not None:
                desktop_output = (state / 'desktop.log').open('ab')
                desktop = launch_desktop(state, client, env, base, desktop_output)
                print("正在打开桌面端，使用上面的同一账号密码登录。\n"
                      "Opening desktop. Sign in with the administrator account you created.\n"
                      "Quit the desktop application or press Ctrl+C here to stop this local session.", flush=True)
                wait_session(child, desktop, state)
            else:
                wait_child(child)
            if child.returncode:
                raise StartupError(f"The server exited unexpectedly. See {log}.")
        finally:
            if desktop is not None:
                desktop.stdin.close()
                try:
                    desktop.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                stop_child(desktop)
            if desktop_output is not None:
                desktop_output.close()
            child.stdin.close()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            stop_child(child)


def desktop_profile(state: Path) -> Path:
    if sys.platform == 'darwin':
        app_data = Path.home() / 'Library/Application Support'
        if state.resolve() == (app_data / 'SoduWork/source-service').resolve():
            # The existing Hub state is below the installed Electron profile.
            # Keep its database in place and put the source desktop outside it.
            return app_data / 'SoduWork Development/source-service-desktop'
    return state / 'desktop-profile'


def launch_desktop(state: Path, client: Path, env: dict, base: str, output) -> subprocess.Popen:
    """The source session owns a separate profile and never rewrites an installed client."""
    profile = desktop_profile(state)
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    (profile / 'hub-endpoint.json').write_text(json.dumps({'hub': base}), encoding='utf-8')
    config = profile / 'chat-config.json'
    if not config.exists():
        work = state / 'workspaces'
        work.mkdir(parents=True, exist_ok=True)
        with config.open('x', encoding='utf-8') as stream:
            json.dump({'workDir': str(work)}, stream)
    desktop_env = {key: value for key, value in env.items()
                   if key not in {'ADMIN_USER', 'ADMIN_PASS', 'AUTH_SECRET', 'DATABASE_URL'}}
    desktop_env.update(SODUWORK_USER_DATA=str(profile), VIRTUAL_ENV=str(state / 'venv'),
                       SODUWORK_SOURCE_SESSION='1')
    bin_dir = state / 'venv' / ('Scripts' if os.name == 'nt' else 'bin')
    desktop_env['PATH'] = str(bin_dir) + os.pathsep + desktop_env.get('PATH', '')
    for key in ('DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY'):
        if key in os.environ:
            desktop_env[key] = os.environ[key]
    import shutil
    return subprocess.Popen([shutil.which('node'), str(client / 'scripts/start-client.cjs')], cwd=client,
                            env=desktop_env, stdin=subprocess.PIPE, stdout=output,
                            stderr=subprocess.STDOUT, **spawn_options())


def wait_session(server: subprocess.Popen, desktop: subprocess.Popen, state: Path) -> None:
    while server.poll() is None:
        try:
            code = desktop.wait(timeout=.5)
        except subprocess.TimeoutExpired:
            continue
        if code:
            raise StartupError(f"The desktop application exited (code {code}). See {state / 'desktop.log'}; "
                               "you can retry without --desktop to use the management page.")
        return


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=default_state(), help="New empty directory, or this launcher's existing directory")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="HTTP port (default: 18989)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Bind address (default: loopback only; pass a LAN IP to expose on your network)")
    parser.add_argument("--admin-user", default="admin", help="Administrator username for first initialization")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--desktop", action="store_true", help="Also install and open the desktop client with an isolated profile")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Check prerequisites without installing or changing files")
    mode.add_argument("--prepare-only", action="store_true", help="Install dependencies and build the UI, without starting a service or asking for a password")
    parser.add_argument("--password-stdin", action="store_true", help="Read the first administrator password from stdin, never arguments or a file")
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")
    if not args.admin_user.strip() or len(args.admin_user) > 64:
        parser.error("--admin-user must contain 1-64 non-blank characters")
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, signal.default_int_handler)
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    try:
        if args.check:
            dependency_report(desktop=args.desktop)
            return 0
        check_dependencies()
        state = args.data_dir.expanduser().resolve()
        # Never turn a source/runtime directory into this launcher's managed copy.
        if state.is_relative_to(ROOT) or state in ROOT.parents or state == Path.home():
            raise StartupError("Use a dedicated data directory outside the source checkout, not your home or repository root.")
        config = initialize(state, args.admin_user.strip())
        with exclusive(state):
            print(f"数据目录 / Data directory: {state}\n详细日志 / Detailed log: {state / 'startup.log'}\n"
                  "首次启动需要联网下载依赖，可能需要数分钟。已完成的步骤会复用，请勿重复启动。\n"
                  "First setup downloads dependencies and can take several minutes. Completed steps are reused.", flush=True)
            if args.prepare_only:
                prepare(state, state / 'startup.log')
                if args.desktop:
                    prepare_desktop(state, state / 'startup.log')
                print("Preparation complete. Run the same command without --prepare-only to start SoduWork.")
                return 0
            serve(state, config, args)
        return 0
    except KeyboardInterrupt:
        print("\nSoduWork stopped. Your data is retained.")
        return 0
    except (StartupError, OSError, subprocess.SubprocessError) as exc:
        print(f"\nSoduWork 启动未完成 / SoduWork could not start: {exc}\n"
              "修正上方问题后，重新运行同一个启动文件；无需删除数据或重装整个工程。\n"
              "Fix the reported issue and run the same launcher again. See docs/getting-started.md.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
