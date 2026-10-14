// Cloudflare Pages Function: keep browser API calls same-origin so the
// host-only, SameSite=Lax session cookie does not depend on third-party cookies.
export async function onRequest({ request, env }) {
  let origin;
  try {
    origin = new URL(env.API_ORIGIN);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || typeof env.PROXY_SHARED_SECRET !== 'string' || env.PROXY_SHARED_SECRET.length < 32) throw new Error();
  } catch {
    return new Response('API is unavailable.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const incoming = new URL(request.url);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('Origin') !== incoming.origin) {
    return new Response('Request origin is not allowed.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const upstream = new URL(incoming.pathname + incoming.search, origin);
  const headers = new Headers(request.headers);
  // Never let an untrusted client impersonate proxy metadata.
  for (const name of ['host', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'cf-connecting-ip', 'x-sbaa-proxy-secret']) headers.delete(name);
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set('X-Forwarded-For', clientIp);
  headers.set('Origin', incoming.origin);
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-SBAA-Proxy-Secret', env.PROXY_SHARED_SECRET);
  try {
    const response = await fetch(new Request(upstream, { method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual', duplex: 'half' }));
    const outgoing = new Headers(response.headers);
    outgoing.delete('access-control-allow-origin');
    outgoing.delete('access-control-allow-credentials');
    outgoing.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch {
    return new Response('API is unavailable.', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
