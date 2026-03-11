#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${1:-${RAILWAY_VOLUME_MOUNT_PATH:-./data}/wordpress.db}"
BACKUP_DIR="${2:-./backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_PATH="${BACKUP_DIR}/wordpress-${TIMESTAMP}.db"

mkdir -p "${BACKUP_DIR}"

if [[ ! -f "${DB_PATH}" ]]; then
  echo "Database file not found: ${DB_PATH}" >&2
  exit 1
fi

cp "${DB_PATH}" "${BACKUP_PATH}"
shasum -a 256 "${BACKUP_PATH}" > "${BACKUP_PATH}.sha256"

echo "Backup created: ${BACKUP_PATH}"
echo "Checksum: ${BACKUP_PATH}.sha256"
