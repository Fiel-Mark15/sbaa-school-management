import assert from 'node:assert/strict';

// Deliberately synthetic settings: this test never opens a database or sends mail.
Object.assign(process.env, {
  NODE_ENV: 'production', DB_HOST: 'example.invalid', DB_PORT: '23456', DB_NAME: 'test',
  DB_USER: 'test', DB_PASSWORD: 'test-only', DB_SSL_CA: '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----',
  CLIENT_URL: 'https://school.example', APP_PUBLIC_URL: 'https://school.example',
  SESSION_TRANSPORT: 'cookie', CSRF_SECRET: 'test-csrf-secret-with-more-than-32-chars',
  PROXY_SHARED_SECRET: 'test-proxy-secret-with-more-than-32-chars', UPLOAD_DIR: '/tmp/sbaa-test-only',
  MAIL_MODE: 'resend', RESEND_API_KEY: 'test-only-api-key', MAIL_FROM: 'SBAA School Portal <sender@school.example>'
});
delete process.env.RENDER;
const { assertEnvironment, env } = await import('../config/env.js');
const { requirePagesProxy } = await import('../middleware/pages-proxy.js');
const { mailAvailable, mailFailureOutcome, sendPasswordChangedMail } = await import('../utils/mail.js');

assert.doesNotThrow(assertEnvironment);
assert.equal(env.db.ssl.rejectUnauthorized, true);
assert.equal(env.db.ssl.verifyIdentity, true);
assert.match(env.db.ssl.ca, /BEGIN CERTIFICATE/);
process.env.RENDER = 'true';
assert.throws(assertEnvironment, /configured private Supabase storage/);
Object.assign(process.env, { PRIVATE_STORAGE_MODE: 'supabase', SUPABASE_URL: 'https://storage.example.invalid', SUPABASE_SECRET_KEY: 'sb_secret_synthetic-only', SUPABASE_BUCKET: 'sbaa-private-uploads' });
assert.doesNotThrow(assertEnvironment);
process.env.SUPABASE_SECRET_KEY = 'legacy-jwt-not-supported';
assert.throws(assertEnvironment, /sb_secret_/);
process.env.SUPABASE_SECRET_KEY = 'sb_secret_synthetic-only';
delete process.env.RENDER;
const savedCa = process.env.DB_SSL_CA;
delete process.env.DB_SSL_CA;
assert.throws(assertEnvironment, /DB_SSL_CA/);
process.env.DB_SSL_CA = savedCa;
assert.equal(mailAvailable(), true);
assert.equal(mailFailureOutcome({ code: 'HTTP_403' }), 'PROVIDER_REJECTED');
assert.equal(mailFailureOutcome({ code: 'HTTP_UNKNOWN' }), 'PROVIDER_UNKNOWN');

function checkProxy(path, method, supplied) {
  const req = { path, method, get: () => supplied };
  const res = { code: 200, status(code) { this.code = code; return this; }, set() { return this; }, json(body) { this.body = body; return this; } };
  let nextCalled = false;
  requirePagesProxy(req, res, () => { nextCalled = true; });
  return { code: res.code, nextCalled };
}
assert.equal(checkProxy('/api/health', 'GET', '').nextCalled, true);
assert.equal(checkProxy('/api/health', 'POST', '').code, 403);
assert.equal(checkProxy('/api/auth/login', 'POST', '').code, 403);
assert.equal(checkProxy('/api/auth/login', 'POST', process.env.PROXY_SHARED_SECRET).nextCalled, true);

const originalFetch = globalThis.fetch;
try {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.resend.com/emails');
    const payload = JSON.parse(options.body);
    assert.equal(payload.from, process.env.MAIL_FROM);
    assert.equal(payload.attachments[0].content_id, 'sbaa-school-portal-logo');
    return new Response(JSON.stringify({ id: 'provider-test-id' }), { status: 200 });
  };
  assert.equal((await sendPasswordChangedMail('recipient@example.invalid')).messageId, 'provider-test-id');
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls++; throw new Error('synthetic timeout'); };
  await assert.rejects(sendPasswordChangedMail('recipient@example.invalid'), { code: 'HTTP_UNKNOWN' });
  assert.equal(calls, 2, 'an ambiguous provider failure must not be retried');
} finally { globalThis.fetch = originalFetch; }

console.log('Deployment security unit checks passed.');
