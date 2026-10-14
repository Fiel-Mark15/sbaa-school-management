import { fail } from '../utils/response.js';
export function notFound(req, res) { return fail(res, 'Endpoint not found.', 404); }
export function errorHandler(error, req, res, next) {
  // Never serialize SQL values, authorization headers, recovery tokens, or uploads.
  console.error('SBAA request failed', { code: typeof error?.code === 'string' ? error.code : 'UNEXPECTED', path: req.route?.path || 'unknown' });
  return fail(res, 'An unexpected server error occurred.', 500);
}
