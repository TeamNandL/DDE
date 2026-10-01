#!/usr/bin/env bash
# Operator-run encrypted backup of the DDE Postgres vault.
# Not a schedule. Nothing in this file is a GitHub Action or a cron entry.
#
# Required env (never hardcode these, never commit them):
#   DATABASE_URL        Postgres URL for pg_dump
#   BACKUP_PASSPHRASE   passphrase for openssl enc and the HMAC key
#
# Optional env (defaults are the Velocity Command target):
#   BACKUP_S3_BUCKET    default: velocity-command-backups
#   BACKUP_S3_PREFIX    default: vault-backups
#   AWS_REGION          default: us-east-1 (US East, N. Virginia)
#                       allowed: us-east-1, us-east-2, us-west-1, us-west-2
#
# A real run also needs pg_dump, openssl, the AWS CLI, and AWS credentials
# that can write only this bucket. Credentials stay in the environment.
#
# Encryption: openssl enc -aes-256-cbc -pbkdf2 -salt
# HMAC key:   openssl dgst -sha256 -hmac "$BACKUP_PASSPHRASE" over the
#             label dde-vault-backup-hmac-v1 (hex, first field of -r).
# Ciphertext HMAC: openssl dgst -sha256 -hmac "$HMAC_KEY" over the
#             ciphertext file. Stored next to it as FILE.dump.enc.hmac.
#
# Restore verifies that HMAC before decrypt:
#   openssl dgst -sha256 -hmac "$HMAC_KEY" -r FILE.dump.enc
#   must match FILE.dump.enc.hmac
#   openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE \
#     -in FILE.dump.enc -out FILE.dump
#
# velocity-command-backups already has all public access blocked and ACLs
# disabled. This script only uploads the ciphertext and its HMAC with
# SSE-S3 (aws s3 cp --sse AES256). It does not change the bucket, its
# policy, its public-access block, or its ACLs.
#
# Do not schedule this until a non-production run has passed.

set -euo pipefail
umask 077

default_bucket="velocity-command-backups"
default_region="us-east-1"
default_prefix="vault-backups"
hmac_label="dde-vault-backup-hmac-v1"

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: backup-dde-vault.sh [--dry-run]

Dump the DDE Postgres vault, encrypt the dump with AES-256-CBC, HMAC the
ciphertext, delete the plaintext, and upload both files to
s3://${default_bucket}/${default_prefix}/ with SSE-S3.

--dry-run   print the plan and exit. Does not connect to Postgres or S3.

Required environment: DATABASE_URL, BACKUP_PASSPHRASE.
Optional: BACKUP_S3_BUCKET (default ${default_bucket}),
          BACKUP_S3_PREFIX (default ${default_prefix}),
          AWS_REGION (default ${default_region}; US regions only).

The destination bucket already has all public access blocked and ACLs
disabled. This script does not change the bucket, its policy, its
public-access block, or its ACLs.

Do not schedule this until a non-production run has passed.
EOF
}

require_single_line() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    die "${name} is required"
  fi
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    die "${name} must be a single line"
  fi
}

# Hex HMAC-SHA256 key derived from BACKUP_PASSPHRASE. Not the AES key.
hmac_key_hex() {
  local hex
  hex="$(
    printf '%s' "$hmac_label" |
      openssl dgst -sha256 -hmac "$BACKUP_PASSPHRASE" -r |
      awk 'NR==1 { print $1 }'
  )"
  printf '%s' "${hex,,}"
}

encrypt_dump() {
  local plain="$1"
  local cipher="$2"
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -pass env:BACKUP_PASSPHRASE \
    -in "$plain" \
    -out "$cipher"
}

write_hmac() {
  local ciphertext="$1"
  local hmac_file="$2"
  local key actual
  key="$(hmac_key_hex)"
  [[ "$key" =~ ^[0-9a-f]{64}$ ]] || die "HMAC key derivation failed"
  actual="$(openssl dgst -sha256 -hmac "$key" -r "$ciphertext" | awk 'NR==1 { print $1 }')"
  actual="${actual,,}"
  [[ "$actual" =~ ^[0-9a-f]{64}$ ]] || die "HMAC computation failed"
  printf '%s\n' "$actual" >"$hmac_file"
}

