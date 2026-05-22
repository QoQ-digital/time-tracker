# Dev environment

Parallel n8n + Postgres stack on the same Hetzner host as prod, isolated by
container names, docker volumes, port, DB, and nginx vhost. Prod is
untouched while you iterate on `develop`.

## Layout

| Concern           | Prod                                | Dev                                            |
| ----------------- | ----------------------------------- | ---------------------------------------------- |
| Branch            | `main`                              | `develop`                                      |
| Deploy dir        | `/opt/time-tracker`                 | `/opt/time-tracker-dev`                        |
| Compose file      | `docker-compose.yml`                | `docker-compose.dev.yml`                       |
| Compose project   | `time-tracker` (default)            | `time-tracker-dev` (env var)                   |
| Postgres DB       | `time_tracker`                      | `time_tracker_dev`                             |
| Postgres user     | `time_tracker_app`                  | `time_tracker_dev_app`                         |
| n8n container     | `tetris-n8n`                        | `tetris-n8n-dev`                               |
| Postgres container| `tetris-postgres`                   | `tetris-postgres-dev`                          |
| Docker network    | `tetris_net`                        | `tetris_net_dev`                               |
| Postgres volume   | `tetris_postgres_data`              | `tetris_postgres_data_dev`                     |
| n8n volume        | `tetris_n8n_data`                   | `tetris_n8n_data_dev`                          |
| n8n host port     | `127.0.0.1:5678`                    | `127.0.0.1:5679`                               |
| Hostname          | `tracker.qoq-dev.xyz`               | `tracker-dev.qoq-dev.xyz`                      |
| Editor URL        | `https://tracker.qoq-dev.xyz/`      | `https://tracker-dev.qoq-dev.xyz/`             |
| Telegram bot      | `@enotebot` (prod token)            | `@Time_treckerDevBot` (dev token)              |
| Deploy workflow   | `.github/workflows/deploy.yml`      | `.github/workflows/deploy-dev.yml`             |
| GH environment    | `qoq-dev`                           | `qoq-dev-dev`                                  |
| Secret prefix     | `POSTGRES_PASSWORD`, `N8N_*`, …     | `DEV_POSTGRES_PASSWORD`, `DEV_N8N_*`, …        |

`AI_API_KEY`, `DEPLOY_SSH_KEY`, `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER` are
shared between prod and dev — they don't need a `DEV_` twin.

## Bring-up checklist

1. **Telegram bot** — `@BotFather` → `/newbot` → name `Time Tracker Dev` →
   username `Time_treckerDevBot` → copy token (becomes
   `DEV_TELEGRAM_BOT_TOKEN`). Send `/setprivacy` → Disable so the bot sees
   all messages, matching prod.

2. **DNS** — Hostinger (k2kermanych account) → qoq-dev.xyz zone → add
   A-record `tracker-dev` → `188.34.205.181`, TTL 300. Verify with
   `dig +short tracker-dev.qoq-dev.xyz` once propagated (~5 min).

3. **Secrets** — run `bash scripts/bootstrap-dev-secrets.sh`, paste the
   output into `Settings → Secrets and variables → Actions`. Use the
   `qoq-dev-dev` GitHub environment (create it first, no required
   reviewers).

4. **TLS cert** — on the server, once DNS resolves. The existing nginx
   already serves an ACME challenge location from a docker volume, so
   webroot mode works with zero downtime:
   ```bash
   docker run --rm \
     -v nginx_certbot-etc:/etc/letsencrypt \
     -v nginx_certbot-var:/var/www/certbot \
     certbot/certbot certonly --webroot -w /var/www/certbot \
     -d tracker-dev.qoq-dev.xyz \
     --agree-tos --no-eff-email \
     -m yarikhaker@gmail.com --non-interactive
   ```
   Prereq: the HTTP-only server block for `tracker-dev.qoq-dev.xyz` must
   already exist in `/srv/nginx/nginx.conf` (see step 5).

5. **Nginx vhost** — `/srv/nginx/nginx.conf` is a single bind-mounted
   file; append two server blocks (one HTTP-only for ACME + redirect, one
   HTTPS for the proxy). Edit the file in place — do NOT use `sed -i` or
   any tool that creates a new inode, which would break the bind mount.
   The reference config in `nginx/tracker-dev.qoq-dev.xyz.conf` shows the
   block shape; the live config also needs `nginx_nginx_1` connected to
   `tetris_net_dev` so container DNS resolves:
   ```bash
   docker network connect tetris_net_dev nginx_nginx_1
   docker exec nginx_nginx_1 nginx -t && docker exec nginx_nginx_1 nginx -s reload
   ```

6. **First deploy** — push to `develop` (or `gh workflow run "Deploy to
   qoq-dev (dev stack)" --ref develop`). The workflow clones into
   `/opt/time-tracker-dev`, writes `.env`, and brings the stack up.

7. **Seed dev DB from prod** — once the dev stack is healthy:
   ```bash
   # On the server (avoids transferring the full prod dump — dumps only the
   # public schema so n8n's own tables stay untouched):
   docker compose -p time-tracker exec -T postgres pg_dump \
       -U time_tracker_app --no-owner --no-privileges --schema=public \
       time_tracker \
       | gzip > /opt/time-tracker-dev/backups-dev/prod_public_$(date +%Y%m%d_%H%M%S).sql.gz

   cd /opt/time-tracker-dev
   ./scripts/restore-dev.sh backups-dev/prod_public_*.sql.gz
   ```
   `restore-dev.sh` refuses to run unless `POSTGRES_DB` ends in `_dev` —
   safety net against running it inside `/opt/time-tracker`.

8. **n8n setup** — visit `https://tracker-dev.qoq-dev.xyz/setup`, create
   owner account, add credentials:
   - **Tetris Postgres**: host `postgres`, port `5432`, database
     `time_tracker_dev`, user `time_tracker_dev_app`, password from
     `DEV_POSTGRES_PASSWORD`, schema `public`.
   - **Tetris Telegram Bot**: token from `DEV_TELEGRAM_BOT_TOKEN`.

   Import workflow: **Workflows → New → Import from File** →
   `workflows/time-tracker-main.json` from the `develop` checkout. Wire
   the two credentials. Activate.

9. **Smoke test** — DM the dev bot a voice message. Expected path
   through the canvas:
   `Telegram Trigger → 00 Is Voice? (true) → V1 Get File Path →
   V2 Download Voice → V3 Whisper Transcribe → V4 Merge Text → 01 …`

## Day-to-day

- Feature work: branch off `develop` (`feature/<thing>`), PR into
  `develop`. Push to `develop` auto-deploys to dev.
- Promote to prod: PR `develop` → `main`, merge, then run the prod
  deploy workflow manually (`workflow_dispatch`).
- Dev DB is throwaway. Reseed from prod any time via `restore-dev.sh`.
- Dev backups land in `/opt/time-tracker-dev/backups-dev/` (kept on
  the host only, not pulled to laptop unless you want them).

## Teardown (if you ever want to nuke dev)

On the server:
```bash
cd /opt/time-tracker-dev
docker compose -f docker-compose.dev.yml -p time-tracker-dev down -v  # -v drops the dev volumes
cd ..
rm -rf /opt/time-tracker-dev
# Remove the two tracker-dev server blocks from /srv/nginx/nginx.conf
# manually (or restore a pre-dev backup), then reload nginx:
docker exec nginx_nginx_1 nginx -t && docker exec nginx_nginx_1 nginx -s reload
docker network disconnect tetris_net_dev nginx_nginx_1 2>/dev/null || true
```
Prod (`/opt/time-tracker`) is unaffected because every name above is
distinct.
