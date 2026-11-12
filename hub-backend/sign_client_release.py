"""Create an offline-signed SoduWork client release bundle without database access."""
from __future__ import annotations

import argparse
import json
import os
import stat
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from app.services import client_updates as updates


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Offline-sign a SoduWork client release")
    parser.add_argument("installer")
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--channel", default="stable", choices=("stable", "beta"))
    parser.add_argument("--platform", default="win32", choices=("win32", "darwin", "linux", "android"))
    parser.add_argument("--arch", default="x64", choices=("x64", "arm64", "universal"))
    parser.add_argument("--notes", default="")
    parser.add_argument("--minimum", default="")
    parser.add_argument("--mandatory", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = arguments()
    source = Path(args.installer).resolve()
    output = Path(args.output).resolve()
    key_path = Path(args.key_file).resolve()
    arches = {"universal"} if args.platform == "android" else updates.RELEASE_ARCHES
    if args.arch not in arches:
        raise SystemExit("architecture does not match release platform")
    if updates.parse_version(args.version) is None:
        raise SystemExit("version must be x.y.z")
    if args.minimum and updates.parse_version(args.minimum) is None:
        raise SystemExit("minimum must be x.y.z")
    if not source.is_file() or source.name not in updates._expected_installer_names(args.platform, args.arch, args.version):
        raise SystemExit("installer filename/version mismatch")
    if source.stat().st_size < 1024 * 1024:
        raise SystemExit("installer is too small")
    if not key_path.is_file():
        raise SystemExit("signing key file does not exist")
    if os.name != "nt" and stat.S_IMODE(key_path.stat().st_mode) & 0o077:
        raise SystemExit("signing key file permissions are too broad")
    key_raw = key_path.read_text(encoding="ascii").strip()
    updates.private_key(key_raw)
    if not updates.KEY_ID_RE.fullmatch(args.key_id):
        raise SystemExit("key id is invalid")
    created_at = datetime.now(timezone.utc).replace(microsecond=0)
    release = SimpleNamespace(
        id=str(uuid.uuid4()),
        version=args.version,
        channel=args.channel,
        platform=args.platform,
        arch=args.arch,
        artifact_name=source.name,
        artifact_size=source.stat().st_size,
        sha256=updates.sha256_file(source),
        signature="",
        key_id=args.key_id,
        notes=args.notes,
        mandatory=bool(args.mandatory),
        min_version=args.minimum,
        created_at=created_at,
    )
    payload = updates.manifest_payload(release)
    bundle = {**payload, "signature": updates.sign(payload, key_raw)}
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit("signed bundle already exists")
    output.write_text(
        json.dumps(bundle, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"signed {release.version} release_id={release.id} key_id={release.key_id}")
    print(f"artifact {source.name} {release.artifact_size} sha256={release.sha256}")


if __name__ == "__main__":
    main()