hmac_matches() {
  local ciphertext="$1"
  local hmac_file="$2"
  local key actual expected
  [[ -s "$hmac_file" ]] || return 1
  key="$(hmac_key_hex)" || return 1
  [[ "$key" =~ ^[0-9a-f]{64}$ ]] || return 1
  actual="$(openssl dgst -sha256 -hmac "$key" -r "$ciphertext" | awk 'NR==1 { print $1 }')"
  actual="${actual,,}"
  [[ "$actual" =~ ^[0-9a-f]{64}$ ]] || return 1
  expected="$(tr -d '[:space:]' <"$hmac_file")"
  expected="${expected,,}"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  cmp -s <(printf '%s' "$actual") <(printf '%s' "$expected")
}

decrypt_dump() {
  local cipher="$1"
  local plain="$2"
  if ! openssl enc -d -aes-256-cbc -pbkdf2 \
      -pass env:BACKUP_PASSPHRASE \
      -in "$cipher" \
      -out "$plain"; then
    rm -f -- "$plain"
    return 1
  fi
}

# Verify the HMAC first. Decrypt only when it matches. On failure, remove
# any plaintext output and leave the ciphertext untouched.
restore_dump() {
  local cipher="$1"
  local hmac_file="$2"
  local plain="$3"
  if ! hmac_matches "$cipher" "$hmac_file"; then
    rm -f -- "$plain"
    echo "error: HMAC verification failed; ciphertext was not decrypted" >&2
    return 1
  fi
  if ! decrypt_dump "$cipher" "$plain"; then
    rm -f -- "$plain"
    echo "error: decryption failed" >&2
    return 1
  fi
}

backup_cleanup() {
  if [[ -n "${plaintext:-}" && -f "${plaintext}" ]]; then
    rm -f -- "${plaintext}"
  fi
  if [[ -n "${workdir:-}" && -d "${workdir}" && "${workdir}" != "/" && "${workdir}" != "${base:-}" ]]; then
    case "${workdir}" in
      "${base}/dde-vault-backup."*)
        rm -rf -- "${workdir}"
        ;;
    esac
  fi
}

main() {
  local dry_run=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        dry_run=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done

  require_single_line DATABASE_URL "${DATABASE_URL:-}"
  require_single_line BACKUP_PASSPHRASE "${BACKUP_PASSPHRASE:-}"

  case "$DATABASE_URL" in
    postgres://*|postgresql://*) ;;
    *) die "DATABASE_URL must start with postgres:// or postgresql://" ;;
  esac

  local bucket="${BACKUP_S3_BUCKET:-$default_bucket}"
  if [[ -z "$bucket" ]]; then
    bucket="$default_bucket"
  fi
  require_single_line BACKUP_S3_BUCKET "$bucket"
  if [[ "$bucket" == */* || "$bucket" == *[[:space:]]* || "$bucket" == s3:* ]]; then
    die "BACKUP_S3_BUCKET must be a bucket name, not an s3 URI"
  fi

  local region="${AWS_REGION:-$default_region}"
  if [[ -z "$region" ]]; then
    region="$default_region"
  fi
  case "$region" in
    us-east-1|us-east-2|us-west-1|us-west-2) ;;
    *)
      die "AWS_REGION must be a United States region: us-east-1, us-east-2, us-west-1, or us-west-2"
      ;;
  esac

  local prefix="${BACKUP_S3_PREFIX:-$default_prefix}"
  if [[ -z "$prefix" ]]; then
    prefix="$default_prefix"
  fi
  while [[ "$prefix" == /* ]]; do
    prefix="${prefix#/}"
  done
  while [[ "$prefix" == */ ]]; do
    prefix="${prefix%/}"
  done
  if [[ -z "$prefix" ]]; then
    prefix="$default_prefix"
  fi
  if [[ "$prefix" == *..* || "$prefix" == *$'\n'* || "$prefix" == *$'\r'* ]]; then
    die "BACKUP_S3_PREFIX is invalid"
  fi

  local stamp object dest hmac_object hmac_dest
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  object="dde-vault-${stamp}.dump.enc"
  dest="s3://${bucket}/${prefix}/${object}"
  hmac_object="${object}.hmac"
  hmac_dest="${dest}.hmac"

  # Resolved target only. No database connection and no AWS call on this path.
  if [[ "$dry_run" -eq 1 ]]; then
    cat <<EOF
