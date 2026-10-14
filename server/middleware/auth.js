import { pool } from '../database/pool.js';
import { digest } from '../utils/sessions.js';
import { env } from '../config/env.js';
import { readSessionCookie, validCsrfToken } from '../utils/session-cookie.js';
import { fail } from '../utils/response.js';

const safeMethod = (method) => ['GET', 'HEAD', 'OPTIONS'].includes(method);
export function enforceRequestOrigin(req, res, next) {
  if (env.sessionTransport !== 'cookie' || safeMethod(req.method)) return next();
  if (req.get('Origin') !== env.clientUrl) return fail(res, 'Request origin is not allowed.', 403);
  next();
}

export async function authenticate(req, res, next) {
  const token = env.sessionTransport === 'cookie'
    ? readSessionCookie(req)
    : /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];
  if (!token) return fail(res, 'Authentication is required.', 401);
  try {
    const [rows] = await pool.execute(`SELECT s.id session_id, u.id, u.role, u.status
      FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_digest=? AND s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP() LIMIT 1`, [digest(token)]);
    if (!rows[0] || rows[0].status !== 'ACTIVE') return fail(res, 'Your session has expired or your account is unavailable.', 401);
    if (env.sessionTransport === 'cookie' && !safeMethod(req.method)
      && !validCsrfToken(digest(token), req.get('X-SBAA-CSRF'))) {
      return fail(res, 'Request verification failed.', 403);
    }
    req.user = { sub: rows[0].id, role: rows[0].role, sessionId: rows[0].session_id };
    if (env.sessionTransport === 'cookie') req.sessionDigest = digest(token);
    pool.execute('UPDATE auth_sessions SET last_seen_at=UTC_TIMESTAMP() WHERE id=? AND (last_seen_at IS NULL OR last_seen_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE))',[rows[0].session_id]).catch(()=>{});
    next();
  } catch (error) { next(error); }
}
export const authorize = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : fail(res, 'You do not have permission to perform this action.', 403);
