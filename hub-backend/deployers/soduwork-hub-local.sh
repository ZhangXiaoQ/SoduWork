#!/bin/sh
set -eu

# Transactional SoduWork Hub deployment for the already-authorized trial Runner.
# The Runner keeps running while only the Hub is replaced. PostgreSQL is backed
# up and rehearsed before cutover; a failed migration or health check restores
# both the database and the previous immutable Hub image.

ACTION="${1:-}"
COMMIT="${2:-}"
HUB_NAME="${SODUWORK_HUB_CONTAINER:-soduwork-hub-1}"
PG_NAME="${SODUWORK_PG_CONTAINER:-soduwork-pg-1}"
HEALTH_URL="${SODUWORK_HEALTH_URL:-}"
EXPECTED_ACTION="${SODUWORK_DEPLOY_ACTION:-production}"
STATE_ROOT="${SODUWORK_DEPLOY_STATE_ROOT:-/deployer-state/soduwork}"
DOCKERFILE="${SODUWORK_DOCKERFILE:-Dockerfile.server}"
IMAGE="soduwork-hub:deploy-${COMMIT}"

[ "${ACTION}" = "${EXPECTED_ACTION}" ] || {
  echo "unexpected deployment action" >&2
  exit 2
}
[ -n "${HEALTH_URL}" ] || {
  echo "SODUWORK_HEALTH_URL is required" >&2
  exit 2
}
echo "${COMMIT}" | grep -Eq '^[0-9a-f]{40}$' || {
  echo "release commit must be a full lowercase SHA-1" >&2
  exit 2
}
[ "$(git rev-parse HEAD)" = "${COMMIT}" ] || {
  echo "release workspace is not the approved commit" >&2
  exit 1
}
[ -f "${DOCKERFILE}" ] || {
  echo "release Dockerfile is missing" >&2
  exit 1
}

STAMP="$(date -u +%Y%m%d-%H%M%S)"
RELEASE_DIR="${STATE_ROOT}/releases/${COMMIT}-${STAMP}"
mkdir -p "${RELEASE_DIR}"
chmod 700 "${STATE_ROOT}" "${STATE_ROOT}/releases" "${RELEASE_DIR}" 2>/dev/null || true
INSPECT_FILE="${RELEASE_DIR}/hub-inspect.json"
HUB_ENV_FILE="${RELEASE_DIR}/hub.env"
PREFLIGHT_BACKUP="${RELEASE_DIR}/preflight.dump"
CUTOVER_BACKUP="${RELEASE_DIR}/cutover.dump"
PROBE_DB="soduwork_probe_${COMMIT}_${$}"
PROBE_DB="$(printf '%s' "${PROBE_DB}" | cut -c1-62)"
PROBE_CREATED=0
ROLLBACK_ARMED=0
PREVIOUS_IMAGE=""
PREVIOUS_COMMIT=""
PREVIOUS_DEPLOYED_AT=""

log() {
  printf '[soduwork-hub] %s\n' "$*"
}

container_env() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1"
}

PG_USER="$(container_env "${PG_NAME}" | sed -n 's/^POSTGRES_USER=//p' | sed -n '1p')"
PG_DATABASE="$(container_env "${PG_NAME}" | sed -n 's/^POSTGRES_DB=//p' | sed -n '1p')"
DATABASE_URL="$(container_env "${HUB_NAME}" | sed -n 's/^DATABASE_URL=//p' | sed -n '1p')"
NETWORK="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
  "${PG_NAME}" | sed -n '1p')"

echo "${PG_USER}" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$' || {
  echo "unsafe PostgreSQL user" >&2
  exit 1
}
echo "${PG_DATABASE}" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$' || {
  echo "unsafe PostgreSQL database" >&2
  exit 1
}
[ -n "${DATABASE_URL}" ] && [ -n "${NETWORK}" ] || {
  echo "could not inspect the active SoduWork stack" >&2
  exit 1
}

database_url_for() {
  python - "$DATABASE_URL" "$1" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
source, database = sys.argv[1], sys.argv[2]
parts = urlsplit(source)
print(urlunsplit((parts.scheme, parts.netloc, "/" + database, parts.query, parts.fragment)))
PY
}

