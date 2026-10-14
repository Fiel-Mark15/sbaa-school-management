# SBAA deployment runbook (Cloudflare Pages + Oracle Always Free)

Status: repository preparation only. Nothing here has been provisioned, pushed, published, or populated with real school records. This is not approval to launch a production school system. The local database and uploads remain unchanged.

## Architecture and limits

- Cloudflare Pages serves `client/dist`. Its `client/functions/api/[[path]].js` Function forwards `/api/*` over HTTPS to the Oracle reverse proxy. The browser sees a single origin, so the production `HttpOnly; Secure; SameSite=Lax` session cookie can work without third-party cookies. All Vue API calls use `/api`; the frontend bundle has no production localhost API dependency. Pages' default SPA fallback serves `index.html` for history routes when there is no top-level `404.html`.
- Oracle Ubuntu ARM64 VM runs Express, a separate class-reminder worker, MySQL, and a private persistent upload directory. MySQL listens only on loopback. Only the HTTPS reverse proxy is exposed; Express binds to `127.0.0.1` in production. The Pages proxy supplies an exact origin and a shared proxy secret; the reverse proxy rejects requests without that secret. This is defense in depth, not a substitute for network/firewall rules.
- Cloudflare Free Pages Functions share the Workers Free limit of 100,000 requests/day. At 2,000 users, that is only 50 API calls/user/day on average. Static assets do not consume Function calls. Monitor actual usage before any school launch. Oracle Always Free A1 capacity is subject to home-region availability and possible idle reclamation. The free allowance currently includes 2 OCPUs/12 GB for Always Free accounts and 200 GB total boot/block volume storage with five volume backups. These are quotas, **not** a capacity, availability, support, or permanent-₱0 guarantee for 2,000 users. Verify the console's current terms and do not select paid resources without approval.
- A stable HTTPS `API_ORIGIN` is required, such as `https://api.school.example`. A school-owned domain/subdomain or other stable, trusted certificate path must be supplied. An IP-only HTTP origin, self-signed certificate, or ephemeral tunnel URL is not production-ready. If the school does not already control a domain, strict ₱0 cannot currently be promised.

## 1. Source and private backup gate

Work from the project root. `server/.env`, uploads, SQL dumps, logs, private keys, and tokens are ignored by Git. Never run `db:seed` against a real database: it inserts fictional accounts and logs a known development password. Never upload a full local SQL dump as demo content. The `server/scripts/backup-private.js` command creates a full private SQL dump, copies private uploads, records SHA-256 checksums, and creates a separately scoped administrator-only export; it requires an absolute destination outside the repository. On this Mac a verified private backup was made before further deployment edits. Keep an additional encrypted off-machine copy under school control before relying on it for disaster recovery.

```bash
cd /path/to/sbaa_school_management
npm ci
npm ci --prefix server
npm ci --prefix client
npm run build
npm run test:proxy --prefix client
npm run test:session-cookie --prefix server
```

The existing `server/tests/*.test.js` integration scripts are destructive to their target database by design (they create, update and delete temporary records). They must run only against an isolated disposable database and test-only server; do not point them at the local school database or a deployed service. Set `TEST_SEED_PASSWORD` privately to the password of the fictional seed fixtures, and review mail mode before running. A clean build and unit checks are not substitutes for those tests.

## 2. Cloudflare Pages settings

Connect a **private** repository only after source review and explicit approval. Set project root directory `client`, build command `npm ci && npm run build`, output directory `dist`, Node.js 20 or newer. `vite.config.js` copies the shared `public/` assets (including `_routes.json`) into `dist`; `client/functions/` supplies the `/api/*` proxy. Do not create a top-level `404.html`, or the Pages SPA history fallback changes. Verify `/login` and `/reset-password` both return the Vue app on refresh.

Set these in Pages production Function environment, **not** as `VITE_` variables:

| Name | Value |
| --- | --- |
| `API_ORIGIN` | Exact Oracle HTTPS API origin, e.g. `https://api.school.example` (no path or trailing slash) |
| `PROXY_SHARED_SECRET` | New long random secret; also configure at the Oracle reverse proxy |

