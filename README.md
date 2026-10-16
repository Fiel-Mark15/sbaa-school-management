# SBAA School Portal

Vue 3 + Express + MySQL portal for the School of Business Administration and Accountancy at Concepcion Holy Cross College Inc. The supplied seal remains in `public/assets/sbaa-logo.png`. This is an ongoing Software Engineering 1 project, not a finished production school system.

## Local setup

Use Node.js 20+, npm, and MySQL 8+. Keep this project outside iCloud-synced Desktop/Documents; offloaded `node_modules` can make npm appear to hang. Ensure several GB of disk space. From the project directory:

```bash
npm ci
npm ci --prefix server
npm ci --prefix client
# For a first installation only: copy server/.env.example to server/.env and set DB credentials.
# For a first installation only: mysql -u root -p < server/database/schema.sql
npm run db:migrate
npm run db:seed   # local fictional data only; requires private DEV_SEED_PASSWORD
npm run dev
```

Do not overwrite an existing `server/.env`, reset the database, or rerun the seed against real records. Migrations are additive and were designed to preserve existing rows. `npm run dev` intentionally stays open; open `http://localhost:5173`. API health is `http://localhost:5050/api/health`. To build once, run `npm run build`; it should end with `built in ...`. Restart an already-running server after backend edits if it is not using watch mode.

For a first-time fictional local seed, set a private `DEV_SEED_PASSWORD` of at least 12 characters in `server/.env` before running `db:seed`; never seed a production database. Fictional seed logins are `admin@schoolportal.test`, `faculty@schoolportal.test`, and `student@schoolportal.test`. Existing local account passwords are **not changed** by this edit. These `.test` addresses cannot receive real mail. A valid student registration is now `ACTIVE` and can sign in immediately. This does **not** verify identity or attach existing academic records: the administrator must check those separately against trusted school records. Student ID is stored as text with leading zeros. The current generic 4–40-character alphanumeric/hyphen validation is **not** a verified school ID format or identity proof; configure the registrar-approved format before deployment.

## Current modules and safety rules

- Role-specific dashboards, subject catalog/class assignments/enrollment, structured weekly meetings, rooms, and overlap checks. Students can search only their enrolled subjects and filter current or previous terms; creating an active portal account does not enroll anyone automatically.
- Immediate student account creation with optional middle name; separate identity-verification state, disable/reactivate/archive, protected deletion, profile contacts, session revocation, and last sign-in. The one-time legacy migration activates only accounts matching the old self-registration-only pending pattern and logs the eligible IDs; it leaves disabled, archived, faculty, and admin accounts alone. New accounts do not automatically inherit an existing student's grades or enrollments merely by entering the same number.
- Password checklist shared between UI and backend: at least 8 Unicode characters, at least one Unicode uppercase letter and one punctuation/symbol character, at most 1024 UTF-8 bytes, with a small local common-password denylist. No digit or lowercase requirement was added. This is the requested project policy, not a claim that eight characters is stronger than a long passphrase. New passwords use scrypt; existing bcrypt hashes still verify and are not silently rehashed/truncated. The denylist is **not** a comprehensive breached-password corpus.
- Separate 15-minute per-IP login/registration/forgot/reset/validation quotas from `AUTH_*_LIMIT`. Requests return `Retry-After`; the registration form preserves input and shows a countdown. Authenticated reads are not subject to these auth quotas. The default in-memory limiter resets when the **development** server restarts; do not use restarts as a production bypass. Production trusts one Render ingress proxy hop; verify the observed client IP and rate-limit key during deployment.
- In-app notifications with per-recipient read/archive/clear state. Announcements are shared; withdrawal hides linked inbox items consistently but preserves audit records. The bell does not mark messages read on open.
- Personal profile details now include administrator-editable names and position, phone/preferences, a private re-encoded profile photo, current verified email, and an audited visible administrator Account ID. The internal user primary key never changes. Email changes require the current password and a 30-minute single-use link to the new address; the old address remains active until confirmation, then sessions are revoked and a notice is attempted to the old address. Keep private photo files and the database backed up together.
- Grades are enrollment-linked and require an administrator to configure the school's approved scale before entry. Assigned faculty can save drafts and publish grades; students see only their own published grades. Changes to a published grade require an administrator and audit reason. No marks, weights, GPA, passing threshold, or school scale are seeded or assumed.
- Schedule-image publications supplement, never replace, structured meetings. Admins can upload, replace, publish, and archive PNG/JPEG/WebP. Images are decoded, limited to 5 MB/16 megapixels, re-encoded to WebP without source metadata, stored outside public files, and served only after role/audience checks. Current listing shows the 30 newest attachments; back up the metadata **and** private files together. Local development uses a private `UPLOAD_DIR` or the ignored `server/private-uploads/` default; the Render Free pilot requires the private Supabase bucket configured in [DEPLOYMENT.md](DEPLOYMENT.md). Never serve private files statically. Orphaned files from a crash may require an administrator's reviewed cleanup.
- Class schedules include a role-scoped `.ics` download for one term. It uses Asia/Manila weekly recurrence bounded by term dates, stable meeting IDs, and is explicitly a snapshot, not live calendar sync. Existing grade entry is structured/manual; **there is no grade-file import or grade attachment workflow yet**, so the reusable upload control is applied to actual profile-photo and schedule-image uploads only.
- Appointments include faculty recurring availability and dated exceptions, student slot requests, faculty decisions, reschedule proposals, cancellation rules, recipient-scoped notifications, and admin policy/filtered oversight. Pending requests hold slots until a decision or cancellation. A database named lock serializes booking by teacher/date; acceptance rechecks availability. Appointment notices are not email reminders. A separate class-reminder worker provides in-app schedule reminders with MySQL deduplication; it is not an appointment-email scheduler.
- Firms is an initial partner-firm **directory**, since no more specific placement/acquisition business rules were found in the current project. Admins manage, archive, audit, search, and filter records; students and faculty only see published public details. This is not an internship-application or procurement system.
- The supplied SBAA seal is used unchanged for generated favicon and touch/app icons. The portal has shared footer/legal-draft pages, compact profile layout, and Light/Dark/System appearance. Local appearance is applied before the app paints; after authentication the saved server preference takes precedence. System follows OS theme changes. Privacy and Terms pages are **unreviewed project drafts**, not official school policies.

