import assert from 'node:assert/strict';

// Synthetic configuration only. Fetch is replaced before any send; no DB or provider is contacted.
Object.assign(process.env, {
  NODE_ENV: 'production', DB_HOST: 'example.invalid', DB_NAME: 'test', DB_USER: 'test', DB_PASSWORD: 'synthetic',
  DB_SSL_CA: '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----',
  CLIENT_URL: 'https://school.example', APP_PUBLIC_URL: 'https://school.example',
  SESSION_TRANSPORT: 'cookie', CSRF_SECRET: 'synthetic-csrf-secret-longer-than-32-characters',
  PROXY_SHARED_SECRET: 'synthetic-proxy-secret-longer-than-32-characters',
  PRIVATE_STORAGE_MODE: 'filesystem', UPLOAD_DIR: '/tmp/sbaa-brevo-test-only',
  MAIL_MODE: 'brevo', BREVO_API_KEY: 'synthetic-brevo-key',
  MAIL_FROM: 'SBAA System <sbaa.chcci.admin@gmail.com>'
});
delete process.env.RENDER;
const { assertEnvironment } = await import('../config/env.js');
const { mailAvailable, mailFailureOutcome, sendResetMail, sendCurrentEmailVerificationMail, sendBrevoDiagnosticMail } = await import('../utils/mail.js');

assert.doesNotThrow(assertEnvironment);
assert.equal(mailAvailable(), true);
const configuredKey=process.env.BREVO_API_KEY;
const configuredSender=process.env.MAIL_FROM;
process.env.BREVO_API_KEY='';
assert.throws(assertEnvironment, /Brevo requires BREVO_API_KEY/);
process.env.BREVO_API_KEY=configuredKey;
process.env.MAIL_FROM='SBAA System <wrong@example.invalid>';
assert.throws(assertEnvironment, /approved MAIL_FROM sender/);
process.env.MAIL_FROM=configuredSender;
process.env.MAIL_MODE='invalid';
assert.throws(assertEnvironment, /MAIL_MODE=smtp, resend, or brevo/);
process.env.MAIL_MODE='brevo';
assert.equal(mailFailureOutcome({code:'HTTP_403'}),'PROVIDER_REJECTED');
assert.equal(mailFailureOutcome({code:'HTTP_402'}),'PROVIDER_REJECTED');
assert.equal(mailFailureOutcome({code:'HTTP_429'}),'PROVIDER_REJECTED');
assert.equal(mailFailureOutcome({code:'HTTP_UNKNOWN'}),'PROVIDER_UNKNOWN');

const originalFetch=globalThis.fetch;
let calls=0;
try{
  globalThis.fetch=async(url,options)=>{
    calls++;
    assert.equal(url,'https://api.brevo.com/v3/smtp/email');
    assert.equal(options.method,'POST');
    assert.equal(options.headers['api-key'],configuredKey);
    assert.equal(options.headers['Content-Type'],'application/json');
    assert.ok(options.signal);
    const payload=JSON.parse(options.body);
    assert.deepEqual(payload.sender,{name:'SBAA System',email:'sbaa.chcci.admin@gmail.com'});
    assert.deepEqual(payload.to,[{email:'recipient@example.invalid'}]);
    assert.match(payload.htmlContent,/https:\/\/school\.example\/assets\/sbaa-logo\.png/);
    assert.match(payload.htmlContent,/https:\/\/school\.example\/reset-password\?token=synthetic/);
    assert.match(payload.textContent,/reset-password\?token=synthetic/);
    assert.ok(!options.body.includes(configuredKey));
    return new Response(JSON.stringify({messageId:'synthetic-provider-id'}),{status:201});
  };
  const resetResult=await sendResetMail('recipient@example.invalid','https://school.example/reset-password?token=synthetic');
  assert.equal(resetResult.messageId,'synthetic-provider-id');
  assert.equal(resetResult.statusCode,201);
  assert.equal(calls,1);

  globalThis.fetch=async(url,options)=>{
    calls++;
    assert.equal(url,'https://api.brevo.com/v3/smtp/email');
    const payload=JSON.parse(options.body);
    assert.match(payload.htmlContent,/verify-current-email\?token=synthetic/);
    return new Response(JSON.stringify({messageId:'synthetic-verification-id'}),{status:201});
  };
  assert.equal((await sendCurrentEmailVerificationMail('recipient@example.invalid','https://school.example/verify-current-email?token=synthetic')).messageId,'synthetic-verification-id');
  assert.equal(calls,2);

  globalThis.fetch=async(url,options)=>{
    calls++;
    assert.equal(url,'https://api.brevo.com/v3/smtp/email');
    const payload=JSON.parse(options.body);
    assert.deepEqual(payload.to,[{email:'recipient@example.invalid'}]);
    assert.equal(payload.subject,'SBAA School Portal email delivery test');
    assert.ok(!options.body.includes('token='));
    return new Response(JSON.stringify({messageId:'synthetic-diagnostic-id'}),{status:201});
  };
  assert.equal((await sendBrevoDiagnosticMail('recipient@example.invalid')).messageId,'synthetic-diagnostic-id');
  assert.equal(calls,3);

  for(const status of [400,401,402,403,429]){
    globalThis.fetch=async()=>{calls++;return new Response('provider details must not escape',{status});};
    await assert.rejects(sendResetMail('recipient@example.invalid','https://school.example/reset-password?token=synthetic'),{code:`HTTP_${status}`});
  }
  assert.equal(calls,8,'rejected sends must not be retried or fall back to Resend');

  globalThis.fetch=async()=>{calls++;throw new DOMException('synthetic timeout','TimeoutError');};
  await assert.rejects(sendResetMail('recipient@example.invalid','https://school.example/reset-password?token=synthetic'),{code:'HTTP_UNKNOWN'});
  assert.equal(calls,9,'an ambiguous timeout must not be retried');

  globalThis.fetch=async()=>{calls++;return new Response('{}',{status:201});};
  await assert.rejects(sendResetMail('recipient@example.invalid','https://school.example/reset-password?token=synthetic'),{code:'HTTP_UNKNOWN'});
  assert.equal(calls,10,'an unconfirmed response must not be retried');
}finally{globalThis.fetch=originalFetch;}

console.log('Brevo mail adapter checks passed with mocked provider responses.');