Only the public client URL goes in Express `CLIENT_URL` and `APP_PUBLIC_URL`; they must be exactly the production Pages origin. The login, reset, and email-verification links then open that site. Pages preview URLs will not be accepted by the production API unless separately designed and authorized. Never place DB, SMTP, CSRF, or proxy secrets in a `VITE_` variable, repository file, or Pages public asset.

## 3. Oracle VM and storage

Before provisioning, confirm the selected A1 shape, home region, boot/block size, backups, and egress remain marked Always Free in the account. A starting topology is one Ubuntu ARM64 A1 VM with 2 OCPUs and 12 GB RAM, a 50 GB boot volume, and a separately mounted 50 GB block volume for MySQL data, uploads, and private local backup staging. That leaves 100 GB of the 200 GB allowance unallocated; adjust only after measuring actual data and quota. Attach the block volume with a stable UUID mount in `/etc/fstab`, then verify it is mounted before starting MySQL or Express. Never fall back silently to the disposable application checkout. Restrict SSH to approved administrators, allow inbound 80/443 only, and do not expose 3306 or 5050.

Install supported ARM64 Node.js 20+ (check `node -v` and `uname -m`), MySQL 8+, Nginx, and a trusted ACME certificate client. Use a dedicated unprivileged `sbaa` OS user. Keep code under `/opt/sbaa` and data under `/srv/sbaa`; example permissions:

```bash
sudo install -d -o sbaa -g sbaa -m 0700 /srv/sbaa/uploads /srv/sbaa/backups
sudo install -d -o root -g root -m 0700 /etc/sbaa
```

Set MySQL `bind-address=127.0.0.1`, create a dedicated least-privilege application user restricted to `127.0.0.1`, and set a strong *MySQL* `DB_PASSWORD` independent of portal login and Gmail App Password. Keep MySQL's data directory on the mounted persistent volume if boot-volume retention is not guaranteed. Install repository dependencies with `npm ci --prefix server` from `/opt/sbaa`. Install schema only in a newly created empty `school_portal` database and then run `npm run db:migrate --prefix server` **after** a reviewed backup. `server/database/schema.sql` contains `CREATE DATABASE` and `USE school_portal`; do not run it on an existing database without review. Do not run `db:seed` in production.

Create `/etc/sbaa/server.env` as root-readable mode `0600` (fill values privately; this file is not in Git):

```dotenv
NODE_ENV=production
PORT=5050
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=school_portal
DB_USER=sbaa_app
DB_PASSWORD=<private-mysql-password>
DB_POOL_LIMIT=10
CLIENT_URL=https://<actual-pages-host>
APP_PUBLIC_URL=https://<actual-pages-host>
SESSION_TRANSPORT=cookie
CSRF_SECRET=<new-random-32-plus-character-secret>
UPLOAD_DIR=/srv/sbaa/uploads
RUN_REMINDER_SCHEDULER=false
MAIL_MODE=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=<authorized-full-gmail-address>
SMTP_PASSWORD=<private-google-app-password>
MAIL_FROM="SBAA School Portal <sender@gmail.com>"
```

The values in angle brackets are instructions, not usable values; replace `sender@gmail.com` with the same authorized address as `SMTP_USER`. Generate the CSRF and proxy secrets locally with a cryptographic random generator; never print them to logs or commit them. `DB_PASSWORD` is the MySQL password. `server/.env` on the Mac is deliberately untouched. `JWT_SECRET` is not used by the current database-backed session implementation. Do not paste a local `.env` into a cloud dashboard wholesale.

Run two systemd units as `sbaa`, both reading `/etc/sbaa/server.env`:

| Unit | Working directory | ExecStart | Restart |
| --- | --- | --- | --- |
| `sbaa-api.service` | `/opt/sbaa/server` | `/usr/bin/node /opt/sbaa/server/app.js` | `on-failure` |
| `sbaa-reminders.service` | `/opt/sbaa/server` | `/usr/bin/node /opt/sbaa/server/services/reminder-worker.js` | `on-failure` |

