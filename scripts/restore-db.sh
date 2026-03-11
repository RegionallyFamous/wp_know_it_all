#!/usr/bin/env bash
set -euo pipefail

BACKUP_PATH="${1:-}"
DB_PATH="${2:-${RAILWAY_VOLUME_MOUNT_PATH:-./data}/wordpress.db}"

if [[ -z "${BACKUP_PATH}" ]]; then
  echo "Usage: scripts/restore-db.sh <backup-file> [target-db-path]" >&2
  exit 1
fi

if [[ ! -f "${BACKUP_PATH}" ]]; then
  echo "Backup file not found: ${BACKUP_PATH}" >&2
  exit 1
fi

mkdir -p "$(dirname "${DB_PATH}")"
cp "${BACKUP_PATH}" "${DB_PATH}"

echo "Database restored to: ${DB_PATH}"