drop_database() {
  docker exec "${PG_NAME}" psql -v ON_ERROR_STOP=1 -U "${PG_USER}" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)" >/dev/null
}

create_database() {
  drop_database "$1"
  docker exec "${PG_NAME}" psql -v ON_ERROR_STOP=1 -U "${PG_USER}" -d postgres \
    -c "CREATE DATABASE \"$1\" OWNER \"${PG_USER}\"" >/dev/null
}

backup_database() {
  target="$1"
  docker exec "${PG_NAME}" pg_dump -U "${PG_USER}" -d "${PG_DATABASE}" \
    --format=custom --no-owner --no-privileges > "${target}"
  docker exec -i "${PG_NAME}" pg_restore --list < "${target}" > "${target}.list"
  [ -s "${target}" ] && [ -s "${target}.list" ] || {
    echo "database backup verification failed" >&2
    exit 1
  }
  sha256sum "${target}" > "${target}.sha256"
}

restore_database() {
  target_db="$1"
  backup="$2"
  create_database "${target_db}"
  docker exec -i "${PG_NAME}" pg_restore -U "${PG_USER}" -d "${target_db}" \
    --no-owner --no-privileges < "${backup}"
}

run_migration() {
  target_db="$1"
  mode="$2"
  docker run --rm --network "${NETWORK}" \
    -e "DATABASE_URL=$(database_url_for "${target_db}")" \
    -e "DB_MIGRATION_MODE=${mode}" \
    "${IMAGE}" python db_admin.py migrate
}

