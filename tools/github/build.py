"""Build and accept public release artifacts on disposable GitHub runners."""
from __future__ import annotations

import argparse
import base64
import hashlib
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

from release import ROOT, context, expected, policy, read, require, seal, write


def run(*args, cwd=ROOT, env=None):
    subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True)


def download(url, file, digest):
    with urllib.request.urlopen(url, timeout=120) as response, file.open("xb") as stream:
        shutil.copyfileobj(response, stream)
    with file.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    require(actual == digest, "Downloaded dependency or baseline digest differs")


def prepare_python(scratch, shard):
    python = sys.executable
    if shard == "linux":
        # Official standalone Python retains the glibc 2.17 baseline. Do not
        # freeze the runner using a newer Ubuntu system libpython.
        name = "cpython-3.12.15%2B20261009-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
        archive = scratch / "python.tar.gz"
        download("https://github.com/astral-sh/python-build-standalone/releases/download/20261009/" + name,
                 archive, "ffa8f85f1b56e88b687f08d743d817015524b86a9365fd921243132b80f1a36d")
        with tarfile.open(archive) as bundle:
            bundle.extractall(scratch, filter="data")
        python = scratch / "python/bin/python3"
    run(python, "-m", "venv", ROOT / "hub-backend/.venv")
    python = ROOT / ("hub-backend/.venv/Scripts/python.exe" if shard == "windows" else "hub-backend/.venv/bin/python")
    run(python, "-m", "pip", "install", "-r", ROOT / "hub-backend/requirements-runner-build.txt")


def configure_macos_signing(env, *, validation=False):
    """Require production signing and notarization for public macOS builds."""
    if validation:
        return env
    require(env.get("SODUWORK_MAC_SIGN_IDENTITY"),
            "Public macOS releases require SODUWORK_MAC_SIGN_IDENTITY")
    skip = env.get("SODUWORK_MAC_SKIP_NOTARIZE", "").strip().lower()
    require(skip not in {"1", "true", "yes"},
            "Public macOS releases cannot skip notarization")
    env["SODUWORK_MAC_RELEASE"] = "1"
    env["SODUWORK_MAC_REAL_KEYCHAIN"] = "1"
    return env


def package_native(ctx, shard, scratch, *, validation=False):
    host = {"windows": "Windows", "linux": "Linux", "macos-arm64": "Darwin", "macos-x64": "Darwin"}[shard]
    require(platform.system() == host, "Native host required")
    target_arch = "arm64" if shard == "macos-arm64" else "x64"
    actual_arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())
    require(actual_arch == target_arch, "Native host architecture mismatch")
    prepare_python(scratch, shard)
    # A narrow bridge for the retained generic inventory/acceptance tools.
    # Values come from the real GitHub context, never a fabricated GitLab run.
    env = {**os.environ, "CI_COMMIT_SHA": ctx["commit"], "CI_PIPELINE_ID": ctx["runId"],
           "CI_JOB_ID": ctx["runId"], "CSC_IDENTITY_AUTO_DISCOVERY": "false",
           # Reuse the download-base options with upstream URLs on hosted
           # runners. Retain pinned hashes, without domestic mirror fallbacks.
           "SODUWORK_NODE_MIRROR": "https://nodejs.org/download/release",
           "SODUWORK_PYTHON_MIRROR": "https://github.com/astral-sh/python-build-standalone/releases/download",
           "SODUWORK_RUNTIME_MIRROR_ONLY": "1"}
    require(not env.get("SODUWORK_INTERNAL_BUILD"), "Internal-only builds cannot enter public workflows")
    if validation:
        # Validation emits only a checksum report. Public release entry points
        # still require the distribution review and full upgrade acceptance.
        env["SODUWORK_INTERNAL_BUILD"] = "1"
    if shard.startswith("macos-"):
        configure_macos_signing(env, validation=validation)
    npm = "npm.cmd" if shard == "windows" else "npm"
    run(npm, "ci", cwd=ROOT / "client", env=env)
    if shard.startswith("macos-"):
        env["SODUWORK_MACOS_ARCH"] = target_arch
        run(npm, "run", "build:mac", cwd=ROOT / "client", env=env)
        run("node", "tools/ci/release-artifacts.cjs", "inventory", "macos", target_arch, env=env)
    else:
        run(npm, "run", "build" if shard == "windows" else "build:linux", "--", "--publish", "never", cwd=ROOT / "client", env=env)
        run("node", "tools/ci/release-artifacts.cjs", "inventory", shard, env=env)
    return env


