# SBAA deployment runbook — Cloudflare Pages + Render + Aiven + Supabase Storage

Status: fictional-data pilot preparation only. The Cloudflare Pages site exists, the isolated Aiven `sbaa_pilot_test` database has been initialized with fictional accounts, a private Supabase bucket has been reported, and Render deployment is pending. The user reports that the exposed Supabase secret was revoked and replaced. Live Render startup, object writes, email delivery, and end-to-end authentication have not been verified by this runbook. Do not publish real school records until the launch gates below are resolved and approved. Keep the working local `.env`, database, and private uploads unchanged.

## Architecture and launch gates

Cloudflare Pages serves the Vue build and runs `client/functions/api/[[path]].js` for `/api/*`. The Function forwards to the Render HTTPS origin, preserving same-origin, host-only, HttpOnly/Secure/SameSite=Lax session cookies. Express requires the Function's private shared secret on application routes. A direct `GET /api/health` is allowed for Render health checks. The browser build uses `/api`, not a `VITE_API_URL` or localhost.

Render Free has an ephemeral filesystem and no persistent disk. Configure `PRIVATE_STORAGE_MODE=supabase` with the private `sbaa-private-uploads` bucket before deploying. The server checks the bucket metadata and refuses to boot if it is missing or public. The server alone reads/writes Supabase Storage; browser downloads remain authenticated SBAA API routes, with MySQL ownership/audience checks. Do not create public URLs, signed browser URLs, or a static `/uploads` route. Local development retains `PRIVATE_STORAGE_MODE=filesystem` and its existing upload directory.

Render Free also spins down when idle. Class reminders are in-app notices with MySQL deduplication, but the minute-loop worker cannot run reliably on a sleeping web service. Set `RUN_REMINDER_SCHEDULER=false` for the pilot and clearly disable the reminder promise in school-facing communications. To enable reminders later, use an approved always-on worker or scheduled job that invokes `server/services/reminder-worker.js` or a bounded one-shot variant, with one active scheduler and a real-occurrence/restart test. A visitor's open browser tab is not a scheduler.

Render Free blocks outbound SMTP ports 25, 465, and 587. Keep local Gmail `MAIL_MODE=smtp` unchanged. For Render use `MAIL_MODE=resend`, a privately configured Resend API key, and `MAIL_FROM=SBAA School Portal <sender@verified-domain>`; the school must approve and verify the sending domain. The HTTPS adapter preserves current templates and inline seal. A provider API success means acceptance, **not** inbox delivery. Controlled recipient inbox receipt and single-use link completion remain separate launch checks. Do not use development-log mode in production.

## Repository and private backup

Repository: `Fiel-Mark15/sbaa-school-management` is currently **public**. Treat every push as immediate public disclosure and automatic Cloudflare production deployment. `.gitignore` excludes `.env*` except sanitized examples, logs, uploads, backups, private keys/certificates, and SQL dumps except source schema/migrations; it does not remove data already committed in Git history. Review staged files, all reachable Git history, and built frontend assets before any push. Never commit credentials, tokens, student files, or full SQL exports. If a real secret was ever committed, rotate it even after removing the file. Preserve a verified encrypted database-plus-upload backup outside the repository. Do not run `db:seed` on production; it is a fictional local development seed.

Use an isolated, empty test database for any database-writing test. Never run the integration suite against the existing local school database or Aiven production service. `server/database/schema.sql` deliberately remains unchanged for existing installations: it creates and selects `school_portal`, so **never run it directly for pilot tests**. `server/database/pilot-schema.js` checks the exact original selector, removes only those two statements in memory, checks for further database switches/references, verifies the connected schema is empty, and applies the remaining base tables only when `SBAA_PILOT_TEST=true` and `DB_NAME=sbaa_pilot_test`. The migration and seed scripts check the connected `DATABASE()` before writing. In pilot mode they also reject global, cross-database, role, or grant-option privileges; remote hosts additionally require `SBAA_PILOT_ALLOW_REMOTE=true` and `DB_SSL_CA`. Without pilot mode, they refuse remote database writes while preserving the existing localhost workflow. These application checks supplement, **not replace**, a truly schema-scoped MySQL account. Production migrations require a separate reviewed procedure.

### Disposable MySQL 8.4 test workflow

