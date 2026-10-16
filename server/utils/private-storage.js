import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

const localDirectory = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : fileURLToPath(new URL('../private-uploads/', import.meta.url));
const objectName = /^(?:profile-|announcement-|acquisition-)?[a-f0-9]{64}(?:\.webp)?$/;
function validateName(name) {
  if (typeof name !== 'string' || !objectName.test(name) ||
    (name.startsWith('acquisition-') ? name.endsWith('.webp') : !name.endsWith('.webp'))) {
    throw Object.assign(new Error('Invalid private object key.'), { code: 'INVALID_STORAGE_KEY' });
  }
  return name;
}
function localPath(name) { return path.join(localDirectory, validateName(name)); }
function storageError(status) {
  return Object.assign(new Error('Private storage request failed.'), { code: status === 404 ? 'ENOENT' : 'PRIVATE_STORAGE_ERROR' });
}
function urlFor(suffix) { return `${env.supabase.url}/storage/v1/${suffix}`; }
function headers(extra = {}) {
  return { apikey: env.supabase.secretKey, ...extra };
}
async function request(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }); }
  catch { throw storageError(503); }
  if (!response.ok) throw storageError(response.status);
  return response;
}
const keyUrl = name => urlFor(`object/${encodeURIComponent(env.supabase.bucket)}/${encodeURIComponent(validateName(name))}`);

export async function assertPrivateStorageReady() {
  if (env.privateStorageMode !== 'supabase') return;
  const response = await request(urlFor(`bucket/${encodeURIComponent(env.supabase.bucket)}`), { headers: headers() });
  const bucket = await response.json();
  if (bucket.id !== env.supabase.bucket || bucket.public !== false) throw new Error('Supabase private bucket is missing or publicly accessible.');
}

export async function putPrivateObject(name, data, contentType) {
  validateName(name);
  if (!Buffer.isBuffer(data) || data.length === 0 || data.length > 10 * 1024 * 1024) throw storageError(413);
  if (!['image/webp', 'image/png', 'image/jpeg', 'application/pdf'].includes(contentType) ||
      (name.endsWith('.webp') && contentType !== 'image/webp') ||
      (name.startsWith('acquisition-') && contentType === 'image/webp')) throw storageError(415);
  if (env.privateStorageMode === 'filesystem') {
    await mkdir(localDirectory, { recursive: true, mode: 0o700 });
    return writeFile(localPath(name), data, { flag: 'wx', mode: 0o600 });
  }
  await request(keyUrl(name), { method: 'POST', headers: headers({ 'Content-Type': contentType, 'x-upsert': 'false' }), body: data });
}

export async function getPrivateObject(name) {
  if (env.privateStorageMode === 'filesystem') return readFile(localPath(name));
  const response = await request(urlFor(`object/authenticated/${encodeURIComponent(env.supabase.bucket)}/${encodeURIComponent(validateName(name))}`), { headers: headers() });
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 10 * 1024 * 1024) throw storageError(413);
  return data;
}

export async function deletePrivateObject(name) {
  if (env.privateStorageMode === 'filesystem') {
    try { await unlink(localPath(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  await request(urlFor(`object/${encodeURIComponent(env.supabase.bucket)}`), {
    method: 'DELETE', headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: [validateName(name)] }),
  });
}
