#!/usr/bin/env bash
# Restores the DEV postgres database from a gzipped pg_dump file.
# WARNING: this DROPS existing data in the public schema before restoring.
#
# Typical use: seed dev from a prod backup.
#   scp ./backups/tetris_20260522_110024.sql.gz root@qoq-dev:/opt/time-tracker-dev/backups-dev/
#   ssh root@qoq-dev 'cd /opt/time-tracker-dev && ./scripts/restore-dev.sh backups-dev/tetris_20260522_110024.sql.gz'
#
# Schema mismatch note: the prod dump includes the n8n schema, which the
# dev n8n container will have *already created* on first start. The restore
# below only resets `public`, so n8n's own tables (workflows, executions,
# credentials) stay intact and the app tables come from prod.
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

# Belt-and-suspenders: refuse to run against anything that doesn't smell
# like the dev DB. Prevents a tired hand from running restore-dev.sh inside
# /opt/time-tracker by accident.
if [[ "$POSTGRES_DB" != *"_dev" ]]; then
    echo "ERROR: POSTGRES_DB='$POSTGRES_DB' does not look like a dev DB (expected suffix _dev)." >&2
    echo "       Refusing to restore. If this is intentional, edit .env first." >&2
    exit 1
fi

read -r -p "This will DROP and recreate the public schema in '$POSTGRES_DB' (DEV). Continue? [y/N] " confirm
if [[ "${confirm,,}" != "y" ]]; then
    echo "Aborted."
    exit 0
fi

docker compose -f docker-compose.dev.yml exec -T postgres psql \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

gunzip -c "$BACKUP_FILE" \
    | docker compose -f docker-compose.dev.yml exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo "Restore complete from $BACKUP_FILE into DEV database '$POSTGRES_DB'"
