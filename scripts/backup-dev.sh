#!/usr/bin/env bash
# Dumps the DEV postgres database to ./backups-dev/tetris_dev_<timestamp>.sql.gz.
# Runs from /opt/time-tracker-dev on the server (set by COMPOSE_PROJECT_NAME
# in deploy-dev.yml). Separate from scripts/backup.sh so a confused operator
# can't accidentally clobber prod when reaching for the dev tooling.
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
set -a; source .env; set +a

BACKUP_DIR=${BACKUP_DIR:-./backups-dev}
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUT="$BACKUP_DIR/tetris_dev_${TIMESTAMP}.sql.gz"

docker compose -f docker-compose.dev.yml exec -T postgres pg_dump \
    -U "$POSTGRES_USER" \
    --no-owner \
    --no-privileges \
    "$POSTGRES_DB" \
    | gzip > "$OUT"

echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
