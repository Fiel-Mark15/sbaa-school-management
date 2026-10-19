import mysql from 'mysql2/promise';
import { assertDatabaseWriteTarget } from '../database/write-guard.js';

const required = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_SSL_CA'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) throw new Error(`Missing verifier environment variables: ${missing.join(', ')}.`);
if (process.env.DB_NAME !== 'sbaa_pilot_test') throw new Error('Verifier requires DB_NAME=sbaa_pilot_test.');
if (['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST)) throw new Error('Verifier requires a remote Aiven host.');
if (['avnadmin', 'sbaa_test_runner'].includes(process.env.DB_USER)) throw new Error('Verifier requires a newly scoped pilot account.');

const port = Number(process.env.DB_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DB_PORT must be a valid TCP port.');
const ca = process.env.DB_SSL_CA.replace(/\\n/g, '\n');
if (!ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----')) {
  throw new Error('DB_SSL_CA must contain the Aiven CA certificate.');
}

let connection;
try {
  connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { ca, rejectUnauthorized: true, verifyIdentity: true },
    multipleStatements: false
  });

  const identity = await assertDatabaseWriteTarget(connection, {
    DB_HOST: process.env.DB_HOST,
    DB_NAME: process.env.DB_NAME,
    DB_SSL_CA: ca,
    NODE_ENV: 'verification',
    SBAA_PILOT_TEST: 'true',
    SBAA_PILOT_ALLOW_REMOTE: 'true'
  });
  if (!identity.authenticated_user?.startsWith(`${process.env.DB_USER}@`)) {
    throw new Error('Authenticated MySQL account differs from DB_USER.');
  }

  const [cipherRows] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
  if (!cipherRows[0]?.Value) throw new Error('MySQL session has no TLS cipher.');
  console.log('PASS: selected pilot database, authenticated account, no active role, exact scoped grants, and verified TLS.');
} catch (error) {
  console.error(`FAIL: ${error.code || error.message}`);
  process.exitCode = 1;
} finally {
  if (connection) await connection.end();
}
