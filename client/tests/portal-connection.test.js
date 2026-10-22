import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { connectingToPortal, isTemporaryConnectionFailure, pollPortalHealth, waitForPortal } from '../src/services/portal-connection.js';

assert.equal(isTemporaryConnectionFailure({ code: 'ECONNABORTED' }), true);
assert.equal(isTemporaryConnectionFailure({ code: 'ERR_NETWORK' }), true);
assert.equal(isTemporaryConnectionFailure({ response: { status: 503 } }), true);
assert.equal(isTemporaryConnectionFailure({ response: { status: 401 } }), false);
assert.equal(isTemporaryConnectionFailure({ code: 'ERR_CANCELED' }), false);

let clock = 0;
let attempts = 0;
const fakeTime = { now: () => clock, sleep: async ms => { clock += ms; } };
await pollPortalHealth(async () => {
  attempts += 1;
  if (attempts < 3) throw { response: { status: 503 } };
}, { ...fakeTime, durationMs: 10_000 });
assert.equal(attempts, 3);
assert.equal(clock, 6_000);

attempts = 0;
await assert.rejects(pollPortalHealth(async () => {
  attempts += 1;
  throw { response: { status: 401 } };
}, fakeTime));
assert.equal(attempts, 1);

clock = 0;
attempts = 0;
await assert.rejects(pollPortalHealth(async () => {
  attempts += 1;
  throw { code: 'ERR_NETWORK' };
}, { ...fakeTime, durationMs: 5_000 }), { code: 'PORTAL_UNAVAILABLE' });
assert.equal(attempts, 2);

let releaseProbe;
const waiting = waitForPortal(() => new Promise(resolve => { releaseProbe = resolve; }));
assert.equal(connectingToPortal.value, true);
releaseProbe();
await waiting;
assert.equal(connectingToPortal.value, false);

// Middleware mode does not open a listening port or start a development server.
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const originalStorage = globalThis.localStorage;
const originalWindow = globalThis.window;
try {
  globalThis.localStorage = { getItem: () => null, removeItem: () => {}, setItem: () => {} };
  globalThis.window = { location: { pathname: '/login', assign: () => { throw new Error('Unexpected redirect'); } } };
  const { default: api } = await vite.ssrLoadModule('/src/services/api.js');
  const calls = [];
  let reads = 0;
  api.defaults.adapter = async config => {
    calls.push(`${config.method.toUpperCase()} ${config.url}`);
    if (config.url === '/health') return { config, status: 200, data: { success: true }, headers: {} };
    if (config.method === 'get' && reads++ === 0) throw { config, code: 'ECONNABORTED' };
    return { config, status: 200, data: { success: true }, headers: {} };
  };
  await api.get('/dashboard/summary');
  assert.deepEqual(calls, ['GET /dashboard/summary', 'GET /health', 'GET /dashboard/summary']);

  calls.length = 0;
  api.defaults.adapter = async config => {
    calls.push(`${config.method.toUpperCase()} ${config.url}`);
    throw { config, response: { status: 502 } };
  };
  await assert.rejects(api.post('/auth/login', { identifier: 'fictional@example.test', password: 'example' }));
  assert.deepEqual(calls, ['POST /auth/login']);

  calls.length = 0;
  api.defaults.adapter = async config => {
    calls.push(`${config.method.toUpperCase()} ${config.url}`);
    throw { config, code: 'ECONNABORTED' };
  };
  await assert.rejects(api.post('/auth/reset-password', { token: 'fictional-token' }));
  assert.deepEqual(calls, ['POST /auth/reset-password']);

  calls.length = 0;
  await assert.rejects(api.get('/health'));
  assert.deepEqual(calls, ['GET /health']);
  console.log('Portal recovery, bounded failure, and no-write-retry checks passed.');
} finally {
  globalThis.localStorage = originalStorage;
  globalThis.window = originalWindow;
  await vite.close();
}