recreate_hub() {
  image="$1"
  commit="$2"
  deployed_at="$3"
  python - "${INSPECT_FILE}" "${HUB_ENV_FILE}" "${image}" "${commit}" "${deployed_at}" <<'PY'
import json
import os
import subprocess
import sys

inspect_file, env_file, image, commit, deployed_at = sys.argv[1:]
spec = json.load(open(inspect_file, encoding="utf-8"))[0]
cfg, host = spec["Config"], spec["HostConfig"]
name = spec["Name"].lstrip("/")
args = ["docker", "run", "-d", "--name", name,
        "--restart", host.get("RestartPolicy", {}).get("Name") or "unless-stopped"]
for dns in host.get("Dns") or []:
    args += ["--dns", dns]
networks = list((spec.get("NetworkSettings", {}).get("Networks") or {}).keys())
if networks:
    args += ["--network", networks[0]]
for port, bindings in (host.get("PortBindings") or {}).items():
    for binding in bindings or []:
        host_port, host_ip = binding.get("HostPort", ""), binding.get("HostIp", "")
        args += ["-p", (host_ip + ":" if host_ip else "") + host_port + ":" + port.split("/")[0]]
for mount in spec.get("Mounts") or []:
    if mount.get("Type") == "bind":
        value = mount["Source"] + ":" + mount["Destination"]
        args += ["-v", value + (":ro" if not mount.get("RW", True) else "")]
    elif mount.get("Type") == "volume":
        args += ["-v", mount["Name"] + ":" + mount["Destination"]]
seen_commit = seen_at = False
env_values = []
for value in cfg.get("Env") or []:
    if value.startswith("SODUWORK_DEPLOY_COMMIT="):
        value, seen_commit = "SODUWORK_DEPLOY_COMMIT=" + commit, True
    elif value.startswith("SODUWORK_DEPLOY_AT="):
        value, seen_at = "SODUWORK_DEPLOY_AT=" + deployed_at, True
    if value.startswith("PATH="):
        continue
    if "\n" in value or "\r" in value:
        raise SystemExit("Hub environment contains an unsupported newline")
    env_values.append(value)
if not seen_commit:
    env_values.append("SODUWORK_DEPLOY_COMMIT=" + commit)
if not seen_at:
    env_values.append("SODUWORK_DEPLOY_AT=" + deployed_at)
with open(env_file, "w", encoding="utf-8", newline="\n") as stream:
    stream.write("\n".join(env_values) + "\n")
os.chmod(env_file, 0o600)
args += ["--env-file", env_file]
args.append(image)
subprocess.run(["docker", "rm", "-f", name], check=False,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
finally:
    try:
        os.unlink(env_file)
    except FileNotFoundError:
        pass
PY
}

wait_for_health() {
  expected="$1"
  python - "${HEALTH_URL}" "${expected}" <<'PY'
import json
import sys
import time
import urllib.request

url, expected = sys.argv[1:]
for _ in range(75):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            body = json.loads(response.read().decode("utf-8"))
        if response.status == 200 and body.get("ok") and (
                not expected or str(body.get("commit") or "") == expected):
            print("health ok commit=" + str(body.get("commit") or ""))
            raise SystemExit(0)
    except SystemExit:
        raise
    except Exception:
        pass
    time.sleep(2)
raise SystemExit("SoduWork Hub health check failed")
PY
}

cleanup() {
  result="$?"
  trap - EXIT INT TERM
  set +e
  if [ "${result}" -ne 0 ] && [ "${ROLLBACK_ARMED}" -eq 1 ]; then
    log "cutover failed; restoring database and previous Hub"
    docker rm -f "${HUB_NAME}" >/dev/null 2>&1 || true
    restore_database "${PG_DATABASE}" "${CUTOVER_BACKUP}"
    recreate_hub "${PREVIOUS_IMAGE}" "${PREVIOUS_COMMIT}" "${PREVIOUS_DEPLOYED_AT}"
    wait_for_health "${PREVIOUS_COMMIT}"
    log "rollback completed"
  fi
  if [ "${PROBE_CREATED}" -eq 1 ]; then
    drop_database "${PROBE_DB}" >/dev/null 2>&1 || true
  fi
  rm -f "${INSPECT_FILE}" "${HUB_ENV_FILE}"
  exit "${result}"
}
trap cleanup EXIT INT TERM

log "building immutable image for ${COMMIT}"
docker build --build-arg "SODUWORK_VERSION=${COMMIT}" -f "${DOCKERFILE}" -t "${IMAGE}" .
REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${IMAGE}")"
[ "${REVISION}" = "${COMMIT}" ] || {
  echo "image revision does not match the approved commit" >&2
  exit 1
}
docker run --rm "${IMAGE}" python db_admin.py --help >/dev/null

log "rehearsing migrations on a restored production snapshot"
backup_database "${PREFLIGHT_BACKUP}"
PROBE_CREATED=1
restore_database "${PROBE_DB}" "${PREFLIGHT_BACKUP}"
run_migration "${PROBE_DB}" auto
run_migration "${PROBE_DB}" check
drop_database "${PROBE_DB}"
PROBE_CREATED=0

docker inspect "${HUB_NAME}" > "${INSPECT_FILE}"
chmod 600 "${INSPECT_FILE}"
PREVIOUS_IMAGE="$(docker inspect --format '{{.Image}}' "${HUB_NAME}")"
PREVIOUS_COMMIT="$(container_env "${HUB_NAME}" | sed -n 's/^SODUWORK_DEPLOY_COMMIT=//p' | sed -n '1p')"
PREVIOUS_DEPLOYED_AT="$(container_env "${HUB_NAME}" | sed -n 's/^SODUWORK_DEPLOY_AT=//p' | sed -n '1p')"

log "stopping Hub and taking the cutover backup"
docker stop "${HUB_NAME}" >/dev/null
backup_database "${CUTOVER_BACKUP}"
ROLLBACK_ARMED=1
run_migration "${PG_DATABASE}" auto
run_migration "${PG_DATABASE}" check

DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
recreate_hub "${IMAGE}" "${COMMIT}" "${DEPLOYED_AT}"
wait_for_health "${COMMIT}"
docker tag "${IMAGE}" soduwork-hub
printf '%s\n' "${PREVIOUS_COMMIT}" > "${STATE_ROOT}/previous-commit"
printf '%s\n' "${COMMIT}" > "${STATE_ROOT}/current-commit"
printf '%s\n' "${PREVIOUS_IMAGE}" > "${STATE_ROOT}/previous-image"
printf '%s\n' "${DEPLOYED_AT}" > "${RELEASE_DIR}/deployed-at"
ROLLBACK_ARMED=0
log "release ${COMMIT} is healthy"