With Docker Compose available, from the repository root run `npm ci --prefix server` and `npm run test:pilot-mysql84 --prefix server`. This workflow starts its own `mysql:8.4` container with a RAM-backed data directory, binds only `127.0.0.1:13384`, uses synthetic credentials and `sbaa_pilot_test`, verifies its scoped grants, applies the pilot base schema and migrations, seeds fictional accounts, starts a temporary API on `127.0.0.1:15050`, runs the integration suite, and stops the API/container on exit. It refuses a preoccupied API port, and Docker refuses an occupied database port; it never uses the existing MySQL port 3306, local `school_portal`, Aiven, or the developer's `.env` database settings. Synthetic uploads and development reset links are written under a fresh temporary directory, not the normal local upload/mail paths. The container and temporary data are removed after the run. Run `npm run test:pilot-guard --prefix server` first for database-free guard checks. **Verified locally:** the complete disposable MySQL 8.4 workflow passed on 2026-10-16, including schema load, migrations, fictional seed, roles, scoped data, schedule conflicts, notifications, reset expiry/concurrency, and session revocation. This is not a live Aiven or deployed-system test.

### Aiven account isolation gate

The existing `sbaa_test_runner` must **not** be used: its observed `SHOW GRANTS` includes broad `*.*` privileges, `CREATE USER`, `ROLE_ADMIN`, and `WITH GRANT OPTION`. Aiven documents that new service users receive admin-level access by default. Its API can create a connection-only user with `mysql_grants: []` when the service supports granular grants; Aiven says an unsupported service returns HTTP 400. The Free tier documentation does not establish whether this capability is enabled for this specific service. An empty `mysql_grants` array alone does not grant access to `sbaa_pilot_test`. [Aiven service-user grants](https://aiven.io/docs/products/mysql/howto/manage-service-users) · [Aiven Free tier](https://aiven.io/docs/products/mysql/concepts/mysql-free-tier).

**Observed Aiven history and current state (user-reported, not independently accessed here):** The API accepted `{"username":"sbaa_pilot_runner_v2","mysql_grants":[]}`, and the account initially had only `USAGE`. MySQL 8.4.11 reports `@@GLOBAL.partial_revokes=1`. An initial grant stored backslashes literally in `sbaa\_pilot\_test` (`schema_hex=736261615C5F70696C6F745C5F74657374`) and caused `ERROR 1044`. That incorrect grant was revoked and replaced with the literal-database grant below; the CA-validated pilot verifier passed. The isolated `sbaa_pilot_test` database was then initialized with the base schema, migrations, and three fictional accounts, and a read-only inventory passed. A separate `sbaa_pilot_runtime_v1@%` account was verified with only `USAGE` plus non-grantable `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the literal pilot database and CA-validated TLS. **Do not repeat either the correction or initialization.** Never omit `mysql_grants: []` when creating a connection-only user, and never use the broad `sbaa_test_runner` for migrations or Render. [MySQL partial-revokes behavior](https://dev.mysql.com/doc/refman/8.4/en/partial-revokes.html).

**Historical correction, already completed; do not rerun:** The following statements document how the escaped-pattern grant was removed and the exact eight migration privileges were granted to the literal pilot database. Do not grant `DROP`, `CREATE USER`, `ROLE_ADMIN`, `SHOW DATABASES`, global privileges, or `WITH GRANT OPTION`. If `partial_revokes` is ever disabled, unescaped underscores may become wildcards; the remote migration guard must reject that state, and the account should not be used until isolation is restored. [MySQL GRANT syntax](https://dev.mysql.com/doc/refman/8.4/en/grant.html).

```sql
REVOKE SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
ON `sbaa\_pilot\_test`.*
FROM 'sbaa_pilot_runner_v2'@'%';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
ON `sbaa_pilot_test`.*
TO 'sbaa_pilot_runner_v2'@'%';
```

For any future separately approved migration, use only the migration account and the read-only `npm run db:verify-aiven-pilot-user --prefix server` command first. It does not load `.env` or print credentials or rows; it checks the selected database, account, inactive role, exact eight literal schema-scoped privileges, `partial_revokes=ON`, and a nonempty TLS cipher. The migration/seed guard repeats these checks before writing. If Aiven changes the grant, adds global/system grants, changes `partial_revokes`, or the verifier fails, stop and use only the disposable local MySQL 8.4 workflow. Do not relax the guard or run Aiven integration writes. Render must use the separate DML-only `sbaa_pilot_runtime_v1` account, never the migration account.

For administrator-only migration, review identity, existing password hash, foreign keys, and approved asset references. Exclude `auth_sessions`, reset/email tokens, disposable test accounts, test announcements, and development mail events. Real student records need separate school authorization, mapping, privacy review, and rollback. Back up database and private files together; perform an isolated restore drill before launch.

## Render Free Node.js Web Service settings

| Field | Value |
| --- | --- |
| Repository | `Fiel-Mark15/sbaa-school-management` |
| Root Directory | Leave empty (repository root); `server` imports sibling `shared/` |
| Runtime / plan | Node.js / Free, pilot only |
| Build Command | `npm ci --prefix server` |
| Start Command | `npm run start --prefix server` |
| `NODE_VERSION` | `22.16.0` (pin rather than rely on a changing default) |
| Health Check Path | `/api/health` |
| Port/bind | Use Render's `PORT`; production Express binds `0.0.0.0` |

Set the following **private Render runtime variables**. Replace angle-bracket placeholders with values from the actual service dashboards; never commit them or print them to logs.

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` (also set by Render at runtime) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Exact Aiven MySQL Connection information; `DB_PASSWORD` is a MySQL password, not a portal password |
| `DB_SSL_CA` | Complete Aiven project CA PEM certificate, as a private multiline variable; `\\n` newlines are also accepted |
| `DB_POOL_LIMIT` | `10` initially; adjust only after load testing |
| `CLIENT_URL`, `APP_PUBLIC_URL` | Same exact Cloudflare production HTTPS origin, no path/trailing slash |
| `SESSION_TRANSPORT` | `cookie` |
| `CSRF_SECRET` | New cryptographically random value, at least 32 characters |
| `PROXY_SHARED_SECRET` | Different random value, at least 32 characters; same value in Cloudflare Pages Function secret |
| `MAIL_MODE` | `resend` for Render Free; `smtp` remains available locally or on SMTP-capable hosting |
| `RESEND_API_KEY` | Private key from an approved account, never a `VITE_` variable |
| `MAIL_FROM` | `SBAA School Portal <sender@verified-school-domain>`; domain/sender must be verified by the provider |
| `RUN_REMINDER_SCHEDULER` | `false` for the Free pilot |
| `PRIVATE_STORAGE_MODE` | `supabase` on Render Free (`filesystem` for local development) |
| `SUPABASE_URL` | Exact HTTPS Supabase project origin, e.g. `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Supabase `sb_secret_...` server secret key (not the legacy JWT service-role key); private Render variable only, never a `VITE_` variable or Pages secret |
| `SUPABASE_BUCKET` | `sbaa-private-uploads` |
| `UPLOAD_DIR` | Local filesystem mode only; do not set on Render Free |

Do not set a hard-coded `PORT`. Keep the Render URL out of the Vue bundle; only the Pages Function needs it. Express trusts one Render ingress proxy hop in production. The Pages Function replaces `X-Forwarded-For` with `CF-Connecting-IP`; verify the observed client IP and rate-limit keys at deployment, and do not trust arbitrary forwarded headers from direct clients. The backend compares the proxy secret in constant time; only the health-check GET/HEAD bypasses it. Keep the health response minimal and uncacheable.

### Aiven MySQL 8.4 TLS

The shared `env.db` configuration supplies mysql2's pool and migration connection with the Aiven CA, `rejectUnauthorized: true`, and identity verification. Never set `rejectUnauthorized: false`. Use the exact Aiven hostname, not an IP or unrelated CNAME. Restrict the database user to TLS connections; Aiven MySQL does not enforce TLS for all users automatically. Confirm a nonempty `Ssl_cipher` after connecting, and plan for Aiven CA rotation. Aiven Free has no VPC/private connection; use verified TLS over its public endpoint and least-privilege credentials. Verify the service's 1 GB storage and connection limits before real use.

### Supabase private storage

In Supabase Storage, create a standard bucket with the exact ID `sbaa-private-uploads` and **Public disabled**. Restrict its upload size and MIME types to the portal's accepted formats (WebP, PNG, JPEG, PDF), allowing at least 10 MB per object. Do not add anonymous or authenticated-user RLS policies for this bucket. Store the new `sb_secret_` server key only in Render's private environment; the adapter sends it in the `apikey` header, not as a bearer JWT. Do not use Supabase Auth; SBAA authentication and object-level authorization stay in Express/MySQL. At startup, Render makes a read-only bucket metadata check and fails if the bucket is public or unavailable. This is not a live upload probe: before launch, use synthetic files through the authenticated SBAA routes to verify create, read, replace, and delete, including forbidden cross-account reads. Supabase key rotation requires a Render redeploy.

Existing MySQL `storage_key` values remain unchanged. The adapter maps them to the same opaque filenames as the current disk store: `profile-<key>.webp`, `<key>.webp` for schedule images, `announcement-<key>.webp`, and `acquisition-<key>`; it rejects other paths. Supabase objects are never exposed directly to browsers.

**Existing-file migration is manual and approval-gated.** First take encrypted, independently verified backups of Aiven/MySQL and the complete local `UPLOAD_DIR`; record checksums and counts. Export a reviewed manifest of only approved DB-referenced objects (profile photos, schedule/announcement images, acquisitions), mapping each DB key to its existing filename. Do not upload real files from a development machine automatically. With school authorization, copy each file into the private bucket under its exact mapped filename, verify byte checksum and server-side authenticated retrieval, compare DB references and counts, then switch Render to Supabase mode. Keep the original backups and filesystem copy through a defined rollback window. Roll back by restoring the previous backend configuration and private file copy, or by restoring database/object snapshots to isolated targets before cutover; never overwrite the only working copy. The existing `backup:private` script covers local files only and is **not** a Supabase object backup. Schedule a separate encrypted off-provider export of Supabase objects alongside the MySQL backup before production use.

## Cloudflare Pages settings

| Field | Value |
| --- | --- |
| Repository | `Fiel-Mark15/sbaa-school-management` |
| Root Directory | `client`; sibling `shared/` and root `public/` remain available at build time |
| Framework | Vue / Vite |
| Build Command | `npm ci && npm run build` |
| Build Output Directory | `dist` |
| `NODE_VERSION` | `22.16.0` |
| Functions | `client/functions/api/[[path]].js` discovered at Pages project root, not inside `dist` |
| Function routes | Root `public/_routes.json` is copied by Vite to `dist/_routes.json`, restricting Functions to `/api/*` |
| `API_ORIGIN` | Private Function variable: exact Render HTTPS origin, e.g. `https://<service>.onrender.com`, no path/trailing slash |
| `PROXY_SHARED_SECRET` | Private Function secret, same as Render; never prefix with `VITE_` |
| `VITE_API_URL` | Leave unset for production; Vue calls same-origin `/api` |

Keep the top-level built output without a `404.html` so Pages' Vue SPA fallback handles refreshed `/login`, `/reset-password`, and verification routes. Configure both Pages and Render origins before building or sending emails; `APP_PUBLIC_URL` must be the actual public Pages address, never `localhost`. Preview Pages URLs are not automatically allowed by the production API. If a custom domain replaces the `pages.dev` domain, update both URL settings and redeploy the relevant configuration before sending links.

## Verification and restoration gates

1. On a disposable database, run `npm ci --prefix server`, `npm ci --prefix client`, `npm run build --prefix client`, `npm run test:proxy --prefix client`, `npm run test:session-cookie --prefix server`, `npm run test:deployment-security --prefix server`, `npm run test:private-storage --prefix server`, and `node server/tests/private-storage-local.test.js`. Run database integration tests only on an isolated test database.
2. Confirm Render reaches `/api/health` and Pages `/api/health` through its Function; direct Render application routes without the shared secret must return 403. Confirm HTTPS cookies, CSRF rejection, role and ownership restrictions, and real client IP rate limiting.
3. Confirm Aiven TLS and migration against a newly created **empty** authorized database, then perform reviewed data migration. Do not use the fictional seed for real accounts. Verify private object references and account records survive restart/redeploy.
4. Verify API provider acceptance, recipient inbox/spam receipt, reset and current-email verification from received links, single use, and old-session revocation as separate results. No provider acceptance alone proves delivery.
5. Verify login, registration, profile/photos, announcements/attachments, grades, schedules, and cross-role denials from a separate device. Keep reminders disabled until a reliable scheduler passes an occurrence and restart-deduplication test.
6. Store encrypted off-provider backups of the Aiven database and private object storage together. For restoration, restore to a new isolated database and private bucket, validate checksums/foreign keys/storage keys, test role-scoped retrieval, then cut over only after authorization. Never restore over the sole working copy.

Official platform limits: [Render Free](https://render.com/docs/free), [Render port binding](https://render.com/docs/web-services#port-binding), [Cloudflare Pages monorepos](https://developers.cloudflare.com/pages/configuration/monorepos/), [Cloudflare Functions](https://developers.cloudflare.com/pages/functions/get-started/), [Aiven MySQL Free](https://aiven.io/docs/products/mysql/concepts/mysql-free-tier), [Aiven TLS certificates](https://aiven.io/docs/platform/concepts/tls-ssl-certificates).
