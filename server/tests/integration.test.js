import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'dotenv/config';
import { pool } from '../database/pool.js';
import { digest } from '../utils/sessions.js';

const base=process.env.TEST_API_URL||'http://localhost:5050/api';
const password=process.env.TEST_PASSWORD||process.env.TEST_SEED_PASSWORD;
const adminEmail=process.env.TEST_ADMIN_EMAIL||'admin@schoolportal.test',adminPassword=process.env.TEST_ADMIN_PASSWORD||password;
async function request(path,{method='GET',token,body}={}){
  const response=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
}
async function signIn(email,credential=password){const result=await request('/auth/login',{method:'POST',body:{identifier:email,password:credential}});assert.equal(result.status,200,`${email} login failed: ${result.body.message}`);return result.body.data.token;}

const admin=await signIn(adminEmail,adminPassword);
const faculty=await signIn('faculty@schoolportal.test');
const student=await signIn('student@schoolportal.test');
assert.equal((await request('/auth/login',{method:'POST',body:{identifier:'student@schoolportal.test',password:'wrong'}})).status,401);
assert.equal((await request('/account/users',{token:student})).status,403);
assert.equal((await request('/account/users',{token:faculty})).status,403);
assert.equal((await request('/account/users')).status,401);
const students=(await request('/academic/offerings',{token:student})).body.data;
const teachers=(await request('/academic/offerings',{token:faculty})).body.data;
assert.ok(students.length>0,'seeded student should have enrolled subjects');
assert.ok(teachers.length>0,'seeded faculty should have assigned subjects');
assert.equal((await request('/academic/offerings/999999/roster',{token:faculty})).status,404);
for(const token of [admin,faculty,student]){
  assert.equal((await request('/dashboard/summary',{token})).status,200);
  assert.equal((await request('/schedule/meetings',{token})).status,200);
  assert.equal((await request('/notifications',{token})).status,200);
}
const offerings=(await request('/academic/offerings',{token:admin})).body.data;
const rooms=(await request('/schedule/rooms',{token:admin})).body.data;
const testOffering=offerings.find(o=>o.code==='MKT101');
const room=rooms.find(r=>r.code==='B101');
assert.ok(testOffering&&room,'seeded offering and room are required');
const conflicting={offeringId:testOffering.id,roomId:room.id,weekday:2,startTime:'09:30',endTime:'10:00'};
assert.equal((await request('/schedule/meetings',{method:'POST',token:admin,body:conflicting})).status,409,'overlap must be rejected');
const backToBack={...conflicting,startTime:'10:30',endTime:'11:00'};
const accepted=await request('/schedule/meetings',{method:'POST',token:admin,body:backToBack});
assert.equal(accepted.status,201,`back-to-back class should be accepted: ${accepted.body.message}`);
await request(`/schedule/meetings/${accepted.body.data.id}/archive`,{method:'PATCH',token:admin});
const sameSlot={...conflicting,startTime:'13:00',endTime:'13:30'};
const simultaneous=await Promise.all([request('/schedule/meetings',{method:'POST',token:admin,body:sameSlot}),request('/schedule/meetings',{method:'POST',token:admin,body:sameSlot})]);
assert.deepEqual(simultaneous.map(r=>r.status).sort(),[201,409],'concurrent conflicting writes must serialize');
const created=simultaneous.find(r=>r.status===201);
await request(`/schedule/meetings/${created.body.data.id}/archive`,{method:'PATCH',token:admin});
const inbox=(await request('/notifications',{token:student})).body.data.rows;
assert.ok(inbox.some(n=>n.type==='SCHEDULE'),'schedule change should notify enrolled student');
const notice=inbox.find(n=>n.type==='SCHEDULE');
assert.equal((await request(`/notifications/${notice.id}/read`,{method:'PATCH',token:admin})).status,404,'other recipient cannot mark read');
assert.equal((await request(`/notifications/${notice.id}/read`,{method:'PATCH',token:student})).status,200);
const inboxAfter=(await request('/notifications',{token:student})).body.data.rows;
assert.ok(inboxAfter.find(n=>n.id===notice.id)?.readAt,'read state must persist');
const testMeetingIds=[accepted.body.data.id,created.body.data.id];
const cleanup=await pool.getConnection();
try{
  await cleanup.beginTransaction();
  for(const meetingId of testMeetingIds){
    await cleanup.execute("DELETE nr FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id WHERE n.resource_type='schedule' AND n.resource_id=?",[meetingId]);
    await cleanup.execute("DELETE FROM notifications WHERE resource_type='schedule' AND resource_id=?",[meetingId]);
    await cleanup.execute("DELETE FROM audit_logs WHERE entity_type='schedule_meetings' AND entity_id=? AND action IN ('SCHEDULE_CREATED','SCHEDULE_ARCHIVED')",[meetingId]);
    await cleanup.execute("DELETE FROM schedule_meetings WHERE id=? AND status='ARCHIVED'",[meetingId]);
  }
  await cleanup.commit();
}catch(error){await cleanup.rollback();throw error;}finally{cleanup.release();}
if(process.env.MAIL_MODE==='development'){
  const suffix=String(Date.now()).slice(-8),email=`reset-${suffix}@schoolportal.test`,studentId=`TEST-${suffix}`;
  const registration=await request('/auth/register',{method:'POST',body:{firstName:'Reset',middleName:'María-José',lastName:'Check',studentId,email,password:'InitialPass2026!'}});
  assert.equal(registration.status,201);
  const weak=await request('/auth/register',{method:'POST',body:{firstName:'Reset',lastName:'Check',studentId:`BAD-${suffix}`,email:`bad-${suffix}@schoolportal.test`,password:'lowercase!'}});
  assert.equal(weak.status,422,'uppercase requirement must be enforced by the API');
  assert.equal((await request('/auth/login',{method:'POST',body:{identifier:email,password:'InitialPass2026!'}})).status,200,'new student must sign in immediately');
  const accounts=(await request(`/account/users?search=${encodeURIComponent(email)}`,{token:admin})).body.data.rows;
  const account=accounts.find(u=>u.email===email);assert.ok(account);
  assert.equal(account.middleName,'María-José','middle name should persist in admin results');
  const [[stored]]=await pool.execute('SELECT password_hash,middle_name FROM users WHERE id=?',[account.id]);
  assert.equal(stored.middle_name,'María-José');assert.ok(stored.password_hash.startsWith('$scrypt$'),'new passwords use scrypt while seeded bcrypt login still works');
  assert.equal(account.status,'ACTIVE','new student must be active without an approval action');
  const original=await signIn(email,'InitialPass2026!');
  assert.equal((await request('/account/profile',{token:original})).body.data.middleName,'María-José');
  assert.equal((await request('/auth/forgot-password',{method:'POST',body:{email}})).status,200);
  const diagnostics=await request(`/admin/mail-diagnostics?email=${encodeURIComponent(email)}`,{token:admin});
  assert.equal(diagnostics.status,200);assert.equal(diagnostics.body.data.account.status,'ACTIVE');
  assert.ok(diagnostics.body.data.events.some(event=>event.outcome==='DEVELOPMENT_LOG'),'development logging must be distinguishable from SMTP acceptance');
  assert.equal((await request('/admin/mail-diagnostics',{token:original})).status,403,'mail diagnostics must be admin-only');
  const mail=await readFile(process.env.DEV_MAIL_LOG_PATH || new URL('../dev-mail.log',import.meta.url),'utf8');
  const line=mail.split('\n').findLast(row=>row.includes(email));
  assert.ok(line,'development mail should contain the reset link');
  const resetToken=new URL(line.match(/https?:\/\/\S+/)?.[0]).searchParams.get('token');
  assert.ok(resetToken);
  assert.equal((await request(`/auth/reset-password/validate?token=${encodeURIComponent(resetToken)}`)).status,200,'link preview must not consume token');
  await pool.execute('UPDATE password_reset_tokens SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE token_digest=?',[digest(resetToken)]);
  assert.equal((await request(`/auth/reset-password/validate?token=${encodeURIComponent(resetToken)}`)).status,400,'expired link must fail validation');
  assert.equal((await request('/auth/forgot-password',{method:'POST',body:{email}})).status,200);
  const newerMail=await readFile(process.env.DEV_MAIL_LOG_PATH || new URL('../dev-mail.log',import.meta.url),'utf8');
  const newerLine=newerMail.split('\n').findLast(row=>row.includes(`Password reset for ${email}:`));
  const currentToken=new URL(newerLine.match(/https?:\/\/\S+/)?.[0]).searchParams.get('token');
  assert.ok(currentToken&&currentToken!==resetToken);
  assert.equal((await request(`/auth/reset-password/validate?token=${encodeURIComponent(currentToken)}`)).status,200);
  const race=await Promise.all([request('/auth/reset-password',{method:'POST',body:{token:currentToken,password:'UpdatedPass2026!'}}),request('/auth/reset-password',{method:'POST',body:{token:currentToken,password:'UpdatedPass2026!'}})]);
  assert.deepEqual(race.map(item=>item.status).sort(),[200,400],'only one concurrent reset may consume the token');
  assert.equal((await request(`/auth/reset-password/validate?token=${encodeURIComponent(currentToken)}`)).status,400,'used link must no longer validate');
  assert.equal((await request('/auth/me',{token:original})).status,401,'password reset must revoke sessions');
  assert.equal((await request('/auth/reset-password',{method:'POST',body:{token:currentToken,password:'UpdatedPass2026!'}})).status,400,'reset link must be single use');
  assert.equal((await request('/auth/login',{method:'POST',body:{identifier:email,password:'InitialPass2026!'}})).status,401);
  const updated=await signIn(email,'UpdatedPass2026!');await request('/auth/logout',{method:'POST',token:updated});
  await request(`/account/users/${account.id}/status`,{method:'PATCH',token:admin,body:{status:'DISABLED',reason:'End temporary test account'}});
  const cleanupAccount=await pool.getConnection();
  try{
    await cleanupAccount.beginTransaction();
    const [check]=await cleanupAccount.execute("SELECT id FROM users WHERE id=? AND email=? AND status='DISABLED'",[account.id,email]);
    assert.equal(check.length,1,'only the disabled test account may be removed');
    await cleanupAccount.execute("DELETE nr FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id WHERE n.resource_type='profile' AND n.resource_id=?",[account.id]);
    await cleanupAccount.execute("DELETE FROM notifications WHERE resource_type='profile' AND resource_id=?",[account.id]);
    await cleanupAccount.execute('DELETE FROM notification_recipients WHERE user_id=?',[account.id]);
    await cleanupAccount.execute('DELETE FROM password_reset_tokens WHERE user_id=?',[account.id]);
    await cleanupAccount.execute('DELETE FROM email_verification_tokens WHERE user_id=?',[account.id]);
    await cleanupAccount.execute('DELETE FROM mail_delivery_events WHERE user_id=?',[account.id]);
    await cleanupAccount.execute('DELETE FROM email_change_tokens WHERE user_id=?',[account.id]);
    await cleanupAccount.execute('DELETE FROM auth_sessions WHERE user_id=?',[account.id]);
    await cleanupAccount.execute('DELETE FROM audit_logs WHERE user_id=? OR (entity_type=\'users\' AND entity_id=?)',[account.id,account.id]);
    await cleanupAccount.execute('DELETE FROM students WHERE user_id=?',[account.id]);
    await cleanupAccount.execute('DELETE FROM users WHERE id=?',[account.id]);
    await cleanupAccount.commit();
  }catch(error){await cleanupAccount.rollback();throw error;}finally{cleanupAccount.release();}
}
assert.equal((await request('/auth/logout',{method:'POST',token:student})).status,200);
assert.equal((await request('/auth/me',{token:student})).status,401,'logout must revoke the session');
await request('/auth/logout',{method:'POST',token:faculty});
await request('/auth/logout',{method:'POST',token:admin});
await pool.end();
console.log(`Integration checks passed: roles, scoped data, dashboards, schedule conflicts, notifications, and logout revocation${process.env.MAIL_MODE==='development'?', plus development-adapter reset expiry/concurrency':'; reset email tests skipped outside development mail mode'}.`);
