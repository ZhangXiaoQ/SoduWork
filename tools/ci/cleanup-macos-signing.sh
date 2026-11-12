#!/usr/bin/env bash
set -euo pipefail

state="${SODUWORK_MAC_SIGNING_STATE:-}"
[[ -n "$state" ]] || exit 0
# An already cleaned invocation is a safe no-op.
[[ -e "$state" ]] || exit 0
[[ -d "$state" && ! -L "$state" && "$(cat "$state/owner")" == soduwork-macos-signing-v1 ]] || {
  echo 'Refusing unowned macOS signing cleanup' >&2; exit 1;
}
if [[ -f "$state/search-list" ]]; then
  previous=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] && previous+=("$line")
  done < "$state/search-list"
  # Restore before removing our keychain. Retain state if restoration fails,
  # so the original list is available for a retry and diagnostics.
  security list-keychains -d user -s ${previous[@]+"${previous[@]}"}
fi
if [[ -e "$state/signing.keychain-db" ]]; then
  security delete-keychain "$state/signing.keychain-db"
fi
rm -f "$state/certificate.p12" "$state/notary.p8" "$state/search-list" "$state/search-list.raw" "$state/owner"
rmdir "$state"
