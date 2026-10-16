import { timingSafeEqual } from 'node:crypto';

// Render exposes its service URL publicly. Only the Pages Function may reach
// application routes; Render's direct health check remains unauthenticated.
export function requirePagesProxy(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  if (req.path === '/api/health' && ['GET', 'HEAD'].includes(req.method)) return next();
  const expected = process.env.PROXY_SHARED_SECRET;
  const supplied = req.get('X-SBAA-Proxy-Secret') || '';
  if (typeof expected !== 'string' || !expected || supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(403).set('Cache-Control', 'no-store').json({ success: false, message: 'Access denied.' });
  }
  next();
}