def native(ctx, shard, folder, scratch):
    env = package_native(ctx, shard, scratch)
    target_arch = "arm64" if shard == "macos-arm64" else "x64"
    keys = {"windows": ["windows-x64-exe"], "linux": ["linux-x64-deb", "linux-x64-rpm", "linux-x64-tar.gz"],
            "macos-arm64": ["macos-arm64-dmg"], "macos-x64": ["macos-x64-dmg"]}[shard]
    baselines = read(ROOT / "tools/ci/soduwork-acceptance-baselines.json")
    for key in keys:
        item = baselines[key]
        target = scratch / ("baseline-" + key)
        download(item["url"], target, item["sha256"])
        item["path"] = str(target)
    file = scratch / "baselines.json"
    write(file, baselines)
    env["SODUWORK_ACCEPT_BASELINES_FILE"] = str(file)
    if shard.startswith("macos-"):
        run("node", "tools/ci/accept-macos.cjs", target_arch, env=env)
        receipt = ROOT / "release-evidence/macos" / target_arch / "acceptance.json"
    elif shard == "windows":
        run("node", "tools/ci/accept-windows.cjs", env=env)
        receipt = ROOT / "release-evidence/windows/acceptance.json"
    else:
        run("node", "tools/github/accept-linux.cjs", env=env)
        receipt = ROOT / "release-evidence/linux/acceptance.json"
    for name in expected(ctx, shard):
        shutil.copyfile(ROOT / "client/dist" / name, folder / name)
    return read(receipt)


