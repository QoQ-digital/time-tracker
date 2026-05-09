#!/usr/bin/env bash
# Restores the postgres database from a gzipped pg_dump file.
# WARNING: this DROPS existing data in the public schema before restoring.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${1:-}" ]]; then
    echo "Usage: $0 <path/to/backup.sql.gz>" >&2
    exit 1
fi

BACKUP_FILE="$1"
if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "ERROR: backup file not found: $BACKUP_FILE" >&2
    exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

read -r -p "This will DROP and recreate the public schema in '$POSTGRES_DB'. Continue? [y/N] " confirm
if [[ "${confirm,,}" != "y" ]]; then
    echo "Aborted."
    exit 0
fi

docker compose exec -T postgres psql \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

gunzip -c "$BACKUP_FILE" \
    | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo "Restore complete from $BACKUP_FILE"
