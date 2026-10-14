import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { pool } from '../database/pool.js';

const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) {
  throw new Error('Pass an absolute private backup directory outside the repository.');
}
const repository = fileURLToPath(new URL('../../', import.meta.url));
const target = path.resolve(destination);
if (target === repository || target.startsWith(`${repository}${path.sep}`)) {
  throw new Error('Backups must be outside the repository.');
}

async function dumpTable(table, where, output) {
  const args = [
    '--protocol=tcp', `--host=${env.db.host}`, `--port=${env.db.port}`,
    `--user=${env.db.user}`, '--single-transaction', '--quick',
    '--set-gtid-purged=OFF', '--no-tablespaces', '--default-character-set=utf8mb4',
    '--column-statistics=0',
  ];
  if (where) args.push('--no-create-info', '--skip-triggers', '--complete-insert', `--where=${where}`);
  args.push(env.db.database);
  if (table) args.push(table);
  await new Promise((resolve, reject) => {
    const child = spawn('mysqldump', args, {
      env: { ...process.env, MYSQL_PWD: env.db.password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const file = createWriteStream(output, { flags: 'wx', mode: 0o600 });
    child.stdout.pipe(file);
    child.stderr.resume(); // Never echo server or credential diagnostics into logs.
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`mysqldump failed (${code}).`)));
    file.on('error', reject);
  });
}

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

await mkdir(target, { recursive: true, mode: 0o700 });
await chmod(target, 0o700);
const fullDump = path.join(target, 'database-full.sql');
const adminDump = path.join(target, 'approved-admin-only.sql');
const uploadsCopy = path.join(target, 'uploads');
await dumpTable(null, null, fullDump);
await mkdir(uploadsCopy, { mode: 0o700 });
const sourceUploads = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : fileURLToPath(new URL('../private-uploads/', import.meta.url));
const files = [];
try {
  for (const entry of await readdir(sourceUploads, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = path.join(sourceUploads, entry.name);
    if (!(await stat(source)).isFile()) continue;
    const copy = path.join(uploadsCopy, entry.name);
    await copyFile(source, copy);
    await chmod(copy, 0o600);
    files.push({ file: entry.name, sha256: await checksum(copy) });
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const [admins] = await pool.execute("SELECT id,email,password_hash FROM users WHERE role='ADMIN' AND status='ACTIVE'");
if (admins.length !== 1 || admins[0].email.endsWith('.test') || !/^(\$2[aby]\$|\$scrypt\$)/.test(admins[0].password_hash)) {
  throw new Error('Expected exactly one active, non-test administrator with a supported password hash.');
}
const adminId = admins[0].id;
await dumpTable('users', `id=${adminId}`, adminDump);
for (const table of ['profile_contacts', 'profile_photos']) {
  const part = path.join(target, `${table}.sql`);
  await dumpTable(table, `user_id=${adminId}`, part);
}
const [[photo]] = await pool.execute('SELECT storage_key FROM profile_photos WHERE user_id=?', [adminId]);
if (photo && !files.some(({ file }) => file === `profile-${photo.storage_key}.webp`)) {
  throw new Error('Administrator photo is referenced in MySQL but absent from upload backup.');
}
const manifest = {
  createdAt: new Date().toISOString(),
  scope: 'PRIVATE full local backup plus administrator-only migration export',
  fullDumpSha256: await checksum(fullDump),
  adminDumpSha256: await checksum(adminDump),
  adminId,
  uploads: files,
};
await writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
await pool.end();
console.log(`Private backup completed: 1 administrator; ${files.length} uploaded files.`);
