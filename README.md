# Tetris Time Tracker (PoC)

Telegram bot → n8n → AI classification → PostgreSQL → live Telegram dashboard.

This repository is the PoC scaffolding: Docker Compose stack (postgres + n8n),
SQL schema with seed data, an nginx snippet for path-based deploy on an existing
domain, and a starter n8n workflow that covers the critical end-to-end path
(message in → AI classify → save → dashboard out).

> **Status of this PoC.** The infrastructure (DB schema, docker, nginx,
> deploy/backup/restore scripts, AI classification, dashboard rendering and
> sending) is wired up end-to-end. Several bot **commands** are recognized but
> stubbed in the workflow (they currently reply "not wired up yet"). See
> [Next steps](#next-steps) for what to finalize in the n8n UI after import.

## Architecture

```
┌──────────────┐   webhook   ┌──────────────┐    SQL    ┌────────────┐
│ Telegram bot │ ──────────► │     n8n      │ ────────► │ PostgreSQL │
└──────┬───────┘             │  (workflow)  │ ◄──────── └────────────┘
       │                     │              │  HTTP
       │                     │              │ ────────► Anthropic API
       └──────────◄──────────│              │
              dashboard      └──────────────┘
```

* **Path-based deploy**: `https://qoq-dev.xyz/tetris-n8n-<suffix>/` proxied to
  `127.0.0.1:5678`. The suffix is intentionally non-guessable so the n8n
  editor isn't trivially discoverable.
* **Telegram allowlist** (`AUTHORIZED_TELEGRAM_USER_IDS` /
  `AUTHORIZED_TELEGRAM_CHAT_IDS`) is enforced at the very top of the workflow.
* **Postgres** is reachable only via the internal docker network (no published
  port). Backups go to `./backups/` via `scripts/backup.sh`.

## Repository layout

```
.
├── README.md
├── docker-compose.yml
├── .env.example
├── .gitignore
├── init.sql                        # tables + indexes + seed data
├── nginx/
│   └── tetris-time-tracker.conf    # location snippet to paste into existing server block
├── scripts/
│   ├── deploy.sh                   # pull + up -d with sanity checks
│   ├── backup.sh                   # pg_dump → ./backups/*.sql.gz
│   └── restore.sh                  # restore from a backup file
└── workflows/
    └── time-tracker-main.json      # n8n workflow (import via UI)
```

## Prerequisites

On the dev server you need:

* Docker + `docker compose` v2 (already installed on qoq-dev).
* nginx with the existing TLS-terminating server block for `qoq-dev.xyz`
  (already set up).
* Outbound HTTPS to `api.anthropic.com` and `api.telegram.org`.

You also need to create out-of-band:

1. **A Telegram bot** via [@BotFather](https://t.me/BotFather): `/newbot`,
   give it a name, store the bot token.
2. **An Anthropic API key**: <https://console.anthropic.com/settings/keys>.
3. **Your Telegram user_id** (and the chat_id where the bot will live):
   the easiest way is to message [@userinfobot](https://t.me/userinfobot)
   from your account.

## Quick deploy

```bash
# 1. clone / scp the project to the server
scp -r ./schedule/ user@qoq-dev.xyz:/opt/tetris-time-tracker
ssh user@qoq-dev.xyz
cd /opt/tetris-time-tracker

# 2. fill in secrets
cp .env.example .env
# generate strong values for:
#   POSTGRES_PASSWORD                 -> openssl rand -hex 24
#   N8N_ENCRYPTION_KEY                -> openssl rand -hex 32
#   N8N_USER_MANAGEMENT_JWT_SECRET    -> openssl rand -hex 32
# generate a fresh path suffix (and update N8N_PATH / WEBHOOK_URL /
#   N8N_EDITOR_BASE_URL accordingly):
openssl rand -hex 4

# 3. wire nginx
sudo cp nginx/tetris-time-tracker.conf /etc/nginx/snippets/   # optional
# Open the existing /etc/nginx/sites-available/qoq-dev.xyz (or wherever your
# server block lives), paste the `location /tetris-n8n-<suffix>/ { ... }`
# block from nginx/tetris-time-tracker.conf INSIDE the existing
# `server { ... }` for qoq-dev.xyz, then:
sudo nginx -t && sudo systemctl reload nginx

# 4. start the stack
./scripts/deploy.sh

# 5. verify
curl -sS -o /dev/null -w "%{http_code}\n" https://qoq-dev.xyz/tetris-n8n-<suffix>/
# expect 200 or 401 (n8n auth screen) — NOT 404.
```

## First-time n8n setup

1. Open `https://qoq-dev.xyz/tetris-n8n-<suffix>/` in a browser.
2. Create the n8n owner account (email + password). This is local to n8n.
3. **Import the workflow:**
   * Workflows → Import from File → `workflows/time-tracker-main.json`.
4. **Create credentials** (Settings → Credentials → New):
   * **Telegram API** named `Tetris Telegram Bot` — paste the bot token.
   * **Postgres** named `Tetris Postgres` with these values:
     * Host: `postgres`
     * Database: `${POSTGRES_DB}` (default `time_tracker`)
     * User: `${POSTGRES_USER}` (default `time_tracker_app`)
     * Password: from `.env`
     * Port: `5432`
     * SSL: disable
5. Open the imported workflow and verify each node shows the credential
   name rather than a red warning. Click "Save".
6. **Activate the workflow** with the toggle in the top-right.
7. n8n will register the Telegram webhook with Telegram automatically.

### Test it

Send to your bot from a chat in the allowlist:

```
0855-0955 [FRIENDS] разговор с другом
```

Expected:
* The bot writes one slot to `time_slots` (status `confirmed`).
* The bot sends a dashboard message.
* In `time_dashboard_messages`, the chat now has a stored message id.
* This message takes the **fast path**: explicit time range + `[CODE]` is
  parsed in JS and goes straight to the DB. No AI call is made.

Send another message:

```
20 мин отвечал в Telegram
```

Expected:
* No explicit `[CODE]`, so the AI classifier runs (via Anthropic).
* AI assigns the `TELEGRAM` category (or similar).
* `start_time` is the `end_time` of the previous slot.
* Old dashboard is deleted; a new one is sent.

If you don't see the dashboard, tail the n8n logs:

```bash
docker compose logs -f n8n
```

## Common operations

### Add a category

```
/category_add EXAMPLE | Example category | What this category covers
```

(Stub today — until the command is wired up, run SQL directly:)

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
INSERT INTO time_categories (code, name, description)
VALUES ('EXAMPLE', 'Example category', 'What this category covers');
SQL
```

### Set a goal

```
/goal_week JOB_SEARCH | 20
/goal_day  PROJECT_A  | 4
```

Equivalent SQL:

```sql
INSERT INTO time_goals (goal_type, date_from, date_to, category_code, goal_minutes)
VALUES (
  'weekly',
  date_trunc('week', CURRENT_DATE)::date,
  date_trunc('week', CURRENT_DATE)::date + INTERVAL '6 days',
  'JOB_SEARCH',
  20 * 60
)
ON CONFLICT (goal_type, date_from, date_to, category_code)
DO UPDATE SET goal_minutes = EXCLUDED.goal_minutes, is_active = TRUE, updated_at = NOW();
```

### Backup / restore

```bash
./scripts/backup.sh                         # writes backups/tetris_YYYYMMDD_HHMMSS.sql.gz
./scripts/restore.sh backups/tetris_*.sql.gz   # interactive confirmation
```

### Stop / fully remove

```bash
docker compose down              # stop, keep volumes (data preserved)
docker compose down -v           # stop AND delete volumes (WIPES DATA)
```

## Security notes

* `.env` is gitignored. Never commit it.
* The Postgres container does **not** publish a host port. If you ever need
  external access, bind to `127.0.0.1:5432` and access via SSH tunnel —
  do not expose `0.0.0.0:5432`.
* Bot writes are gated by the allowlist. Misconfiguring `.env` to an empty
  allowlist results in **deny by default** (every message is rejected),
  which is the safe failure mode.
* The n8n encryption key (`N8N_ENCRYPTION_KEY`) cannot be rotated without
  re-entering all credentials — store it in a password manager.
* The path-based deploy (`/tetris-n8n-<random>/`) is for "not crawled by
  bots" — it is not a real auth boundary. n8n's own login is.

## Performance / scaling notes

For a single-user PoC the dashboard query (`16 Aggregate Totals + Goals`)
scans `time_slots` for today and the current week each time. With ~20 slots
per day this is microseconds.

If usage scales, switch to incremental updates against `time_category_totals`
(table is already in `init.sql`). Triggers on `time_slots` insert/update can
maintain it; alternatively, the workflow can do `INSERT ... ON CONFLICT DO
UPDATE` after each save.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Editor opens but `Failed to load` errors in console | Check that `N8N_PATH` matches the nginx `location` exactly (with both leading and trailing slashes). |
| `502 Bad Gateway` from nginx | `docker compose ps` — is n8n up? Does `curl -I http://127.0.0.1:5678/` return 200? |
| Telegram webhook errors `401` | The bot token in `Tetris Telegram Bot` credential doesn't match the one Telegram knows. Re-paste the token. |
| `Access denied` for every message | Empty allowlist in `.env`. Set `AUTHORIZED_TELEGRAM_USER_IDS` to your numeric user_id. |
| AI returns garbage / parse fails | Tail `n8n` logs; the `09 Process AI Response` node logs the raw AI output. |
| Dashboard doesn't update | Check `21 Upsert Dashboard Msg` succeeded; check that the bot has permission to delete its own messages in the chat. |

## Next steps

The starter workflow handles `Telegram → AI → DB → Dashboard` end-to-end and
the `/help`, `/dashboard`, `/today`, `/week` commands. The following pieces
of the spec are deliberately stubbed and need to be added in the n8n UI on
top of the imported workflow:

* `/category_add CODE | Name | Description` — INSERT into `time_categories`.
* `/goal_week CODE | hours` and `/goal_day CODE | hours` — INSERT into
  `time_goals` with `date_trunc('week', …)` / `CURRENT_DATE` bounds.
* `/delete_last` — UPDATE last `confirmed` batch + slots to `deleted`,
  re-render dashboard.
* `/edit_last <text>` — UPDATE last batch to `replaced`, then re-enter the
  AI flow with `parent_batch_id` set on the new batch.
* `/categories` — SELECT from `time_categories`, format and send.
* `/dashboard_compact` and `/dashboard_full` — UPDATE `time_user_settings`.
* **Pending clarification reply** — when a user answers `1` or `[CODE]`,
  look up the open `time_pending_clarifications` row for the chat, materialize
  the slot with the chosen category, mark the row resolved.
* **Edited Telegram messages** — find old batch by `(telegram_chat_id,
  telegram_message_id)`, mark `replaced`, re-enter AI flow.

Each is a small extension of the existing graph: clone an existing branch,
swap the SQL in the Postgres node, wire the new Switch outputKey. The
business logic for each is described in §4–§22 of the spec.

## Credentials handover (for the developer to send back)

When the PoC is up, provide the operator (Yaroslav) with:

* SSH access notes (host / user / how to ssh).
* The path suffix used in `N8N_PATH` (so the n8n editor URL is reachable).
* The n8n owner email + password (or invite link for a second user).
* The `.env` file via a secure channel (1Password, encrypted note — **not**
  pasted into chat).
* The Telegram bot token, also via secure channel.
* The Anthropic API key, also via secure channel.
* A note on the allowlist values currently in `.env`.
