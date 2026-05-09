#!/usr/bin/env bash
# Pulls images and (re)starts the stack. Assumes .env is filled in.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
    echo "ERROR: .env is missing. Copy .env.example to .env and fill secrets first." >&2
    exit 1
fi

# Refuse to start with empty critical secrets.
required=(POSTGRES_PASSWORD N8N_ENCRYPTION_KEY N8N_USER_MANAGEMENT_JWT_SECRET TELEGRAM_BOT_TOKEN AI_API_KEY)
missing=()
# shellcheck disable=SC1091
set -a; source .env; set +a
for var in "${required[@]}"; do
    if [[ -z "${!var:-}" ]]; then
        missing+=("$var")
    fi
done
if (( ${#missing[@]} > 0 )); then
    echo "ERROR: these required env vars are empty in .env: ${missing[*]}" >&2
    exit 1
fi

docker compose pull
docker compose up -d
docker compose ps

echo
echo "Stack is up. Useful next commands:"
echo "  docker compose logs -f n8n        # tail n8n logs"
echo "  docker compose logs -f postgres   # tail db logs"
echo "  docker compose down               # stop everything (keeps volumes)"
