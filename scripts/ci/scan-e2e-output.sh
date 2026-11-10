#!/usr/bin/env bash
# Fail-closed secret scan of Playwright output, run right before it is uploaded as a
# (public) workflow artifact. Offending paths are deleted so the upload stays safe.
#
#   scripts/ci/scan-e2e-output.sh --env NAME [--env NAME ...] -- PATH...
#
# Always also scans for the E2E test passwords (E2E_TEST_PASSWORD, E2E_NEW_TEST_PASSWORD) when set.
# If the scan cannot run at all, every PATH is deleted: nothing unscanned is uploaded.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"

names=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  if [ "$1" != "--env" ] || [ $# -lt 2 ]; then
    echo "::error::usage: $0 --env NAME [--env NAME ...] -- PATH..."
    exit 2
  fi
  names+=("$2")
  shift 2
done
[ "${1:-}" = "--" ] && shift
paths=("$@")

finished=0
# shellcheck disable=SC2329  # invoked by the EXIT trap
fail_closed() {
  if [ "$finished" != 1 ]; then
    echo "::error::secret scan did not complete; removing ${paths[*]} so nothing unscanned is uploaded"
    rm -rf -- "${paths[@]}"
    exit 1
  fi
}
trap fail_closed EXIT

# The passwords the E2E suite types come from the E2E_TEST_PASSWORD / E2E_NEW_TEST_PASSWORD
# secrets (e2e/utils/test-credentials.ts). Unset means the run typed random local values.
args=()
for n in E2E_TEST_PASSWORD E2E_NEW_TEST_PASSWORD; do
  if [ -n "${!n:-}" ]; then args+=(--env "$n"); fi
done
for n in ${names[@]+"${names[@]}"}; do
  [ -n "${!n:-}" ] || echo "::warning::$n is empty; not scanning for it"
  args+=(--env "$n")
done

out="$(python3 "$repo/scripts/ci/scan-artifacts-for-secrets.py" ${args[@]+"${args[@]}"} --remove "${paths[@]}")" || status=$?
printf '%s\n' "$out"
# Keep a path only if the scanner reported it clean; anything else (a crash part-way,
# an unexpected exit) is removed rather than uploaded unscanned.
for p in "${paths[@]}"; do
  if [ -e "$p" ] && ! grep -qxF "ok: $p" <<<"$out"; then
    echo "::error::$p was not reported clean; removing it"
    rm -rf -- "$p"
    status=1
  fi
done
finished=1
exit "${status:-0}"