def android(ctx, folder, scratch, *, signing_env=None):
    """Build, sign, inspect and install-test the public Android APK.

    The public branch must carry the reviewed Flutter project.  Keeping this
    check here makes a missing public mobile source a hard release failure
    instead of silently publishing a desktop-only candidate.
    """
    require(platform.system() == "Linux", "Android builds run on Linux GitHub runners")
    mobile = ROOT / "mobile"
    require((mobile / "pubspec.yaml").is_file(),
            "Public Android release requires the reviewed mobile/ Flutter source")
    require(shutil.which("flutter"), "Flutter SDK is required for the Android release")
    signing_env = os.environ if signing_env is None else signing_env
    keystore_b64 = signing_env.get("SODUWORK_ANDROID_KEYSTORE_B64", "")
    password = signing_env.get("SODUWORK_ANDROID_KEYSTORE_PASSWORD", "")
    require(keystore_b64 and password, "Android signing secrets are required")
    pubspec = (mobile / "pubspec.yaml").read_text(encoding="utf-8")
    match = re.search(r"^version:\s*([^+\s]+)\+([0-9]+)\s*$", pubspec, re.MULTILINE)
    require(match and match.group(1) == ctx["version"], "Android and Client release versions differ")
    gradle = (mobile / "android/app/build.gradle.kts").read_text(encoding="utf-8")
    app_id = re.search(r'^\s*applicationId\s*=\s*"([a-z][a-z0-9_.]+)"\s*$', gradle, re.MULTILINE)
    require(app_id, "Android application ID is missing")
    signing = Path(tempfile.mkdtemp(prefix="soduwork-android-signing-", dir=scratch))
    keystore = signing / "release.jks"
    properties = mobile / "android/key.properties"
    require(not properties.exists(), "Refusing to replace existing Android signing configuration")
    try:
        keystore.write_bytes(base64.b64decode(keystore_b64, validate=True))
        properties.write_text(f"storeFile={keystore}\nstorePassword={password}\n"
                              f"keyAlias={signing_env.get('SODUWORK_ANDROID_KEY_ALIAS', 'soduwork-release')}\n"
                              f"keyPassword={password}\n", encoding="utf-8")
        run("flutter", "pub", "get", "--enforce-lockfile", cwd=mobile)
        run("flutter", "analyze", cwd=mobile)
        run("flutter", "test", cwd=mobile)
        run("flutter", "build", "apk", "--release",
            "--dart-define=SODUWORK_HUB_URL=https://service.soduwork.ai",
            "--dart-define=SODUWORK_ANDROID_WEBVIEW=true",
            "--dart-define=SODUWORK_SHARED_CONVERSATION=true",
            "--dart-define=SODUWORK_ENTERPRISE_ONLY=true",
            f"--dart-define=SODUWORK_APP_VERSION={ctx['version']}+{match.group(2)}", cwd=mobile,
            env={**os.environ, "CI_COMMIT_SHA": ctx["commit"], "CI_PIPELINE_ID": ctx["runId"]})
        artifact = mobile / "build/app/outputs/flutter-apk/app-release.apk"
        require(artifact.is_file(), "Flutter did not produce app-release.apk")
        build_tools = sorted(Path(os.environ.get("ANDROID_HOME", "/opt/android-sdk"), "build-tools").glob("*/aapt"))
        sign_tools = sorted(Path(os.environ.get("ANDROID_HOME", "/opt/android-sdk"), "build-tools").glob("*/apksigner"))
        require(build_tools and sign_tools, "Android build-tools (aapt/apksigner) are required")
        badging = subprocess.check_output([str(build_tools[-1]), "dump", "badging", str(artifact)], text=True)
        package = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging, re.MULTILINE)
        require(package and package.group(1) == app_id.group(1) and package.group(3) == ctx["version"],
                "Android package identity differs from the release")
        signature = subprocess.check_output([str(sign_tools[-1]), "verify", "--verbose", "--print-certs", str(artifact)], text=True)
        require("Verified using v2 scheme (APK Signature Scheme v2): true" in signature or
                "Verified using v3 scheme (APK Signature Scheme v3): true" in signature,
                "Android APK signature verification failed")
        if shutil.which("adb"):
            run("adb", "wait-for-device")
            run("adb", "install", "-r", str(artifact))
            try:
                run("adb", "shell", "am", "force-stop", app_id.group(1))
                run("adb", "shell", "am", "start", "-W", "-n", app_id.group(1) + "/.MainActivity")
                time.sleep(5)
                pid = subprocess.check_output(["adb", "shell", "pidof", app_id.group(1)], text=True).strip()
                require(re.fullmatch(r"[1-9]\d*(?: [1-9]\d*)*", pid), "Android app did not remain running")
            finally:
                run("adb", "uninstall", app_id.group(1))
            acceptance = "emulator-install-launch-cleanup"
        else:
            raise ValueError("Android acceptance requires adb and an emulator")
        output = folder / expected(ctx, "android")[0]
        shutil.copyfile(artifact, output)
        return {"ok": True, "checks": ["flutter-tests", "signature", "package-identity", acceptance],
                "applicationId": app_id.group(1)}
    finally:
        properties.unlink(missing_ok=True)
        shutil.rmtree(signing, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shard", choices=["source", "hub", "windows", "linux", "macos-arm64", "macos-x64", "android"])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    ctx = context()
    policy(ctx)
    require(args.shard in __import__("release").SHARDS[ctx["component"]], "Wrong component/shard")
    args.output.mkdir(parents=True, exist_ok=False)
    folder = args.output.resolve()
    with tempfile.TemporaryDirectory(prefix="soduwork-public-build-") as temporary:
        scratch = Path(temporary)
        if args.shard == "source":
            archive = scratch / expected(ctx, "source")[0]
            run(sys.executable, "tools/export_source.py", "--output", archive)
            shutil.copyfile(archive, folder / archive.name)
            checks = {"ok": True, "checks": ["committed-tree-export", "exact-source-manifest", "public-source-boundary"],
                      "limitations": ["Source archive only; no native installer or production acceptance."]}
        elif args.shard == "hub":
            from hub import build_and_accept
            checks = build_and_accept(ctx, folder)
        elif args.shard == "android":
            checks = android(ctx, folder, scratch)
        else:
            checks = native(ctx, args.shard, folder, scratch)
        seal(ctx, args.shard, folder, checks)


if __name__ == "__main__":
    main()