Use the actual `command -v node` path on the VM. Set `After=network-online.target mysql.service` and `RequiresMountsFor=/srv/sbaa`, plus `NoNewPrivileges=true`, `ProtectSystem=strict`, `ReadWritePaths=/srv/sbaa/uploads`, and a dedicated user. Set `TimeoutStopSec=30`. Only one reminder worker should run. Reminder delivery has a durable MySQL unique key per meeting, occurrence, and user, so restarts do not duplicate in-app notices; verify after an actual scheduled class. The worker is not an email service.

Configure Nginx with a valid certificate for the exact `API_ORIGIN`, proxy `/api/` to `http://127.0.0.1:5050`, preserve `Host`/`Origin`, and set `X-Forwarded-Proto https`. Reject requests whose `X-SBAA-Proxy-Secret` is not the exact Pages Function secret *before* proxying. Forward only the Pages Function's trusted `X-Forwarded-For` value, not a client-supplied chain; restrict the origin to Cloudflare traffic or use an authenticated tunnel. Keep Nginx config root-readable because it contains the proxy secret. Express trusts one reverse proxy hop in production for per-IP rate limits. Check the actual proxy chain before relying on those limits. Terminate TLS at Nginx; do not expose Express directly.

## 4. Mail, data migration, and backups

Oracle documents default outbound blocking for TCP 25 on newer tenancies, **not** a guarantee that Gmail 465 works. Test outbound TLS to `smtp.gmail.com:465` from the VM, then use a controlled non-student recipient to verify SMTP acceptance, inbox receipt, and the link flow separately. If 465 is unavailable or Gmail rejects authentication/quota, stop: use an approved HTTPS transactional-email service only after checking its current free tier and adding an adapter, or obtain a supported network/email arrangement. Do not silently switch to development logging. A Google App Password is not a portal password or MySQL password.

Do **not** restore the full local backup to public infrastructure: it contains real or unreviewed data, sessions, reset tokens, test accounts, and announcements. The private administrator-only export is a starting artifact, not an automated production migration: review administrator identity, hashed password, schema compatibility, profile photo reference, and all foreign keys before importing it to a fresh production database. Never import active `auth_sessions`, `password_reset_tokens`, `email_change_tokens`, `email_verification_tokens`, development mail logs, or `.test` accounts. Genuine school records require a separate school-authorized mapping, privacy review, identity reconciliation, validation, and rollback plan. Migrate only approved uploads and confirm every database storage-key reference resolves in `/srv/sbaa/uploads` with role-scoped retrieval.

Before every migration/deploy, take a consistent SQL+upload backup, verify checksums and a test restore on isolated infrastructure, and keep an encrypted off-VM copy under school control. Oracle's five included volume backups are supplementary snapshots, not a proven application-consistent restore or off-provider copy. For restoration, stop API/worker, restore a verified SQL dump to a *new* empty database, restore matching uploads to the mounted volume, check foreign keys and image references, then switch services to the restored database only after approval. Do not test restoration by overwriting the local or production database.

## 5. Acceptance gate (another device)

Before declaring deployment complete, verify on a separate device/network: `/api/health`, refreshed Vue history routes, administrator/faculty/student login and cross-role denial; registration and subsequent account persistence; profile edits and private photos; announcements and attachments; grades only for authorized enrollment; schedules and exports; reset and current-email verification via **received** messages; old session revocation and single-use link consumption; a scheduled reminder with restart deduplication; data and image survival after VM restart and code redeploy. Check accessible error states and load-test at the expected concurrency. Confirm legal/privacy text and school identity-verification policy with authorized staff before real student data is published.

No step above has yet verified a Cloudflare/Oracle deployment, Gmail acceptance from Oracle, recipient inbox receipt, ARM64 runtime, or recovery from a cloud backup. Those require access, a stable HTTPS origin, explicit deployment/data authorization, and resource decisions.

Current platform references: [Cloudflare Pages SPA fallback](https://developers.cloudflare.com/pages/configuration/serving-pages/), [Pages Functions routes and Free request behavior](https://developers.cloudflare.com/pages/functions/routing/), [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/), [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), and [Oracle's outbound TCP 25 restriction](https://docs.oracle.com/en-us/iaas/releasenotes/changes/f7e95770-9844-43db-916c-6ccbaf2cfe24/). Recheck limits and terms in the account before deployment.
