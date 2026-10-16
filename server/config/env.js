import 'dotenv/config';

const required = ['DB_HOST', 'DB_NAME', 'DB_USER'];
const siteOrigin = (value, name) => {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash || value.replace(/\/$/, '') !== parsed.origin) {
    throw new Error(`${name} must be an absolute site origin.`);
  }
  return parsed.origin;
};
export function assertEnvironment() {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  const publicUrl=siteOrigin(process.env.APP_PUBLIC_URL||process.env.CLIENT_URL||'http://localhost:5173','APP_PUBLIC_URL');
  const clientUrl=siteOrigin(process.env.CLIENT_URL||'http://localhost:5173','CLIENT_URL');
  if (!Number.isInteger(Number(process.env.PORT || 5050)) || Number(process.env.PORT || 5050) < 1) throw new Error('PORT must be a valid TCP port.');
  if (process.env.DB_POOL_LIMIT && (!Number.isInteger(Number(process.env.DB_POOL_LIMIT)) || Number(process.env.DB_POOL_LIMIT) < 1 || Number(process.env.DB_POOL_LIMIT) > 100)) throw new Error('DB_POOL_LIMIT must be 1-100.');
  const transport=process.env.SESSION_TRANSPORT || (process.env.NODE_ENV==='production'?'cookie':'bearer');
  if (!['bearer','cookie'].includes(transport)) throw new Error('SESSION_TRANSPORT must be bearer or cookie.');
  if (transport==='cookie' && (!process.env.CSRF_SECRET || process.env.CSRF_SECRET.length<32)) throw new Error('CSRF_SECRET must contain at least 32 random characters for cookie sessions.');
  const storageMode=process.env.PRIVATE_STORAGE_MODE||'filesystem';
  if(!['filesystem','supabase'].includes(storageMode))throw new Error('PRIVATE_STORAGE_MODE must be filesystem or supabase.');
  if(storageMode==='supabase'){
    const url=siteOrigin(process.env.SUPABASE_URL||'', 'SUPABASE_URL');
    if(!url.startsWith('https://')||!process.env.SUPABASE_SECRET_KEY?.startsWith('sb_secret_')||process.env.SUPABASE_BUCKET!=='sbaa-private-uploads')throw new Error('Supabase private storage requires HTTPS SUPABASE_URL, an sb_secret_ SUPABASE_SECRET_KEY, and SUPABASE_BUCKET=sbaa-private-uploads.');
  }
  if(process.env.NODE_ENV==='production') {
    if(publicUrl!==clientUrl || !publicUrl.startsWith('https://')) throw new Error('CLIENT_URL and APP_PUBLIC_URL must be the same HTTPS frontend origin in production.');
    if(transport!=='cookie') throw new Error('Production requires SESSION_TRANSPORT=cookie.');
    if(!process.env.DB_PASSWORD) throw new Error('DB_PASSWORD is required in production.');
    if(!process.env.DB_SSL_CA?.includes('-----BEGIN CERTIFICATE-----') || !process.env.DB_SSL_CA.includes('-----END CERTIFICATE-----')) throw new Error('Production requires the Aiven DB_SSL_CA certificate.');
    if(!process.env.PROXY_SHARED_SECRET || process.env.PROXY_SHARED_SECRET.length<32) throw new Error('Production requires a random PROXY_SHARED_SECRET of at least 32 characters.');
    if(!['smtp','resend'].includes(process.env.MAIL_MODE)) throw new Error('Production requires MAIL_MODE=smtp or resend.');
    if(process.env.MAIL_MODE==='smtp' && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.MAIL_FROM)) throw new Error('Production SMTP settings are incomplete.');
    if(process.env.MAIL_MODE==='smtp' && process.env.SMTP_HOST.toLowerCase()==='smtp.gmail.com' && (process.env.SMTP_PORT!=='465' || process.env.SMTP_SECURE!=='true' || process.env.MAIL_FROM!==`SBAA School Portal <${process.env.SMTP_USER}>`)) throw new Error('Gmail SMTP requires port 465, secure TLS, and a matching sender address.');
    if(process.env.MAIL_MODE==='resend' && (!process.env.RESEND_API_KEY || !/^SBAA School Portal <[^<>\s@]+@[^<>\s@]+>$/.test(process.env.MAIL_FROM||''))) throw new Error('Resend requires RESEND_API_KEY and MAIL_FROM from a verified sender domain.');
    if(storageMode==='filesystem'&&!process.env.UPLOAD_DIR?.startsWith('/')) throw new Error('UPLOAD_DIR must be an absolute persistent path in production.');
    if(process.env.RENDER === 'true' && process.env.RUN_REMINDER_SCHEDULER === 'true') throw new Error('Render Free cannot reliably host the minute-loop reminder scheduler.');
    if(process.env.RENDER === 'true' && storageMode!=='supabase') throw new Error('Render Free requires configured private Supabase storage.');
  }
  for(const key of ['AUTH_LOGIN_LIMIT','AUTH_REGISTER_LIMIT','AUTH_FORGOT_LIMIT','AUTH_VALIDATE_LIMIT','AUTH_RESET_LIMIT'])if(process.env[key]&&(!Number.isSafeInteger(Number(process.env[key]))||Number(process.env[key])<1))throw new Error(`${key} must be a positive integer.`);
}
export const env = {
  privateStorageMode: process.env.PRIVATE_STORAGE_MODE || 'filesystem',
  supabase: { url: (process.env.SUPABASE_URL||'').replace(/\/$/,''), secretKey: process.env.SUPABASE_SECRET_KEY||'', bucket: process.env.SUPABASE_BUCKET||'' },
  port: Number(process.env.PORT || 5050),
  db: { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME,
    ...(process.env.DB_SSL_CA ? { ssl: { ca: process.env.DB_SSL_CA.replace(/\\n/g,'\n'), rejectUnauthorized: true, verifyIdentity: true } } : {}) },
  dbPoolLimit: Number(process.env.DB_POOL_LIMIT || 10),
  clientUrl: (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/,''),
  appPublicUrl: (process.env.APP_PUBLIC_URL || process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/,''),
  sessionTransport: process.env.SESSION_TRANSPORT || (process.env.NODE_ENV==='production'?'cookie':'bearer'),
  csrfSecret: process.env.CSRF_SECRET || '',
  mailMode: process.env.MAIL_MODE || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || '',
  smtp: { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure:process.env.SMTP_SECURE==='true', user: process.env.SMTP_USER, password: process.env.SMTP_PASSWORD, from: process.env.MAIL_FROM||process.env.SMTP_FROM },
  limits:{login:Number(process.env.AUTH_LOGIN_LIMIT||20),register:Number(process.env.AUTH_REGISTER_LIMIT||20),forgot:Number(process.env.AUTH_FORGOT_LIMIT||10),reset:Number(process.env.AUTH_RESET_LIMIT||20),validate:Number(process.env.AUTH_VALIDATE_LIMIT||60)}
};
