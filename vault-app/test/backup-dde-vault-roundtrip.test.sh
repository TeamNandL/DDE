#!/usr/bin/env bash
# Round-trip a tiny fake dump with openssl enc -aes-256-cbc and HMAC-SHA256.
# The passphrase exists only in this test process. Does not call pg_dump
# or the AWS CLI, does not read DATABASE_URL, and does not open a network
# connection. Plaintext and temp files are removed on failure.

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

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

here="$(cd "$(dirname "$0")" && pwd)"
script="${here}/../../scripts/backup-dde-vault.sh"
if [[ ! -f "$script" ]]; then
  fail "backup script not found at ${script}"
fi

unset DATABASE_URL || true

work="$(mktemp -d "${TMPDIR:-/tmp}/dde-vault-roundtrip.XXXXXXXX")"
marker="${work}/forbidden"
plain="${work}/fake.dump"
cipher="${work}/fake.dump.enc"
hmac_file="${work}/fake.dump.enc.hmac"
restored="${work}/fake.dump.restored"
bad_hmac="${work}/bad.hmac"
bad_plain="${work}/bad.restored"
: >"$marker"

cleanup() {
  if [[ -n "${plain:-}" && -f "${plain}" ]]; then
    rm -f -- "${plain}"
  fi
  if [[ -n "${work:-}" && -d "${work}" ]]; then
    rm -rf -- "${work}"
  fi
}
trap cleanup EXIT

for cmd in pg_dump aws; do
  cat >"${work}/${cmd}" <<EOF
#!/bin/sh
printf '%s\n' '${cmd}' >> '${marker}'
exit 97
EOF
  chmod 755 "${work}/${cmd}"
done

base_path="${PATH:-/usr/bin:/bin}"
export PATH="${work}:${base_path}"
hash -r

for cmd in pg_dump aws; do
  found="$(command -v "$cmd" || true)"
  if [[ "$found" != "${work}/${cmd}" ]]; then
    fail "${cmd} is not the local decoy (${found:-missing})"
  fi
done

openssl_bin="$(command -v openssl || true)"
if [[ -z "$openssl_bin" || "$openssl_bin" == "${work}/openssl" ]]; then
  fail "real openssl is not on PATH"
fi

# Passphrase stays in this process. It is not written to a file.
export BACKUP_PASSPHRASE="local-cbc-roundtrip-only"

# shellcheck disable=SC1090
source "$script"

printf 'DDE fake vault dump\n\0\001\002not-a-database\n' >"$plain"

if ! encrypt_dump "$plain" "$cipher"; then
  rm -f -- "$plain"
  fail "openssl enc -aes-256-cbc failed"
fi
if [[ ! -s "$cipher" ]]; then
  rm -f -- "$plain"
  fail "encryption produced an empty file"
fi
if cmp -s "$plain" "$cipher"; then
  rm -f -- "$plain"
  fail "ciphertext is identical to the fake dump"
fi

if ! write_hmac "$cipher" "$hmac_file"; then
  rm -f -- "$plain" "$cipher"
  fail "HMAC computation failed"
fi

if ! hmac_matches "$cipher" "$hmac_file"; then
  rm -f -- "$plain" "$restored"
  fail "HMAC did not verify"
fi

if ! restore_dump "$cipher" "$hmac_file" "$restored"; then
  rm -f -- "$plain" "$restored"
  fail "restore failed after a matching HMAC"
fi

if ! cmp -s "$plain" "$restored"; then
  rm -f -- "$plain" "$restored"
  fail "decrypted bytes do not match the fake dump"
fi

# A wrong HMAC must not decrypt.
printf '%s\n' '0000000000000000000000000000000000000000000000000000000000000000' >"$bad_hmac"
if restore_dump "$cipher" "$bad_hmac" "$bad_plain" 2>"${work}/bad.err"; then
  rm -f -- "$plain" "$bad_plain" "$restored"
  fail "bad HMAC was accepted"
fi
if ! grep -F -q "HMAC verification failed" "${work}/bad.err"; then
  rm -f -- "$plain" "$bad_plain" "$restored"
  fail "bad HMAC did not report a verification failure"
fi
if [[ -e "$bad_plain" ]]; then
  rm -f -- "$plain" "$bad_plain" "$restored"
  fail "plaintext exists after HMAC verification failed"
fi

if [[ -s "$marker" ]]; then
  echo "FAIL: forbidden command invoked:" >&2
  cat "$marker" >&2
  exit 1
fi

rm -f -- "$plain" "$cipher" "$hmac_file" "$restored" "$bad_hmac" "$bad_plain" "$marker"
if [[ -e "$plain" || -e "$cipher" || -e "$restored" || -e "$bad_plain" ]]; then
  fail "temp dump files are still on disk"
fi
rm -rf -- "$work"
if [[ -d "$work" ]]; then
  fail "temp directory is still on disk"
fi
trap - EXIT

echo "ok aes-256-cbc hmac roundtrip ($(openssl version))"
