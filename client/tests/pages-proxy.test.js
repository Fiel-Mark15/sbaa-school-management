import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';

const env = { API_ORIGIN: 'https://api.example.org', PROXY_SHARED_SECRET: 'test-only-secret' };
const realFetch = globalThis.fetch;
try {
  let forwarded;
  globalThis.fetch = async request => {
    forwarded = request;
    return new Response('{"success":true}', { status: 200, headers: { 'Set-Cookie': 'sbaa_session=test; HttpOnly; Secure; SameSite=Lax; Path=/api' } });
  };
  const request = new Request('https://school.pages.dev/api/auth/login', {
    method: 'POST', headers: { Origin: 'https://school.pages.dev', 'CF-Connecting-IP': '203.0.113.10', 'X-Forwarded-For': '198.51.100.5' }, body: '{}', duplex: 'half'
  });
  const response = await onRequest({ request, env });
  assert.equal(response.status, 200);
  assert.equal(forwarded.url, 'https://api.example.org/api/auth/login');
  assert.equal(forwarded.headers.get('Origin'), 'https://school.pages.dev');
  assert.equal(forwarded.headers.get('X-Forwarded-For'), '203.0.113.10');
  assert.equal(forwarded.headers.get('X-SBAA-Proxy-Secret'), env.PROXY_SHARED_SECRET);
  assert.match(response.headers.get('Set-Cookie'), /HttpOnly/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const denied = await onRequest({ request: new Request('https://school.pages.dev/api/auth/login', {
    method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}', duplex: 'half'
  }), env });
  assert.equal(denied.status, 403);
  const unconfigured = await onRequest({ request: new Request('https://school.pages.dev/api/health'), env: {} });
  assert.equal(unconfigured.status, 503);
  console.log('Cloudflare API proxy checks passed.');
} finally {
  globalThis.fetch = realFetch;
}
