#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null || { echo 'Docker is required for the disposable MySQL 8.4 test.' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required for the API health check.' >&2; exit 1; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
project="sbaa-pilot-$(node -p "require('node:crypto').randomBytes(6).toString('hex')")"
scratch="$(mktemp -d)"
server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  docker compose -p "$project" -f "$script_dir/mysql84.compose.yml" down --volumes >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT

if lsof -nP -iTCP:15050 -sTCP:LISTEN >/dev/null 2>&1; then
  echo 'Port 15050 is already occupied; refusing to test against an unknown server.' >&2
  exit 1
fi

# These values override any local .env; the container contains synthetic data only.
export NODE_ENV=test DB_HOST=127.0.0.1 DB_PORT=13384 DB_NAME=sbaa_pilot_test
export DB_USER=sbaa_pilot_runner DB_PASSWORD=synthetic-local-runner-only
export SBAA_PILOT_TEST=true PORT=15050 TEST_API_URL=http://127.0.0.1:15050/api
export DEV_SEED_PASSWORD=synthetic-local-seed-only TEST_SEED_PASSWORD=synthetic-local-seed-only
export TEST_PASSWORD=synthetic-local-seed-only TEST_ADMIN_PASSWORD=synthetic-local-seed-only
export TEST_ADMIN_EMAIL=admin@schoolportal.test
export MAIL_MODE=development SESSION_TRANSPORT=bearer PRIVATE_STORAGE_MODE=filesystem
export RUN_REMINDER_SCHEDULER=false
export CLIENT_URL=http://localhost:5173 APP_PUBLIC_URL=http://localhost:5173
export UPLOAD_DIR="$scratch/uploads"
export DEV_MAIL_LOG_PATH="$scratch/dev-mail.log"
unset DB_SSL_CA SBAA_PILOT_ALLOW_REMOTE
mkdir -p "$UPLOAD_DIR"

docker compose -p "$project" -f "$script_dir/mysql84.compose.yml" up -d --wait
cd "$repo_dir"
node server/database/pilot-schema.js
node server/database/migrate.js
node server/database/seed.js
node server/app.js >"$scratch/server.log" 2>&1 &
server_pid=$!
for _ in {1..30}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then echo 'Pilot API exited; see its temporary log.' >&2; exit 1; fi
  if curl --silent --fail http://127.0.0.1:15050/api/health >/dev/null; then break; fi
  sleep 1
done
curl --silent --fail http://127.0.0.1:15050/api/health >/dev/null
npm run test:integration --prefix server
npm run test:extended --prefix server
echo 'Disposable MySQL 8.4 pilot test passed. Container and API will be stopped.'
