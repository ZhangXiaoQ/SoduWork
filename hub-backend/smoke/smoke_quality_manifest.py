"""The release gate must account for every smoke test exactly once."""
from __future__ import annotations

from pathlib import Path
import os
import subprocess
import sys
import tempfile

from quality_manifest import (
    EXTENDED_SMOKES,
    LIVE_SMOKES,
    RELEASE_SMOKES,
    all_registered,
    audit_manifest,
    scripts_for,
)


BACKEND = Path(__file__).resolve().parent.parent
passed = failed = 0


def check(name: str, condition: bool, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, "<<", detail)


errors = audit_manifest(BACKEND)
registered = all_registered()
discovered = tuple(sorted(path.relative_to(BACKEND).as_posix()
                          for path in (BACKEND / "smoke").glob("smoke_*.py")))

check("all smoke files are registered exactly once", not errors, errors)
check("manifest covers smoke files and explicitly registered unittest entries",
      {name for name in registered if name.startswith("smoke/")} == set(discovered)
      and all(name.startswith("smoke/") or (name.startswith("test_") and (BACKEND / name).is_file())
              for name in registered))
check("release profile is deterministic-only", scripts_for("release") == RELEASE_SMOKES)
check("extended profile includes release and extended checks",
      scripts_for("extended") == RELEASE_SMOKES + EXTENDED_SMOKES)
check("live profile never pulls offline checks in implicitly", scripts_for("live") == LIVE_SMOKES)
check("every tier is non-empty", all((RELEASE_SMOKES, EXTENDED_SMOKES, LIVE_SMOKES)))
with tempfile.TemporaryDirectory(prefix="soduwork-misplaced-smoke-") as temporary:
    misplaced = Path(temporary) / "smoke_unregistered.py"
    misplaced.write_text("raise AssertionError('must be registered')", encoding="utf-8")
    check("top-level smoke files cannot silently bypass registration",
          any("must live in smoke/" in error for error in audit_manifest(Path(temporary))))
check("Harness2 and requirement maintenance regressions stay in the offline release gate",
      {"test_harness2_regressions.py", "test_requirement_review_access.py",
       "test_requirement_maintenance.py", "test_requirement_maintenance_policy.py",
       "test_handoff_maintenance_boundary.py", "test_notice_audience_regression.py",
       "test_darwin_process_tree.py", "test_harness2_engine.py",
       "test_harness2_lifecycle.py", "test_harness2_platforms.py",
       "test_managed_agent_download.py", "test_opencode_runtime_config.py"}
      <= set(RELEASE_SMOKES))
import unittest
from collections import Counter


def test_ids(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from test_ids(item)
        else:
            yield item.id()


loader = unittest.TestLoader()
expected = Counter(test_ids(loader.loadTestsFromName("test_requirement_maintenance_regressions")))
distributed = Counter(test_ids(loader.loadTestsFromNames([
    "test_requirement_maintenance", "test_requirement_maintenance_policy",
    "test_handoff_maintenance_boundary", "test_notice_audience_regression", "test_requirement_review_access"])))
check("distributed maintenance entries preserve every aggregate test exactly once",
      bool(expected) and expected == distributed and not loader.errors, loader.errors)
check("account deletion and device-channel revocation stay in the offline release gate",
      {"test_account_privacy.py", "test_device_connections.py"} <= set(RELEASE_SMOKES))
check("tier entries stay sorted for reviewability",
      all(tuple(sorted(group)) == group
          for group in (RELEASE_SMOKES, EXTENDED_SMOKES, LIVE_SMOKES)))
from quality_gate import _isolated_env, _python_check_command, LIVE_ENV_KEYS
with tempfile.TemporaryDirectory(prefix="soduwork-gate-contract-") as temporary:
    base = os.environ.copy()
    for key in LIVE_ENV_KEYS:
        base.pop(key, None)
    isolated = _isolated_env(base, Path(temporary), 1, "test-isolated-entry")
    check("offline checks cannot inherit live Redis or signing credentials",
          isolated["CLUSTER_REDIS_URL"] == "" and isolated["SODUWORK_ENV"] == "development"
          and len(isolated["AUTH_SECRET"]) == 64
          and isolated["AUTH_SECRET"] != base.get("AUTH_SECRET"))
    probe = subprocess.run([sys.executable, "-c",
        "import sys; sys.argv[0]='test_isolated_entry.py'; from app.db import _smoke_db_guard; "
        "import os; _smoke_db_guard(os.environ['DATABASE_URL'])"],
        cwd=BACKEND, env=isolated, capture_output=True, timeout=20)
    check("test entries use a private database accepted by the production safety guard",
          probe.returncode == 0 and Path(temporary).as_posix() in isolated["DATABASE_URL"],
          probe.stderr.decode("utf-8", errors="replace")[-500:])
check("unittest gate entries run discovery instead of silently importing",
      _python_check_command("test_model_runtime_cancellation.py") ==
      [sys.executable, "-m", "unittest", "-v", "test_model_runtime_cancellation"]
      and _python_check_command("smoke/smoke_capabilities.py") == [sys.executable, "-m", "smoke.smoke_capabilities"])
proxy_source = (BACKEND / "smoke/smoke_ai_proxy.py").read_text(encoding="utf-8")
check(
    "live AI smoke proves temporary identity cleanup before reporting success",
    "def _finish(code: int)" in proxy_source
    and "_DB_LOOP.run_until_complete(_purge_temp_identity())" in proxy_source
    and "raise SystemExit(_finish(1))" in proxy_source
    and "finally:\n        await engine.dispose()\n    _TEMP_CREATED = False" in proxy_source
    and "atexit.unregister(_purge_temp_identity_at_exit)" in proxy_source
    and "if _TEMP_CREATED:\n        code = 1" in proxy_source
    and "raise SystemExit(_finish(1 if fail else 0))" in proxy_source
    and "sys.exit(1 if fail else 0)" not in proxy_source,
)


print(f"\n{passed} PASS / {failed} FAIL · {len(registered)} smokes registered")
raise SystemExit(1 if failed else 0)
