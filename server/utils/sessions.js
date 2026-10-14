import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../database/pool.js';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export async function createSession(userId, connection = pool, userAgent = '') {
  const token = randomBytes(32).toString('base64url');
  await connection.execute('DELETE FROM auth_sessions WHERE (revoked_at IS NOT NULL AND revoked_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)) OR expires_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)');
  await connection.execute('INSERT INTO auth_sessions (user_id, token_digest, expires_at,last_seen_at,user_agent) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR),UTC_TIMESTAMP(),?)', [userId, digest(token),String(userAgent).replace(/[\x00-\x1f\x7f]/g,'').slice(0,180)||null]);
  return token;
}
export async function revokeUserSessions(userId, connection = pool) {
  await connection.execute('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE user_id=? AND revoked_at IS NULL', [userId]);
}
