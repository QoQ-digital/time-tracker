# Time Tracker (PoC)

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
       │                     │              │ ────────► OpenAI API
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
* Outbound HTTPS to `api.openai.com` and `api.telegram.org`. (To switch
  to Anthropic instead, see the comment in `.env.example` and revert
  nodes 07/08/09 of the workflow to the previous Anthropic shape.)

You also need to create out-of-band:

1. **A Telegram bot** via [@BotFather](https://t.me/BotFather): `/newbot`,
   give it a name, store the bot token.
2. **An OpenAI API key**: <https://platform.openai.com/api-keys>. The
   workflow uses `gpt-4o-mini` against `/v1/chat/completions` by default;
   you'll need a billing payment method on the OpenAI Platform account
   (ChatGPT Plus subscription is separate and does NOT grant API access).
3. **Your Telegram user_id** (and the chat_id where the bot will live):
   the easiest way is to message [@userinfobot](https://t.me/userinfobot)
   from your account.

## Deploy (GitHub Actions, recommended)

The repo ships a manual-trigger GitHub Actions workflow
([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) that does
the whole deploy from secrets — no SSH credentials live in chat or in
your shell history.

### One-time setup

**1. On the deploy target (qoq-dev), create an SSH key for GHA and
generate the random secrets:**

```bash
# As root on the server. Outputs every value you need to paste into GH.
curl -sS https://raw.githubusercontent.com/QoQ-digital/time-tracker/main/scripts/bootstrap-github-deploy.sh \
  | bash -s -- --add-authorized
```

(Or if the repo isn't on the server yet, copy
[`scripts/bootstrap-github-deploy.sh`](scripts/bootstrap-github-deploy.sh)
manually and run it with `--add-authorized`.)

**2. Paste the printed values into GitHub:**
Repo → Settings → Secrets and variables → Actions → **New repository
secret**. The required keys are:

| Secret | Source |
|---|---|
| `DEPLOY_SSH_KEY`                   | full contents of `/tmp/tetris_deploy_key` |
| `DEPLOY_SSH_HOST`                  | e.g. `188.34.205.181` or `qoq-dev.xyz` |
| `DEPLOY_SSH_USER`                  | e.g. `root` |
| `POSTGRES_PASSWORD`                | from the bootstrap script |
| `N8N_ENCRYPTION_KEY`               | from the bootstrap script |
| `N8N_USER_MANAGEMENT_JWT_SECRET`   | from the bootstrap script |
| `N8N_PATH_SUFFIX`                  | from the bootstrap script |
| `TELEGRAM_BOT_TOKEN`               | from [@BotFather](https://t.me/BotFather) |
| `AI_API_KEY`                       | from <https://platform.openai.com/api-keys> |
| `AUTHORIZED_TELEGRAM_USER_IDS`     | numeric Telegram user_id (from [@userinfobot](https://t.me/userinfobot)) |
| `AUTHORIZED_TELEGRAM_CHAT_IDS`     | optional, numeric chat_id |

After pasting `DEPLOY_SSH_KEY`, **delete the local file**:

```bash
shred -u /tmp/tetris_deploy_key /tmp/tetris_deploy_key.pub
```

**3. Trigger the workflow:**
GitHub repo → Actions → "Deploy to qoq-dev" → **Run workflow** → `main`.

The first run will:
* `git clone` this repo into `/opt/time-tracker` on the server.
* Write `.env` from the secrets.
* `docker compose up -d`.
* Print the editor URL **and the exact nginx `location` block** to
  paste into your existing qoq-dev.xyz server config.

**4. Add the printed nginx snippet** inside your existing
`server { ... }` for qoq-dev.xyz, then `sudo nginx -t && sudo systemctl
reload nginx`. This is the only step the workflow can't do safely —
your existing nginx config is shared with other apps and we don't
auto-edit it.

**5. Verify:**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://qoq-dev.xyz/tetris-n8n-<suffix>/
# expect 200 or 401 (n8n auth screen) — NOT 404.
```

### Subsequent deploys

Just trigger the workflow again. It pulls main, takes a DB backup
(unless you tick "skip backup"), and rolls forward.

## Manual deploy (fallback)

If you need to deploy without GitHub Actions (SSH outage, or initial
debugging):

```bash
# On the server.
git clone https://github.com/QoQ-digital/time-tracker.git /opt/time-tracker
cd /opt/time-tracker
cp .env.example .env
# Fill in .env by hand (generate the random secrets with `openssl rand -hex …`)
./scripts/deploy.sh
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
* No explicit `[CODE]`, so the AI classifier runs (OpenAI `gpt-4o-mini`).
* AI assigns the `TELEGRAM` category (or similar).
* `start_time` is the `end_time` of the previous slot.
* Old dashboard is deleted; a new one is sent.

If you don't see the dashboard, tail the n8n logs:

```bash
docker compose logs -f n8n
```

## Common operations

### Add or update a category

```
/category_add EXAMPLE | Example category | What this category covers
```

`CODE` must be `UPPERCASE_UNDERSCORE` and start with a letter or
underscore. The command upserts: re-running with the same code
updates the name/description and re-activates the category.

### List active categories

```
/categories
```

Replies with all categories where `is_active = TRUE`, sorted by code.

### Set a goal

```
/goal_week JOB_SEARCH | 20
/goal_day  PROJECT_A  | 4
```

Hours can be a decimal (`/goal_week SPORT | 2.5`). The week is
Monday–Sunday containing today. Re-running upserts. After the goal
is saved, the dashboard is re-rendered and sent automatically so
you immediately see the new progress bar.

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

The workflow handles `Telegram → AI → DB → Dashboard` end-to-end plus
the `/help`, `/dashboard`, `/today`, `/week`, `/categories`,
`/category_add`, `/goal_week`, `/goal_day`, `/delete_last`,
`/edit_last` commands, **edited Telegram messages** (when you edit a
previous tracked message in Telegram, the old batch is marked
`replaced` and the new text is re-saved with `parent_batch_id` set),
and **pending-clarification replies** (when the AI is unsure and asks
a question, you answer with `1`/`2`/… to pick one of the suggested
categories, or `[CODE]` to pick by code, or just send a fresh message
to drop the question and start over).

Still to be wired:

* `/dashboard_compact` and `/dashboard_full` — UPDATE `time_user_settings`.

This one is a small extension of the existing graph: a Code node that
builds safe SQL (single JSONB literal, see PR #2), a Postgres node that
runs it, a Telegram confirmation. Business logic is described in §15
of the spec.

## Credentials handover (for the developer to send back)

When the PoC is up, provide the operator (Yaroslav) with:

* SSH access notes (host / user / how to ssh).
* The path suffix used in `N8N_PATH` (so the n8n editor URL is reachable).
* The n8n owner email + password (or invite link for a second user).
* The `.env` file via a secure channel (1Password, encrypted note — **not**
  pasted into chat).
* The Telegram bot token, also via secure channel.
* The OpenAI API key, also via secure channel.
* A note on the allowlist values currently in `.env`.
