#!/usr/bin/env bash
# One-shot helper to bootstrap GitHub Actions deploy. Run this ONCE on the
# qoq-dev server (or anywhere — the SSH key just needs to end up authorized
# on the deploy target). It:
#
#   1. Creates an ed25519 SSH keypair dedicated to the GH Actions deploy
#      (so you can revoke it later without touching your personal key).
#   2. Appends the public key to ~/.ssh/authorized_keys (only when run on
#      the deploy target — controlled by --add-authorized).
#   3. Generates the long random secrets the workflow needs.
#
# It prints every value you have to paste into GitHub. The private key is
# also stashed at /tmp/tetris_deploy_key (chmod 600); delete it once
# pasted.
#
# Usage on the deploy target (qoq-dev):
#   bash scripts/bootstrap-github-deploy.sh --add-authorized
# Usage anywhere else:
#   bash scripts/bootstrap-github-deploy.sh

set -euo pipefail

ADD_AUTHORIZED=false
for arg in "$@"; do
    case "$arg" in
        --add-authorized) ADD_AUTHORIZED=true ;;
        *) echo "Unknown arg: $arg" >&2; exit 1 ;;
    esac
done

KEY_PATH=/tmp/tetris_deploy_key

# 1. SSH keypair.
if [[ -f "$KEY_PATH" ]]; then
    echo "Reusing existing $KEY_PATH"
else
    ssh-keygen -t ed25519 -C "tetris-deploy-$(date +%Y%m%d)" -N "" -f "$KEY_PATH" >/dev/null
    echo "Generated keypair at $KEY_PATH and $KEY_PATH.pub"
fi
chmod 600 "$KEY_PATH"

# 2. Authorize the public key on the local machine (only when asked).
if $ADD_AUTHORIZED; then
    mkdir -p ~/.ssh
    chmod 700 ~/.ssh
    touch ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
    if grep -qxFf "$KEY_PATH.pub" ~/.ssh/authorized_keys 2>/dev/null; then
        echo "Public key already in ~/.ssh/authorized_keys"
    else
        cat "$KEY_PATH.pub" >> ~/.ssh/authorized_keys
        echo "Added public key to ~/.ssh/authorized_keys"
    fi
fi

# 3. Random secrets.
POSTGRES_PASSWORD=$(openssl rand -hex 24)
N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
N8N_USER_MANAGEMENT_JWT_SECRET=$(openssl rand -hex 32)
N8N_PATH_SUFFIX=$(openssl rand -hex 4)

cat <<EOF

=================================================================
PASTE INTO  GitHub repo  →  Settings  →  Secrets and variables  →
            Actions  →  New repository secret
=================================================================

Secret name                          Value
-----------                          -----
DEPLOY_SSH_KEY                       <see contents of $KEY_PATH>
DEPLOY_SSH_HOST                      <e.g. 188.34.205.181 or qoq-dev.xyz>
DEPLOY_SSH_USER                      <e.g. root>

POSTGRES_PASSWORD                    $POSTGRES_PASSWORD
N8N_ENCRYPTION_KEY                   $N8N_ENCRYPTION_KEY
N8N_USER_MANAGEMENT_JWT_SECRET       $N8N_USER_MANAGEMENT_JWT_SECRET
N8N_PATH_SUFFIX                      $N8N_PATH_SUFFIX

TELEGRAM_BOT_TOKEN                   <from @BotFather>
AI_API_KEY                           <from https://console.anthropic.com>
AUTHORIZED_TELEGRAM_USER_IDS         <numeric, comma-separated; from @userinfobot>
AUTHORIZED_TELEGRAM_CHAT_IDS         <numeric, comma-separated; optional>

=================================================================
The DEPLOY_SSH_KEY value is the FULL contents of $KEY_PATH
including the BEGIN/END lines. View it with:

   cat $KEY_PATH

After you've pasted it into GitHub, delete the file:

   shred -u $KEY_PATH $KEY_PATH.pub

The public key is already authorized on this machine
$( $ADD_AUTHORIZED && echo "(--add-authorized was set)" || echo "(re-run with --add-authorized if this IS the deploy target)" ).
=================================================================
EOF