The API rechecks account status and role for every protected request. Students see enrolled material; faculty see assigned material. Clients cannot select elevated roles. Passwords and reset tokens are not returned by account APIs; only token digests are stored. Development retains the legacy localStorage bearer session so the existing local workflow works. Production uses an HttpOnly, Secure, SameSite=Lax cookie and an origin/CSRF check; run the independent security review and deployment acceptance checks in [DEPLOYMENT.md](DEPLOYMENT.md) before real use.

## Password recovery and email

Set `APP_PUBLIC_URL` to the exact trusted browser origin. Use HTTPS in production. `http://localhost:5173` works only on the computer hosting the portal; for a phone test, use a reachable host with matching `CLIENT_URL`/CORS and a trusted test TLS setup. Never build reset links from an incoming Host header.

`MAIL_MODE=development` writes links to the private ignored `server/dev-mail.log`; **it does not send to Gmail**. For Gmail SMTP, set `MAIL_MODE=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` to the authorized sender's full address, `SMTP_PASSWORD` to its Google App Password, and `MAIL_FROM` to `SBAA School Portal <that-same-address>` **only in a private environment file**. Do not put these values in Vue, this README, chat, or Git. Do not use the MySQL `DB_PASSWORD` or portal-login password. The local `server/.env` is deliberately preserved. `.test` accounts cannot receive real mail. An administrator can open Profile → Mail diagnostics to inspect non-secret configuration and provider outcomes. A portal response, provider acceptance, and actual inbox receipt are distinct; hosted Resend delivery remains unverified.

Only `ACTIVE` accounts receive reset links; a disabled account gets the same neutral public response and stays disabled. A reset link expires in 30 minutes and is single-use. Successful reset consumes all outstanding reset links for that account, revokes sessions, and attempts a change notice. Existing links are **not** superseded merely by requesting a newer one; all are invalidated after a successful reset. Link validation is read-only; mail scanners opening the link do not consume it. Reset URL tokens are sensitive; avoid screenshots, browser sharing, access-log URLs, analytics, and referrer leakage. Browser pages set no-referrer; API responses are no-store. Configure the production static host to send no-store for the reset page too.

For a controlled, **ACTIVE** account with a deliverable email, verify provider acceptance, then personally confirm inbox/spam/quarantine receipt before completing a reset. A successful reset invalidates the token and old sessions. For disabled accounts, use User accounts → Reactivate after verifying identity. `APP_PUBLIC_URL=http://localhost:5173` produces links usable only on the Mac hosting the portal; set the exact trusted HTTPS frontend origin before remote deployment. The app uses random database-backed sessions, not JWT, so the legacy `JWT_SECRET` entry is unused. Never copy the seed portal-login password into `DB_PASSWORD`.

## Local development cleanup

The scoped cleanup script recognizes only the two known sample announcements from the October 5 screenshots. It previews exact IDs, writes an ignored private JSON backup, then archives only IDs explicitly supplied; it never truncates tables or deletes unrelated messages:

```bash
npm run cleanup:dev --prefix server
npm run cleanup:dev --prefix server -- --apply --ids=1,2
```

The second command was run for IDs 1 and 2 on this local development database, archiving two announcements and one linked notification. The backup is under `server/backups/dev-cleanup/`. Archived records and audits remain in MySQL. Do not run the cleanup against production.

## Verification

With MySQL configured and the API running on 5050 (or set `TEST_API_URL` to a separate development API):

```bash
npm run build
npm run test:integration --prefix server
npm run test:repair --prefix server
npm run test:extended --prefix server
npm run test:admin-profile --prefix server
npm run test:new-workflows --prefix server
```

The database-backed tests use fictional seeded accounts. They test legacy login, immediate registration and middle name, password policy, scrypt hashes, reset link validation/single use/session revocation, role scoping, schedule conflicts, private profile photo validation, verified email change, administrator profile persistence and Account ID uniqueness, draft/published grade privacy and audited correction, notification ownership, announcement withdrawal, concurrent appointment booking, and firm visibility. They remove temporary records; run only on a development database. The extended test temporarily configures a test grading scale if none exists and removes it afterward.

## Deployment preparation

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Cloudflare Pages + Render + Aiven preparation, private backup/migration gate, production cookie-session design, exact settings, and unresolved launch blockers. The application has **not** been deployed or load-tested for 2,000 users. Do not interpret a successful frontend build as live backend, mail, or data-persistence verification.

## Remaining scope

Transcripts, grade-file import (including preview/transaction rules), acquisitions, detailed term/program administration, a trusted enrollment/identity-verification source, faculty schedule-image publishing, a full compromised-password corpus, durable distributed rate limiting, SMTP delivery/bounce monitoring, and production security/accessibility/load review remain future work. Acquisitions has no validated purchasing/approval business rule in this repository; do not build a fake purchasing workflow. Institutional staff must approve the official privacy contact, lawful grounds, retention schedule, and policy text before publication. The present UI was checked at common mobile/desktop widths but is not certified WCAG 2.2 AA. Do not deploy for real student records until those concerns, backups, privacy policy, and infrastructure are reviewed.
