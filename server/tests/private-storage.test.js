import assert from 'node:assert/strict';

// Synthetic in-memory Storage API; no real project, database, or school file is used.
Object.assign(process.env, {
  PRIVATE_STORAGE_MODE: 'supabase', SUPABASE_URL: 'https://storage.example.invalid',
  SUPABASE_SECRET_KEY: 'sb_secret_synthetic-server-only-key', SUPABASE_BUCKET: 'sbaa-private-uploads',
  SESSION_TRANSPORT: 'bearer',
});
const { assertPrivateStorageReady, putPrivateObject, getPrivateObject, deletePrivateObject } = await import('../utils/private-storage.js');
const { authenticate, authorize } = await import('../middleware/auth.js');
const { canRead } = await import('../routes/acquisitions.routes.js');
const { accessible } = await import('../routes/attachments.routes.js');
const objects = new Map();
const calls = [];
let failUpload = false, failDownload = false, failDelete = false, publicBucket = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, method: options.method || 'GET' });
  assert.equal(options.headers.apikey, process.env.SUPABASE_SECRET_KEY);
  assert.equal(options.headers.Authorization, undefined);
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('/bucket/sbaa-private-uploads')) return Response.json({ id: 'sbaa-private-uploads', public: publicBucket });
  if (pathname.endsWith('/object/sbaa-private-uploads') && options.method === 'DELETE') {
    if (failDelete) return new Response('', { status: 503 });
    const { prefixes } = JSON.parse(options.body);
    assert.equal(prefixes.length, 1);
    objects.delete(prefixes[0]);
    return Response.json([]);
  }
  const name = decodeURIComponent(pathname.split('/').at(-1));
  if (options.method === 'POST') {
    if (failUpload) return new Response('', { status: 503 });
    assert.equal(options.headers['x-upsert'], 'false');
    if (objects.has(name)) return new Response('', { status: 409 });
    objects.set(name, Buffer.from(options.body));
    return Response.json({ Key: name });
  }
  if (failDownload) return new Response('', { status: 503 });
  if (!objects.has(name)) return new Response('', { status: 404 });
  return new Response(objects.get(name), { status: 200 });
};

try {
  await assertPrivateStorageReady();
  publicBucket = true;
  await assert.rejects(assertPrivateStorageReady(), /publicly accessible/);
  publicBucket = false;

  const first = `${'a'.repeat(64)}.webp`, replacement = `${'b'.repeat(64)}.webp`;
  await putPrivateObject(first, Buffer.from('photo-one'), 'image/webp');
  assert.equal((await getPrivateObject(first)).toString(), 'photo-one');
  await putPrivateObject(replacement, Buffer.from('photo-two'), 'image/webp');
  assert.equal((await getPrivateObject(replacement)).toString(), 'photo-two');
  await deletePrivateObject(first);
  assert.equal((await getPrivateObject(replacement)).toString(), 'photo-two');
  await assert.rejects(getPrivateObject(first), { code: 'ENOENT' });
  await assert.rejects(putPrivateObject(replacement, Buffer.from('overwrite'), 'image/webp'), { code: 'PRIVATE_STORAGE_ERROR' });
  assert.equal((await getPrivateObject(replacement)).toString(), 'photo-two');

  failUpload = true;
  await assert.rejects(putPrivateObject(`${'c'.repeat(64)}.webp`, Buffer.from('failed'), 'image/webp'), { code: 'PRIVATE_STORAGE_ERROR' });
  assert.equal(objects.size, 1, 'failed upload must not persist an object');
  failUpload = false;
  failDownload = true;
  await assert.rejects(getPrivateObject(replacement), { code: 'PRIVATE_STORAGE_ERROR' });
  failDownload = false;
  failDelete = true;
  await assert.rejects(deletePrivateObject(replacement), { code: 'PRIVATE_STORAGE_ERROR' });
  assert.equal(objects.size, 1, 'failed delete must not remove the stored object');
  failDelete = false;
  await deletePrivateObject(replacement);
  assert.equal(objects.size, 0);

  const before = calls.length;
  await assert.rejects(getPrivateObject('../other-account/file'), { code: 'INVALID_STORAGE_KEY' });
  await assert.rejects(deletePrivateObject('profile-other-account.webp'), { code: 'INVALID_STORAGE_KEY' });
  await assert.rejects(putPrivateObject(`${'d'.repeat(64)}.webp`, Buffer.from('x'), 'text/html'), { code: 'PRIVATE_STORAGE_ERROR' });
  assert.equal(calls.length, before, 'invalid keys and types must not reach storage');
  assert.equal(calls.some(call => call.url.includes('/object/public/')), false);

  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  let permitted = false;
  await authenticate({ headers: {}, method: 'GET' }, res, () => { permitted = true; });
  assert.equal(res.code, 401);
  assert.equal(permitted, false, 'unauthenticated requests cannot enter file routes');
  authorize('ADMIN')({ user: { role: 'STUDENT' } }, res, () => { permitted = true; });
  assert.equal(res.code, 403);
  assert.equal(permitted, false, 'student cannot perform administrator file operations');
  assert.equal(canRead({ role: 'STUDENT', sub: 10 }, { requester_id: 11 }), false, 'cross-account attachment access is denied');
  assert.equal(canRead({ role: 'FACULTY', sub: 10 }, { requester_id: 10 }), true);
  assert.equal(canRead({ role: 'ADMIN', sub: 1 }, { requester_id: 10 }), true);
  assert.equal(await accessible({ role: 'STUDENT', sub: 10 }, { status: 'DRAFT', audience: 'ALL' }), false);
  assert.equal(await accessible({ role: 'STUDENT', sub: 10 }, { status: 'PUBLISHED', audience: 'ALL' }), true);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Private storage unit checks passed.');
