import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export const SESSION_COOKIE = 'sbaa_session';
const cookieParts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/api'];

export function readSessionCookie(req) {
  const pair = (req.headers.cookie || '').split(';').map(item => item.trim())
    .find(item => item.startsWith(`${SESSION_COOKIE}=`));
  const value = pair?.slice(SESSION_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function setSessionCookie(res, token) {
  res.set('Cache-Control', 'no-store');
  res.set('Set-Cookie', [...cookieParts.slice(0, 1).map(part => `${part}${token}`),
    ...cookieParts.slice(1), 'Max-Age=28800', ...(process.env.NODE_ENV === 'production' ? ['Secure'] : [])].join('; '));
}

export function clearSessionCookie(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Set-Cookie', [`${SESSION_COOKIE}=`, ...cookieParts.slice(1), 'Max-Age=0',
    ...(process.env.NODE_ENV === 'production' ? ['Secure'] : [])].join('; '));
}

export function csrfTokenForSession(sessionDigest) {
  return createHmac('sha256', env.csrfSecret).update(sessionDigest).digest('base64url');
}

export function validCsrfToken(sessionDigest, candidate) {
  if (typeof candidate !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(candidate)) return false;
  const expected = Buffer.from(csrfTokenForSession(sessionDigest));
  return timingSafeEqual(expected, Buffer.from(candidate));
}