dry-run: no connection to Postgres or S3
pg_dump: custom format from DATABASE_URL
encrypt: openssl enc -aes-256-cbc -pbkdf2 -salt (passphrase from BACKUP_PASSPHRASE)
hmac: openssl dgst -sha256 -hmac over the ciphertext (key derived from BACKUP_PASSPHRASE)
restore: verify HMAC before decrypt
plaintext: deleted after encryption, including when encryption, HMAC, or upload fails
upload: ${dest}
upload hmac: ${hmac_dest}
region: ${region}
sse: AES256 (SSE-S3)
bucket public access: blocked
bucket ACLs: disabled
bucket changes: none (no policy, public-access block, or ACL calls)
EOF
    exit 0
  fi

  local cmd
  for cmd in pg_dump openssl aws date mktemp awk; do
    command -v "$cmd" >/dev/null 2>&1 || die "${cmd} is required but not on PATH"
  done

  # Keep the AWS CLI on the region we already accepted. Do not read a profile
  # region, and do not call any API except the object uploads below.
  export AWS_REGION="$region"
  export AWS_DEFAULT_REGION="$region"
  export AWS_PAGER=""

  base="${TMPDIR:-/tmp}"
  base="${base%/}"
  workdir="$(mktemp -d "${base}/dde-vault-backup.XXXXXXXX")"
  plaintext="${workdir}/dde-vault.dump"
  local ciphertext="${workdir}/dde-vault.dump.enc"
  local hmac_file="${workdir}/dde-vault.dump.enc.hmac"

  trap backup_cleanup EXIT
  trap 'backup_cleanup; exit 130' INT
  trap 'backup_cleanup; exit 143' TERM

  # Local cipher and HMAC check before pg_dump. This does not open a socket.
  printf 'x' >"${workdir}/probe.in"
  if ! encrypt_dump "${workdir}/probe.in" "${workdir}/probe.enc"; then
    rm -f -- "$plaintext" "${workdir}/probe.in"
    die "openssl enc -aes-256-cbc failed before any database call"
  fi
  if ! write_hmac "${workdir}/probe.enc" "${workdir}/probe.hmac"; then
    rm -f -- "$plaintext" "${workdir}/probe.in" "${workdir}/probe.enc"
    die "HMAC failed before any database call"
  fi
  rm -f -- "${workdir}/probe.in" "${workdir}/probe.enc" "${workdir}/probe.hmac"

  if ! pg_dump \
      --format=custom \
      --no-password \
      --file="$plaintext" \
      --dbname="$DATABASE_URL"; then
    rm -f -- "$plaintext"
    die "pg_dump failed"
  fi

  if [[ ! -s "$plaintext" ]]; then
    rm -f -- "$plaintext"
    die "pg_dump wrote an empty file"
  fi

  if ! encrypt_dump "$plaintext" "$ciphertext"; then
    rm -f -- "$plaintext"
    die "encryption failed"
  fi

  if [[ ! -s "$ciphertext" ]]; then
    rm -f -- "$plaintext" "$ciphertext"
    die "encryption produced an empty file"
  fi

  if ! write_hmac "$ciphertext" "$hmac_file"; then
    rm -f -- "$plaintext" "$ciphertext"
    die "HMAC failed"
  fi

  if ! hmac_matches "$ciphertext" "$hmac_file"; then
    rm -f -- "$plaintext" "$ciphertext" "$hmac_file"
    die "HMAC verification failed before upload"
  fi

  rm -f -- "$plaintext"
  if [[ -e "$plaintext" ]]; then
    die "failed to delete the plaintext dump"
  fi

  # Uploads only. SSE-S3. No ACL, no bucket policy, no public-access block.
  # The AWS CLI children do not receive the database URL or the passphrase.
  env \
    -u DATABASE_URL \
    -u BACKUP_PASSPHRASE \
    AWS_REGION="$region" \
    AWS_DEFAULT_REGION="$region" \
    AWS_PAGER="" \
    aws s3 cp "$ciphertext" "$dest" \
    --region "$region" \
    --sse AES256 \
    --only-show-errors \
    --no-progress

  env \
    -u DATABASE_URL \
    -u BACKUP_PASSPHRASE \
    AWS_REGION="$region" \
    AWS_DEFAULT_REGION="$region" \
    AWS_PAGER="" \
    aws s3 cp "$hmac_file" "$hmac_dest" \
    --region "$region" \
    --sse AES256 \
    --only-show-errors \
    --no-progress

  echo "uploaded ${dest}"
  echo "uploaded ${hmac_dest}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
