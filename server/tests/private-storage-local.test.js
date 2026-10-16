import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'sbaa-private-storage-test-'));
Object.assign(process.env, { PRIVATE_STORAGE_MODE: 'filesystem', UPLOAD_DIR: directory });
const { putPrivateObject, getPrivateObject, deletePrivateObject } = await import('../utils/private-storage.js');
const name = `profile-${'f'.repeat(64)}.webp`;
try {
  await putPrivateObject(name, Buffer.from('synthetic-photo'), 'image/webp');
  assert.equal((await getPrivateObject(name)).toString(), 'synthetic-photo');
  await assert.rejects(putPrivateObject(name, Buffer.from('overwrite'), 'image/webp'), { code: 'EEXIST' });
  await deletePrivateObject(name);
  await assert.rejects(getPrivateObject(name), { code: 'ENOENT' });
  await deletePrivateObject(name);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('Local private storage regression checks passed.');
