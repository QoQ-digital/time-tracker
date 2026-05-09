#!/usr/bin/env bash
# Dumps the postgres database to ./backups/tetris_<timestamp>.sql.gz.
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
set -a; source .env; set +a

BACKUP_DIR=${BACKUP_DIR:-./backups}
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUT="$BACKUP_DIR/tetris_${TIMESTAMP}.sql.gz"

docker compose exec -T postgres pg_dump \
    -U "$POSTGRES_USER" \
    --no-owner \
    --no-privileges \
    "$POSTGRES_DB" \
    | gzip > "$OUT"

echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
