#!/usr/bin/env bash
set -euo pipefail

: "${SODUWORK_MAC_CERTIFICATE_B64:?SODUWORK_MAC_CERTIFICATE_B64 is required}"
: "${SODUWORK_MAC_CERTIFICATE_PASSWORD:?SODUWORK_MAC_CERTIFICATE_PASSWORD is required}"
: "${SODUWORK_MAC_KEYCHAIN_PASSWORD:?SODUWORK_MAC_KEYCHAIN_PASSWORD is required}"
: "${SODUWORK_MAC_SIGN_IDENTITY:?SODUWORK_MAC_SIGN_IDENTITY is required}"
: "${SODUWORK_MAC_NOTARY_KEY_ID:?SODUWORK_MAC_NOTARY_KEY_ID is required}"
: "${SODUWORK_MAC_NOTARY_ISSUER:?SODUWORK_MAC_NOTARY_ISSUER is required}"
: "${SODUWORK_MAC_NOTARY_PRIVATE_KEY_B64:?SODUWORK_MAC_NOTARY_PRIVATE_KEY_B64 is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required to hand signing state to job cleanup}"

# Keep the login Keychain searchable for the installed-app persistence checks.
# State is private, owned by this invocation, and retained until job cleanup.
umask 077
state=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/soduwork-macos-signing.XXXXXX")
export SODUWORK_MAC_SIGNING_STATE="$state"
printf 'soduwork-macos-signing-v1\n' > "$state/owner"
profile="${SODUWORK_MAC_NOTARY_PROFILE:-SODUWORK_NOTARY}"
keychain="$state/signing.keychain-db"
certificate="$state/certificate.p12"
notary_key="$state/notary.p8"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

cleanup_partial() {
  local status=$?
  trap - EXIT INT TERM HUP
  if ! bash "$script_dir/cleanup-macos-signing.sh"; then
    printf 'macOS signing cleanup failed; retained state: %s\n' "$state" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup_partial EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# security emits one quoted path per line. Do not eval its output: paths may
# contain spaces or shell metacharacters.
security list-keychains -d user > "$state/search-list.raw"
previous=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && continue
  [[ "$line" == \"*\" ]] || { echo 'Unrecognized Keychain search list' >&2; exit 1; }
  line="${line:1:${#line}-2}"
  previous+=("$line")
done < "$state/search-list.raw"
printf '%s\n' ${previous[@]+"${previous[@]}"} > "$state/search-list"

printf '%s' "$SODUWORK_MAC_CERTIFICATE_B64" | base64 --decode > "$certificate"
printf '%s' "$SODUWORK_MAC_NOTARY_PRIVATE_KEY_B64" | base64 --decode > "$notary_key"
security create-keychain -p "$SODUWORK_MAC_KEYCHAIN_PASSWORD" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$SODUWORK_MAC_KEYCHAIN_PASSWORD" "$keychain"
security import "$certificate" -k "$keychain" -P "$SODUWORK_MAC_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple: -s \
  -k "$SODUWORK_MAC_KEYCHAIN_PASSWORD" "$keychain"
security list-keychains -d user -s ${previous[@]+"${previous[@]}"} "$keychain"
xcrun notarytool store-credentials "$profile" --key "$notary_key" \
  --key-id "$SODUWORK_MAC_NOTARY_KEY_ID" --issuer "$SODUWORK_MAC_NOTARY_ISSUER" \
  --keychain "$keychain" --validate

# Check the write explicitly: Bash versions differ in errexit handling for a
# redirected command group, and failed handoff must keep the rollback trap active.
if ! printf '%s\n' \
  "SODUWORK_MAC_SIGNING_STATE=$state" \
  "SODUWORK_MAC_KEYCHAIN=$keychain" \
  "SODUWORK_MAC_NOTARY_KEYCHAIN=$keychain" \
  "SODUWORK_MAC_NOTARY_PROFILE=$profile" >> "$GITHUB_ENV"; then
  printf 'Unable to export macOS signing state to GITHUB_ENV\n' >&2
  exit 1
fi
# Imported material is no longer needed as plaintext files.
rm -f "$certificate" "$notary_key"
trap - EXIT INT TERM HUP
