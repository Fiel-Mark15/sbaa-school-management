import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { env } from '../config/env.js';
import { assertDatabaseWriteTarget, assertWriteConfiguration } from './write-guard.js';

export function isolateBaseSchema(source) {
  const header = /^CREATE DATABASE IF NOT EXISTS school_portal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\s*USE school_portal;\s*/;
  if (!header.test(source)) throw new Error('Base schema database selector changed; review before pilot use.');
  const isolated = source.replace(header, '');
  if (/\b(?:CREATE|DROP|ALTER)\s+DATABASE\b|\bUSE\s+|\b(?:school_portal|defaultdb)\s*\./i.test(isolated)) {
    throw new Error('Base schema contains a database switch or cross-database reference.');
  }
  return isolated;
}

async function main() {
  if (process.env.SBAA_PILOT_TEST !== 'true') throw new Error('Pilot schema loader requires SBAA_PILOT_TEST=true.');
  assertWriteConfiguration();
  const connection = await mysql.createConnection({ ...env.db, multipleStatements: true });
  try {
    await assertDatabaseWriteTarget(connection);
    const [[inventory]] = await connection.execute(
      'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ?', [env.db.database]
    );
    if (inventory.count !== 0) throw new Error('Pilot database is not empty; refusing to apply the base schema.');
    const sql = isolateBaseSchema(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await connection.query(sql);
    console.log('Base schema applied to the isolated pilot database.');
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await main();
