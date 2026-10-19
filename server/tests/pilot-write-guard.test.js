import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertDatabaseWriteTarget, assertWriteConfiguration } from '../database/write-guard.js';
import { isolateBaseSchema } from '../database/pilot-schema.js';

const base = { DB_HOST: '127.0.0.1', DB_NAME: 'sbaa_pilot_test', SBAA_PILOT_TEST: 'true', NODE_ENV: 'test' };
assert.doesNotThrow(() => assertWriteConfiguration(base));
assert.throws(() => assertWriteConfiguration({ ...base, SBAA_PILOT_TEST: 'tru' }), /exactly true or false/);
for (const database of ['school_portal', 'defaultdb', 'other_database']) {
  assert.throws(() => assertWriteConfiguration({ ...base, DB_NAME: database }), /DB_NAME=sbaa_pilot_test/);
}
assert.throws(() => assertWriteConfiguration({ ...base, DB_HOST: 'mysql.example.invalid' }), /ALLOW_REMOTE/);
assert.throws(() => assertWriteConfiguration({ ...base, DB_HOST: 'mysql.example.invalid', SBAA_PILOT_ALLOW_REMOTE: 'true' }), /DB_SSL_CA/);
assert.throws(() => assertWriteConfiguration({ ...base, NODE_ENV: 'production' }), /production mode/);
assert.throws(() => assertWriteConfiguration({ DB_HOST: 'mysql.example.invalid', DB_NAME: 'school_portal' }), /Remote database writes/);
assert.doesNotThrow(() => assertWriteConfiguration({ DB_HOST: '127.0.0.1', DB_NAME: 'school_portal' }), 'existing local development remains available');

const expectedPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'INDEX', 'REFERENCES'];
const exactScopeRows = expectedPrivileges.map(PRIVILEGE_TYPE => ({ TABLE_SCHEMA: 'sbaa_pilot_test', PRIVILEGE_TYPE, IS_GRANTABLE: 'NO' }));
function connection({ database = 'sbaa_pilot_test', account = 'sbaa_pilot_runner_v2@%', role = 'NONE', partialRevokes = 1, scopeRows = exactScopeRows, grants = [
  'GRANT USAGE ON *.* TO `sbaa_pilot_runner_v2`@`%`',
  'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `sbaa\\_pilot\\_test`.* TO `sbaa_pilot_runner_v2`@`%`'
] } = {}) {
  return { async query(sql, params) {
    if (sql.startsWith('SELECT DATABASE()')) return [[{ selected_database: database, authenticated_user: account, active_role: role }]];
    if (sql.startsWith('SELECT @@GLOBAL.partial_revokes')) return [[{ partial_revokes: partialRevokes }]];
    if (sql.startsWith('SHOW GRANTS')) return [grants.map(grant => ({ grant }))];
    if (sql.startsWith('SELECT TABLE_SCHEMA')) {
      assert.deepEqual(params, ["'sbaa_pilot_runner_v2'@'%'"]);
      return [scopeRows];
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
}
await assert.doesNotReject(assertDatabaseWriteTarget(connection(), base));
const remote = { ...base, DB_HOST: 'mysql.example.invalid', DB_SSL_CA: 'synthetic-ca', SBAA_PILOT_ALLOW_REMOTE: 'true' };
const remoteGrants = [
  'GRANT USAGE ON *.* TO `sbaa_pilot_runner_v2`@`%`',
  'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `sbaa_pilot_test`.* TO `sbaa_pilot_runner_v2`@`%`'
];
await assert.doesNotReject(assertDatabaseWriteTarget(connection({ grants: remoteGrants }), remote));
await assert.rejects(assertDatabaseWriteTarget(connection({ grants: remoteGrants, account: 'sbaa_test_runner@%' }), remote), /unexpected account/);
await assert.rejects(assertDatabaseWriteTarget(connection({ grants: remoteGrants, partialRevokes: 0 }), remote), /partial_revokes=ON/);
await assert.rejects(assertDatabaseWriteTarget(connection(), remote), /global, cross-database, delegated, or role privileges/);
await assert.rejects(assertDatabaseWriteTarget(connection({ grants: remoteGrants, scopeRows: exactScopeRows.map(row => ({ ...row, TABLE_SCHEMA: 'sbaa\\_pilot\\_test' })) }), remote), /literal database name/);
await assert.rejects(assertDatabaseWriteTarget(connection({ grants: remoteGrants, scopeRows: exactScopeRows.map((row, index) => index === 0 ? { ...row, IS_GRANTABLE: 'YES' } : row) }), remote), /literal database name/);
await assert.rejects(assertDatabaseWriteTarget(connection({ grants: remoteGrants, scopeRows: exactScopeRows.slice(1) }), remote), /literal database name/);
await assert.rejects(assertDatabaseWriteTarget(connection({ grants: [
  'GRANT USAGE ON *.* TO `sbaa_pilot_runner_v2`@`%`'
] }), remote), /exact schema-scoped migration privileges/);
for (const privileges of [
  'ALL PRIVILEGES',
  'SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP',
  'SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX'
]) {
  const grants = [
    'GRANT USAGE ON *.* TO `sbaa_pilot_runner_v2`@`%`',
    `GRANT ${privileges} ON \`sbaa_pilot_test\`.* TO \`sbaa_pilot_runner_v2\`@\`%\``
  ];
  await assert.rejects(assertDatabaseWriteTarget(connection({ grants }), remote), /privileges/);
}
await assert.rejects(assertDatabaseWriteTarget(connection({ database: 'school_portal' }), base), /differs from DB_NAME/);
await assert.rejects(assertDatabaseWriteTarget(connection({ role: '`admin`@`%`' }), base), /active MySQL roles/);
for (const grant of [
  'GRANT SELECT, INSERT ON *.* TO "sbaa_test_runner"@"%"',
  'GRANT ROLE_ADMIN ON *.* TO "sbaa_test_runner"@"%"',
  'GRANT SELECT ON defaultdb.* TO "sbaa_test_runner"@"%"',
  'GRANT SELECT ON sbaa_pilot_test.* TO "sbaa_test_runner"@"%"',
  'GRANT SELECT ON sbaa_pilot_test.* TO "sbaa_test_runner"@"%" WITH GRANT OPTION',
  'GRANT `admin`@`%` TO `sbaa_test_runner`@`%`'
]) await assert.rejects(assertDatabaseWriteTarget(connection({ grants: [grant] }), base), /privileges/);

const schema = await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8');
const isolated = isolateBaseSchema(schema);
assert.ok(isolated.includes('CREATE TABLE IF NOT EXISTS users'));
assert.ok(!/\bUSE\b|\bCREATE DATABASE\b/i.test(isolated));
assert.throws(() => isolateBaseSchema(schema.replace('USE school_portal;', 'USE defaultdb;')), /selector changed/);
assert.throws(() => isolateBaseSchema(`${schema}\nUSE defaultdb;`), /database switch/);
console.log('Pilot database target and schema guards passed without opening a database.');
