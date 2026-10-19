const PILOT_DATABASE = 'sbaa_pilot_test';
const REMOTE_PILOT_ACCOUNT = 'sbaa_pilot_runner_v2@%';
const REMOTE_PILOT_PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'INDEX', 'REFERENCES']);

function localHost(host) {
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

export function assertWriteConfiguration(config = process.env) {
  const host = config.DB_HOST;
  const database = config.DB_NAME;
  if (!host || !database) throw new Error('DB_HOST and DB_NAME are required for database writes.');
  if (config.SBAA_PILOT_TEST && config.SBAA_PILOT_TEST !== 'true' && config.SBAA_PILOT_TEST !== 'false') {
    throw new Error('SBAA_PILOT_TEST must be exactly true or false.');
  }

  if (config.SBAA_PILOT_TEST === 'true') {
    if (config.NODE_ENV === 'production') throw new Error('Pilot database writes are forbidden in production mode.');
    if (database !== PILOT_DATABASE) throw new Error(`Pilot database writes require DB_NAME=${PILOT_DATABASE}.`);
    if (!localHost(host) && config.SBAA_PILOT_ALLOW_REMOTE !== 'true') {
      throw new Error('Pilot database writes to a remote host require SBAA_PILOT_ALLOW_REMOTE=true and a scoped account.');
    }
    if (!localHost(host) && !config.DB_SSL_CA) throw new Error('Remote pilot database writes require a verified DB_SSL_CA.');
    return;
  }

  // Existing localhost development remains available. Any hosted migration needs a
  // separately reviewed deployment procedure rather than an accidental npm command.
  if (!localHost(host)) throw new Error('Remote database writes require the explicit pilot guard or a separately reviewed production migration.');
}

export async function assertDatabaseWriteTarget(connection, config = process.env) {
  assertWriteConfiguration(config);
  const [[identity]] = await connection.query('SELECT DATABASE() AS selected_database, CURRENT_USER() AS authenticated_user, CURRENT_ROLE() AS active_role');
  if (identity.selected_database !== config.DB_NAME) throw new Error('Connected database differs from DB_NAME; refusing to write.');

  if (config.SBAA_PILOT_TEST !== 'true') return identity;
  if (identity.selected_database !== PILOT_DATABASE) throw new Error('Pilot connection did not select the isolated database.');
  if (identity.active_role && identity.active_role !== 'NONE') throw new Error('Pilot account has active MySQL roles; refusing to write.');

  const remotePilot = !localHost(config.DB_HOST);
  if (remotePilot) {
    if (identity.authenticated_user !== REMOTE_PILOT_ACCOUNT) throw new Error('Remote pilot connection authenticated as an unexpected account; refusing to write.');
    const [[{ partial_revokes: partialRevokes }]] = await connection.query('SELECT @@GLOBAL.partial_revokes AS partial_revokes');
    if (Number(partialRevokes) !== 1) throw new Error('Remote pilot grants require partial_revokes=ON; refusing to write.');
  }

  const [rows] = await connection.query('SHOW GRANTS FOR CURRENT_USER()');
  const grants = rows.map(row => String(Object.values(row)[0] || '').replaceAll('`', '').replaceAll('"', ''));
  // With partial_revokes=ON, an escaped underscore names a different schema.
  const literalPilotScope = remotePilot ? `${PILOT_DATABASE}.*` : 'sbaa\\_pilot\\_test.*';
  const scopedPrivileges = new Set();
  if (!grants.length || grants.some(grant => {
    if (/\bWITH GRANT OPTION\b/i.test(grant)) return true;
    const match = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(grant);
    if (!match) return true; // Reject roles, proxy grants, and unrecognized statements.
    const [, privileges, scope] = match;
    if (privileges.toUpperCase() === 'USAGE' && scope === '*.*') return false;
    if (scope !== literalPilotScope) return true;
    if (remotePilot) {
      const names = privileges.toUpperCase().split(',').map(name => name.trim());
      if (names.some(name => !REMOTE_PILOT_PRIVILEGES.has(name))) return true;
      names.forEach(name => scopedPrivileges.add(name));
    }
    return false;
  })) throw new Error('Pilot account has global, cross-database, delegated, or role privileges; refusing to write.');
  if (remotePilot && (scopedPrivileges.size !== REMOTE_PILOT_PRIVILEGES.size ||
    [...REMOTE_PILOT_PRIVILEGES].some(name => !scopedPrivileges.has(name)))) {
    throw new Error('Remote pilot account lacks the exact schema-scoped migration privileges; refusing to write.');
  }
  if (remotePilot) {
    const [scopeRows] = await connection.query(
      'SELECT TABLE_SCHEMA, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ?',
      ["'sbaa_pilot_runner_v2'@'%'"]
    );
    const storedPrivileges = new Set(scopeRows.map(row => row.PRIVILEGE_TYPE));
    if (scopeRows.length !== REMOTE_PILOT_PRIVILEGES.size ||
      scopeRows.some(row => row.TABLE_SCHEMA !== PILOT_DATABASE || row.IS_GRANTABLE !== 'NO') ||
      [...REMOTE_PILOT_PRIVILEGES].some(name => !storedPrivileges.has(name))) {
      throw new Error('Remote pilot account does not have exactly eight non-grantable privileges on the literal database name; refusing to write.');
    }
  }
  return identity;
}

export const pilotDatabaseName = PILOT_DATABASE;
