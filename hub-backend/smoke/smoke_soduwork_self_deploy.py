"""Safety invariants for SoduWork's constrained 149 self-deployment adapter."""
from pathlib import Path


SCRIPT = (Path(__file__).resolve().parents[1] / "deployers" / "soduwork-hub-local.sh").read_text(
    encoding="utf-8")


def main() -> None:
    checks = {
        "approved full commit": "^[0-9a-f]{40}$" in SCRIPT,
        "deployment endpoint comes from environment config": (
            "192.0.2.149" not in SCRIPT and "SODUWORK_HEALTH_URL is required" in SCRIPT
        ),
        "workspace commit locked": 'git rev-parse HEAD)' in SCRIPT,
        "immutable image revision": "org.opencontainers.image.revision" in SCRIPT,
        "preflight database backup": 'backup_database "${PREFLIGHT_BACKUP}"' in SCRIPT,
        "isolated migration rehearsal": 'restore_database "${PROBE_DB}"' in SCRIPT,
        "auto and check rehearsal": (
            'run_migration "${PROBE_DB}" auto' in SCRIPT
            and 'run_migration "${PROBE_DB}" check' in SCRIPT
        ),
        "Hub stopped before cutover backup": (
            SCRIPT.index('docker stop "${HUB_NAME}"')
            < SCRIPT.index('backup_database "${CUTOVER_BACKUP}"')
        ),
        "live schema checked": 'run_migration "${PG_DATABASE}" check' in SCRIPT,
        "exact release health": 'wait_for_health "${COMMIT}"' in SCRIPT,
        "automatic database and image rollback": (
            'restore_database "${PG_DATABASE}" "${CUTOVER_BACKUP}"' in SCRIPT
            and 'recreate_hub "${PREVIOUS_IMAGE}"' in SCRIPT
        ),
        "Runner is not replaced": 'docker stop "${RUNNER' not in SCRIPT,
        "Hub secrets avoid process argv": (
            'args += ["--env-file", env_file]' in SCRIPT
            and 'args += ["-e", value]' not in SCRIPT
        ),
        "temporary Hub env is always removed":
            'rm -f "${INSPECT_FILE}" "${HUB_ENV_FILE}"' in SCRIPT,
        "secrets are not copied into logs": "DATABASE_URL=" not in "\n".join(
            line for line in SCRIPT.splitlines() if "echo " in line or "log " in line
        ),
    }
    failed = [name for name, passed in checks.items() if not passed]
    for name, passed in checks.items():
        print(("PASS " if passed else "FAIL ") + name)
    if failed:
        raise SystemExit(f"{len(failed)} self-deploy safety checks failed")
    print(f"soduwork self deploy: {len(checks)} assertions green")


if __name__ == "__main__":
    main()
