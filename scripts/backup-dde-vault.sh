#!/usr/bin/env bash
# Operator-run encrypted backup of the DDE Postgres vault.
# Not a schedule. Nothing in this file is a GitHub Action or a cron entry.
#
# Required env (never hardcode these, never commit them):
#   DATABASE_URL        Postgres URL for pg_dump
#   BACKUP_PASSPHRASE   passphrase for openssl enc -aes-256-gcm
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
# velocity-command-backups already has all public access blocked and ACLs
# disabled. This script only uploads one object with SSE-S3
# (aws s3 cp --sse AES256). It does not change the bucket, its policy,
# its public-access block, or its ACLs.
#
# Decrypt a backup locally (no network):
#   openssl enc -d -aes-256-gcm -pbkdf2 -pass env:BACKUP_PASSPHRASE \
#     -in FILE.dump.enc -out FILE.dump
#
# Do not schedule this until a non-production run has passed.

set -euo pipefail
umask 077

default_bucket="velocity-command-backups"
default_region="us-east-1"
default_prefix="vault-backups"

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: backup-dde-vault.sh [--dry-run]

Dump the DDE Postgres vault, encrypt the dump with AES-256-GCM, delete the
plaintext, and upload the ciphertext to s3://${default_bucket}/${default_prefix}/
with SSE-S3.

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

dry_run=0
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

bucket="${BACKUP_S3_BUCKET:-$default_bucket}"
if [[ -z "$bucket" ]]; then
  bucket="$default_bucket"
fi
require_single_line BACKUP_S3_BUCKET "$bucket"
if [[ "$bucket" == */* || "$bucket" == *[[:space:]]* || "$bucket" == s3:* ]]; then
  die "BACKUP_S3_BUCKET must be a bucket name, not an s3 URI"
fi

region="${AWS_REGION:-$default_region}"
if [[ -z "$region" ]]; then
  region="$default_region"
fi
case "$region" in
  us-east-1|us-east-2|us-west-1|us-west-2) ;;
  *)
    die "AWS_REGION must be a United States region: us-east-1, us-east-2, us-west-1, or us-west-2"
    ;;
esac

prefix="${BACKUP_S3_PREFIX:-$default_prefix}"
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

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
object="dde-vault-${stamp}.dump.enc"
dest="s3://${bucket}/${prefix}/${object}"

# Resolved target only. No database connection and no AWS call on this path.
if [[ "$dry_run" -eq 1 ]]; then
  cat <<EOF
dry-run: no connection to Postgres or S3
pg_dump: custom format from DATABASE_URL
encrypt: openssl enc -aes-256-gcm -pbkdf2 (passphrase from BACKUP_PASSPHRASE)
plaintext: deleted after encryption, including when encryption or upload fails
upload: ${dest}
region: ${region}
sse: AES256 (SSE-S3)
bucket public access: blocked
bucket ACLs: disabled
bucket changes: none (no policy, public-access block, or ACL calls)
EOF
  exit 0
fi

for cmd in pg_dump openssl aws date mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || die "${cmd} is required but not on PATH"
done

# Keep the AWS CLI on the region we already accepted. Do not read a profile
# region, and do not call any API except the single object upload below.
export AWS_REGION="$region"
export AWS_DEFAULT_REGION="$region"
export AWS_PAGER=""

base="${TMPDIR:-/tmp}"
base="${base%/}"
workdir="$(mktemp -d "${base}/dde-vault-backup.XXXXXXXX")"
plaintext="${workdir}/dde-vault.dump"
ciphertext="${workdir}/dde-vault.dump.enc"

cleanup() {
  if [[ -n "${plaintext:-}" && -f "${plaintext}" ]]; then
    rm -f -- "${plaintext}"
  fi
  if [[ -n "${workdir:-}" && -d "${workdir}" && "${workdir}" != "/" && "${workdir}" != "${base}" ]]; then
    case "${workdir}" in
      "${base}/dde-vault-backup."*)
        rm -rf -- "${workdir}"
        ;;
    esac
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# Local cipher check before pg_dump so a missing AES-256-GCM enc mode never
# leaves a database dump on disk. This does not open a socket.
probe_err="${workdir}/probe.err"
if ! printf 'x' | openssl enc -aes-256-gcm -pbkdf2 -salt \
    -pass env:BACKUP_PASSPHRASE \
    -out "${workdir}/probe.enc" 2>"$probe_err"; then
  if [[ -f "$probe_err" ]] && ! grep -F -q -e "$BACKUP_PASSPHRASE" "$probe_err"; then
    cat "$probe_err" >&2
  fi
  die "openssl enc -aes-256-gcm failed before any database call"
fi
rm -f -- "${workdir}/probe.enc" "$probe_err"

pg_dump \
  --format=custom \
  --no-password \
  --file="$plaintext" \
  --dbname="$DATABASE_URL"

if [[ ! -s "$plaintext" ]]; then
  die "pg_dump wrote an empty file"
fi

if ! openssl enc -aes-256-gcm -pbkdf2 -salt \
    -pass env:BACKUP_PASSPHRASE \
    -in "$plaintext" \
    -out "$ciphertext"; then
  die "encryption failed"
fi

if [[ ! -s "$ciphertext" ]]; then
  die "encryption produced an empty file"
fi

rm -f -- "$plaintext"
if [[ -e "$plaintext" ]]; then
  die "failed to delete the plaintext dump"
fi

# Only network call to AWS: upload the ciphertext. SSE-S3. No ACL, no
# bucket policy, no public-access block, no KMS key. The AWS CLI child
# does not receive the database URL or the passphrase.
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

echo "uploaded ${dest}"
