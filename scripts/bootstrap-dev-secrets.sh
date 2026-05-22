#!/usr/bin/env bash
# Generates the DEV_* secrets for the dev stack and prints a paste-ready
# block for GitHub repo settings.
#
# Why this is separate from bootstrap-github-deploy.sh: the prod bootstrap
# also generates an SSH keypair and (optionally) authorizes it on the host.
# For dev we reuse the same SSH key — only the app/n8n/db secrets are new.
#
# Run anywhere (laptop is fine, secrets never leave this terminal):
#   bash scripts/bootstrap-dev-secrets.sh

set -euo pipefail

DEV_POSTGRES_PASSWORD=$(openssl rand -hex 24)
DEV_N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
DEV_N8N_USER_MANAGEMENT_JWT_SECRET=$(openssl rand -hex 32)
DEV_N8N_PATH_SUFFIX=$(openssl rand -hex 4)

cat <<EOF

=================================================================
PASTE INTO  GitHub repo  →  Settings  →  Secrets and variables  →
            Actions  →  New repository secret

(These are SEPARATE from the prod secrets — prefix is DEV_*)
=================================================================

Secret name                              Value
-----------                              -----
DEV_POSTGRES_PASSWORD                    $DEV_POSTGRES_PASSWORD
DEV_N8N_ENCRYPTION_KEY                   $DEV_N8N_ENCRYPTION_KEY
DEV_N8N_USER_MANAGEMENT_JWT_SECRET       $DEV_N8N_USER_MANAGEMENT_JWT_SECRET
DEV_N8N_PATH_SUFFIX                      $DEV_N8N_PATH_SUFFIX

DEV_TELEGRAM_BOT_TOKEN                   <from @BotFather for @Time_treckerDevBot>
DEV_AUTHORIZED_TELEGRAM_USER_IDS         <numeric, comma-separated>
DEV_AUTHORIZED_TELEGRAM_CHAT_IDS         <numeric, comma-separated; optional>

Reused from prod (DO NOT recreate):
  DEPLOY_SSH_KEY, DEPLOY_SSH_HOST, DEPLOY_SSH_USER, AI_API_KEY

=================================================================
After pasting, the deploy-dev.yml workflow will fire automatically
on the next push to 'develop'. To trigger it manually now:

  gh workflow run "Deploy to qoq-dev (dev stack)" --ref develop

Editor URL after first deploy:
  https://tracker-dev.qoq-dev.xyz/tetris-n8n-dev-${DEV_N8N_PATH_SUFFIX}/
=================================================================
EOF
