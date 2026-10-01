#!/usr/bin/env bash
# Dry-run checks for scripts/backup-dde-vault.sh.
# Runs the script with a dummy DATABASE_URL and a passphrase that exists
# only in this test process. Does not call pg_dump, openssl, or the AWS CLI,
# and does not open a network connection.

set -euo pipefail
umask 077

if [[ "${BACKUP_TEST_NETNS:-}" != 1 ]]; then
  if ! command -v unshare >/dev/null 2>&1; then
    echo "error: unshare is required so this test cannot open a network connection" >&2
    exit 1
  fi
  self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  exec unshare --net --map-root-user env BACKUP_TEST_NETNS=1 /usr/bin/bash "$self"
fi

if [[ ! -r /proc/net/dev || ! -r /proc/net/route ]]; then
  echo "error: cannot confirm this test has no network" >&2
  exit 1
fi
other_ifaces="$(awk 'NR>2 { iface=$1; sub(/:$/, "", iface); if (iface != "lo") print iface }' /proc/net/dev)"
if [[ -n "$other_ifaces" ]]; then
  echo "error: test process has a network interface: ${other_ifaces}" >&2
  exit 1
fi
routes="$(awk 'NR>1 { print }' /proc/net/route)"
if [[ -n "$routes" ]]; then
  echo "error: test process has an IPv4 route" >&2
  exit 1
fi
if [[ -r /proc/net/ipv6_route ]]; then
  bad_v6="$(awk '{ if ($NF != "lo") print $NF }' /proc/net/ipv6_route)"
  if [[ -n "$bad_v6" ]]; then
    echo "error: test process has a non-loopback IPv6 route" >&2
    exit 1
  fi
fi

here="$(cd "$(dirname "$0")" && pwd)"
script="${here}/../../scripts/backup-dde-vault.sh"
if [[ ! -f "$script" ]]; then
  echo "error: backup script not found at ${script}" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/dde-vault-backup-test.XXXXXXXX")"
marker="${work}/forbidden"
: >"$marker"
cleanup() {
  rm -rf -- "$work"
}
trap cleanup EXIT

for cmd in pg_dump openssl aws; do
  cat >"${work}/${cmd}" <<EOF
#!/bin/sh
printf '%s\n' '${cmd}' >> '${marker}'
exit 97
EOF
  chmod 755 "${work}/${cmd}"
done

safe_path="${work}:/usr/bin:/bin"
export PATH="$safe_path"

for cmd in pg_dump openssl aws; do
  found="$(command -v "$cmd")"
  if [[ "$found" != "${work}/${cmd}" ]]; then
    echo "error: ${cmd} is not the local decoy (${found})" >&2
    exit 1
  fi
done

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_not_forbidden() {
  if [[ -s "$marker" ]]; then
    echo "FAIL: forbidden command invoked:" >&2
    cat "$marker" >&2
    exit 1
  fi
}

run_dry() {
  local outfile="$1"
  local errfile="$2"
  shift 2
  set +e
  env -i PATH="$safe_path" HOME=/tmp "$@" /usr/bin/bash "$script" --dry-run >"$outfile" 2>"$errfile"
  RC=$?
  set -e
}

out="${work}/out"
err="${work}/err"
passphrase="local-dry-run-only"

run_dry "$out" "$err" \
  DATABASE_URL="postgresql://example.invalid/dde" \
  BACKUP_PASSPHRASE="$passphrase"
if [[ "$RC" -ne 0 ]]; then
  cat "$out" >&2 || true
  cat "$err" >&2 || true
  fail "dry-run exited ${RC}, expected 0"
fi
grep -F -q "s3://velocity-command-backups/vault-backups/" "$out" \
  || fail "plan missing s3://velocity-command-backups/vault-backups/"
grep -F -q "region: us-east-1" "$out" \
  || fail "plan missing region us-east-1"
grep -F -q "sse: AES256" "$out" \
  || fail "plan missing SSE AES256"
grep -F -q "openssl enc -aes-256-cbc -pbkdf2 -salt" "$out" \
  || fail "plan missing aes-256-cbc"
grep -F -q "openssl dgst -sha256 -hmac" "$out" \
  || fail "plan missing HMAC-SHA256"
if grep -F -q "aes-256-gcm" "$out" "$err"; then
  fail "plan still names aes-256-gcm"
fi
if grep -F -q "$passphrase" "$out" "$err"; then
  fail "dry-run printed BACKUP_PASSPHRASE"
fi
assert_not_forbidden
echo "ok dry-run plan"

run_dry "$out" "$err" \
  BACKUP_PASSPHRASE="$passphrase"
if [[ "$RC" -eq 0 ]]; then
  fail "dry-run exited 0 without DATABASE_URL"
fi
assert_not_forbidden
echo "ok missing DATABASE_URL"

run_dry "$out" "$err" \
  DATABASE_URL="postgresql://example.invalid/dde"
if [[ "$RC" -eq 0 ]]; then
  fail "dry-run exited 0 without BACKUP_PASSPHRASE"
fi
assert_not_forbidden
echo "ok missing BACKUP_PASSPHRASE"

run_dry "$out" "$err" \
  DATABASE_URL="postgresql://example.invalid/dde" \
  BACKUP_PASSPHRASE="$passphrase" \
  AWS_REGION="eu-west-1"
if [[ "$RC" -eq 0 ]]; then
  fail "dry-run exited 0 with AWS_REGION outside the United States"
fi
assert_not_forbidden
echo "ok non-US AWS_REGION"

echo "backup-dde-vault dry-run tests passed"
