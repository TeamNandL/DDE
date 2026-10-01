#!/usr/bin/env bash
# Round-trip a tiny fake dump with openssl enc -aes-256-gcm.
# The passphrase exists only in this test process. Does not call pg_dump
# or the AWS CLI, does not read DATABASE_URL, and does not open a network
# connection. Temp files are removed before exit.
#
# openssl enc rejects AEAD ciphers, including aes-256-gcm. That check is
# present in OpenSSL 3.0.13 and 3.5.4, and the same rejection is still in
# the 3.6.5 and 4.0.3 sources. The command is the one the backup script uses.

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

work="$(mktemp -d "${TMPDIR:-/tmp}/dde-vault-gcm-test.XXXXXXXX")"
marker="${work}/forbidden"
plain="${work}/fake.dump"
cipher="${work}/fake.dump.enc"
restored="${work}/fake.dump.restored"
openssl_err="${work}/openssl.err"
: >"$marker"

cleanup() {
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
safe_path="${work}:${base_path}"
export PATH="$safe_path"
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

# Passphrase stays in this process and is handed to openssl through the
# environment. It is not written to a file.
passphrase="local-gcm-roundtrip-only"

# Tiny fake dump. Not a pg_dump, not a database.
printf 'DDE fake vault dump\n\0\001\002not-a-database\n' >"$plain"

show_openssl_err() {
  if [[ -s "$openssl_err" ]] && ! grep -F -q -e "$passphrase" "$openssl_err"; then
    cat "$openssl_err" >&2
  fi
}

# Same cipher flags as scripts/backup-dde-vault.sh.
if ! env \
    -u DATABASE_URL \
    -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN \
    -u AWS_PROFILE \
    BACKUP_PASSPHRASE="$passphrase" \
    openssl enc -aes-256-gcm -pbkdf2 -salt \
      -pass env:BACKUP_PASSPHRASE \
      -in "$plain" \
      -out "$cipher" \
      2>"$openssl_err"; then
  show_openssl_err
  if grep -F -q "AEAD ciphers not supported" "$openssl_err"; then
    fail "openssl enc does not support aes-256-gcm (AEAD ciphers not supported)"
  fi
  fail "openssl enc -aes-256-gcm failed"
fi

if [[ ! -s "$cipher" ]]; then
  fail "encryption produced an empty file"
fi
if cmp -s "$plain" "$cipher"; then
  fail "ciphertext is identical to the fake dump"
fi

if ! env \
    -u DATABASE_URL \
    -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN \
    -u AWS_PROFILE \
    BACKUP_PASSPHRASE="$passphrase" \
    openssl enc -d -aes-256-gcm -pbkdf2 \
      -pass env:BACKUP_PASSPHRASE \
      -in "$cipher" \
      -out "$restored" \
      2>"$openssl_err"; then
  show_openssl_err
  fail "openssl enc -d -aes-256-gcm failed"
fi

if ! cmp -s "$plain" "$restored"; then
  fail "decrypted bytes do not match the fake dump"
fi

if [[ -s "$marker" ]]; then
  echo "FAIL: forbidden command invoked:" >&2
  cat "$marker" >&2
  exit 1
fi

rm -f -- "$plain" "$cipher" "$restored" "$openssl_err" "$marker"
if [[ -e "$plain" || -e "$cipher" || -e "$restored" ]]; then
  fail "temp dump files are still on disk"
fi
rm -rf -- "$work"
if [[ -d "$work" ]]; then
  fail "temp directory is still on disk"
fi
trap - EXIT

echo "ok aes-256-gcm roundtrip ($(openssl version))"
