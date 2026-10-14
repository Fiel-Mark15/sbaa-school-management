import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import 'dotenv/config';
import { pool } from '../database/pool.js';
import { hashPassword } from '../utils/password.js';

const base=process.env.TEST_API_URL||'http://localhost:5050/api';
const fixturePassword=process.env.TEST_PASSWORD||process.env.TEST_SEED_PASSWORD;
const adminEmail=process.env.TEST_ADMIN_EMAIL||'admin@schoolportal.test',adminPassword=process.env.TEST_ADMIN_PASSWORD||fixturePassword;
const suffix=randomBytes(5).toString('hex');
const originalEmail=`portal-check-${suffix}@schoolportal.test`;
const updatedEmail=`portal-verified-${suffix}@schoolportal.test`;
const studentNo=`MC-${suffix}`;
const studentPassword='QualityCheck!2026';
let userId,secondUserId,facultyUserId,announcementId,photoKey,imageKey;

async function request(route,{method='GET',token,body}={}){
  const form=body instanceof FormData;
  const response=await fetch(base+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body&&!form?{'Content-Type':'application/json'}:{})},body:body?(form?body:JSON.stringify(body)):undefined});
  return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():Buffer.from(await response.arrayBuffer())};
}
async function login(identifier,password){const result=await request('/auth/login',{method:'POST',body:{identifier,password}});assert.equal(result.status,200,result.data.message);return result.data.data.token;}

try{
  const admin=await login(adminEmail,adminPassword);
  const registration=await request('/auth/register',{method:'POST',body:{firstName:'Portal',lastName:'Check',studentId:studentNo,email:originalEmail,password:studentPassword}});
  assert.equal(registration.status,201,registration.data.message);
  const [[created]]=await pool.execute('SELECT id FROM users WHERE email=?',[originalEmail]);userId=created.id;
  const student=await login(originalEmail,studentPassword);

  assert.equal((await request('/account/profile',{method:'PATCH',token:student,body:{phone:'+639123456789',receiveOptionalNotifications:false}})).status,200);
  assert.equal((await request('/account/theme',{method:'PATCH',token:student,body:{theme:'dark'}})).status,200);
  const profile=await request('/account/profile',{token:student});
  assert.equal(profile.data.data.phone,'+639123456789');assert.equal(profile.data.data.themePreference,'dark');

  const pixels=randomBytes(1600*1600*3);
  const largePhoto=await sharp(pixels,{raw:{width:1600,height:1600,channels:3}}).png({compressionLevel:0}).toBuffer();
  assert.ok(largePhoto.length>3*1024*1024&&largePhoto.length<10*1024*1024);
  const photoForm=new FormData();photoForm.append('photo',new Blob([largePhoto],{type:'image/png'}),'photo.png');
  assert.equal((await request('/account/photo',{method:'PUT',token:student,body:photoForm})).status,200);
  const [[savedPhoto]]=await pool.execute('SELECT storage_key storageKey FROM profile_photos WHERE user_id=?',[userId]);photoKey=savedPhoto.storageKey;
  assert.equal((await request('/account/photo',{token:student})).status,200);
  assert.equal((await request(`/account/users/${userId}/photo`,{token:admin})).status,200);
  assert.equal((await request(`/account/users/${userId}/photo`,{token:student})).status,403);
  const accountList=await request('/account/users',{token:admin});
  assert.equal(accountList.data.data.rows.find(row=>row.id===userId)?.hasPhoto,1);
  const tooLarge=new FormData();tooLarge.append('photo',new Blob([randomBytes(10*1024*1024+1)],{type:'image/png'}),'oversize.png');
  assert.equal((await request('/account/photo',{method:'PUT',token:student,body:tooLarge})).status,422);
  const [[unchangedPhoto]]=await pool.execute('SELECT storage_key storageKey FROM profile_photos WHERE user_id=?',[userId]);assert.equal(unchangedPhoto.storageKey,photoKey);

  const otherSession=await login(originalEmail,studentPassword);
  const sessions=await request('/account/sessions',{token:student});assert.equal(sessions.status,200);
  const other=sessions.data.data.rows.find(row=>!row.current);assert.ok(other);
  assert.equal((await request(`/account/sessions/${other.id}/revoke`,{method:'PATCH',token:student})).status,200);
  assert.equal((await request('/account/profile',{token:otherSession})).status,401);

  const pendingToken=randomBytes(32).toString('base64url');
  await pool.execute('INSERT INTO email_change_tokens(user_id,pending_email,token_digest,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))',[userId,updatedEmail,createHash('sha256').update(pendingToken).digest('hex')]);
  assert.equal((await request('/account/email-change/pending',{token:student})).data.data.pending.pendingEmail,updatedEmail);
  assert.equal((await request('/account/email-change/pending',{method:'DELETE',token:student})).status,200);
  assert.equal((await request('/auth/email-change/validate?token='+pendingToken)).status,400);
  const verifyToken=randomBytes(32).toString('base64url');
  await pool.execute('INSERT INTO email_change_tokens(user_id,pending_email,token_digest,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))',[userId,updatedEmail,createHash('sha256').update(verifyToken).digest('hex')]);
  assert.equal((await request('/auth/email-change/confirm',{method:'POST',body:{token:verifyToken}})).status,200);
  assert.equal((await request('/auth/email-change/confirm',{method:'POST',body:{token:verifyToken}})).status,400);
  assert.equal((await request('/account/profile',{token:student})).status,401);
  assert.equal((await request('/auth/login',{method:'POST',body:{identifier:originalEmail,password:studentPassword}})).status,401);
  const verifiedSession=await login(updatedEmail,studentPassword);

  const secondEmail=`portal-other-${suffix}@schoolportal.test`;
  const secondRegistration=await request('/auth/register',{method:'POST',body:{firstName:'Other',lastName:'Recipient',studentId:`MO-${suffix}`,email:secondEmail,password:studentPassword}});
  assert.equal(secondRegistration.status,201,secondRegistration.data.message);
  const [[secondCreated]]=await pool.execute('SELECT id FROM users WHERE email=?',[secondEmail]);secondUserId=secondCreated.id;
  const secondSession=await login(secondEmail,studentPassword);

  const requestId=randomUUID();
  const draft={title:`Portal check ${suffix}`,content:'Private controlled draft.',priority:'NORMAL',audienceRoles:['STUDENT'],recipientUserIds:[userId],publish:false,requestId};
  const posted=await request('/notifications/announcements',{method:'POST',token:admin,body:draft});assert.equal(posted.status,201,posted.data.message);announcementId=posted.data.data.id;
  const retry=await request('/notifications/announcements',{method:'POST',token:admin,body:draft});assert.equal(retry.data.data.id,announcementId);
  const imageForm=new FormData();imageForm.append('image',new Blob([await sharp({create:{width:320,height:180,channels:3,background:'#087f5b'}}).png().toBuffer()],{type:'image/png'}),'notice.png');
  assert.equal((await request(`/notifications/announcements/${announcementId}/image`,{method:'PUT',token:admin,body:imageForm})).status,200);
  const [[asset]]=await pool.execute('SELECT storage_key storageKey FROM announcement_images WHERE announcement_id=?',[announcementId]);imageKey=asset.storageKey;
  assert.equal((await request(`/notifications/announcements/${announcementId}/image`,{token:admin})).status,200);
  assert.equal((await request(`/notifications/announcements/${announcementId}/image`,{token:verifiedSession})).status,404);
  const [[recipientCount]]=await pool.execute("SELECT COUNT(*) total FROM notifications WHERE resource_type='announcement' AND resource_id=?",[announcementId]);assert.equal(recipientCount.total,0);
  assert.equal((await request(`/notifications/announcements/${announcementId}/status`,{method:'PATCH',token:admin,body:{status:'PUBLISHED'}})).status,200);
  const [[distribution]]=await pool.execute("SELECT COUNT(*) total FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id WHERE n.resource_type='announcement' AND n.resource_id=?",[announcementId]);assert.equal(distribution.total,1);
  assert.equal((await request(`/notifications/announcements/${announcementId}/status`,{method:'PATCH',token:admin,body:{status:'PUBLISHED'}})).status,409);
  assert.equal((await request(`/notifications/announcements/${announcementId}/image`,{token:verifiedSession})).status,200);
  assert.equal((await request(`/notifications/announcements/${announcementId}/image`,{token:secondSession})).status,404);
  const intended=await request('/notifications',{token:verifiedSession});
  const unintended=await request('/notifications',{token:secondSession});
  assert.ok(intended.data.data.rows.some(row=>row.resourceId===announcementId&&row.hasImage));
  assert.ok(!unintended.data.data.rows.some(row=>row.resourceId===announcementId));
  assert.ok((await request('/notifications/announcements',{token:verifiedSession})).data.data.some(row=>row.id===announcementId));
  assert.ok(!(await request('/notifications/announcements',{token:secondSession})).data.data.some(row=>row.id===announcementId));
  assert.equal((await request(`/account/users/${secondUserId}/status`,{method:'PATCH',token:admin,body:{status:'ARCHIVED',reason:'Controlled deletion test'}})).status,200);
  assert.equal((await request(`/account/users/${secondUserId}`,{method:'DELETE',token:admin,body:{reason:'Controlled deletion test',currentPassword:adminPassword}})).status,200);
  assert.equal((await request('/account/profile',{token:secondSession})).status,401);
  assert.equal((await pool.execute('SELECT COUNT(*) total FROM users WHERE id=?',[secondUserId]))[0][0].total,0);
  secondUserId=undefined;

  const facultyEmail=`portal-faculty-${suffix}@schoolportal.test`,facultyExternalId=`FC-${suffix}`;
  const [createdFaculty]=await pool.execute("INSERT INTO users(external_id,email,password_hash,role,first_name,last_name,status) VALUES (?,?,?,'FACULTY','Controlled','Faculty','ACTIVE')",[facultyExternalId,facultyEmail,await hashPassword(studentPassword)]);
  facultyUserId=createdFaculty.insertId;
  await pool.execute('INSERT INTO faculty(user_id,faculty_no,position) VALUES (?,?,?)',[facultyUserId,facultyExternalId,'Test position']);
  const facultySession=await login(facultyEmail,studentPassword);
  assert.equal((await request(`/account/users/${facultyUserId}/status`,{method:'PATCH',token:admin,body:{status:'ARCHIVED',reason:'Controlled deletion test'}})).status,200);
  assert.equal((await request(`/account/users/${facultyUserId}`,{method:'DELETE',token:admin,body:{reason:'Controlled deletion test',currentPassword:adminPassword}})).status,200);
  assert.equal((await request('/account/profile',{token:facultySession})).status,401);
  assert.equal((await pool.execute('SELECT COUNT(*) total FROM users WHERE id=?',[facultyUserId]))[0][0].total,0);
  facultyUserId=undefined;
  console.log('Master prompt checks passed: photo limit and replacement safety, profile persistence, session revocation, pending email controls, atomic login-email verification, private draft image, targeted published notification and image permissions, eligible student and faculty deletion.');
}finally{
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    if(announcementId){await connection.execute('DELETE nr FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id WHERE n.resource_type=\'announcement\' AND n.resource_id=?',[announcementId]);await connection.execute("DELETE FROM notifications WHERE resource_type='announcement' AND resource_id=?",[announcementId]);await connection.execute('DELETE FROM announcement_images WHERE announcement_id=?',[announcementId]);await connection.execute("DELETE FROM audit_logs WHERE entity_type='announcements' AND entity_id=?",[announcementId]);await connection.execute('DELETE FROM announcements WHERE id=?',[announcementId]);}
    if(secondUserId){await connection.execute('DELETE FROM auth_sessions WHERE user_id=?',[secondUserId]);await connection.execute("DELETE FROM audit_logs WHERE user_id=? OR (entity_type='users' AND entity_id=?)",[secondUserId,secondUserId]);await connection.execute('DELETE FROM profile_contacts WHERE user_id=?',[secondUserId]);await connection.execute('DELETE FROM students WHERE user_id=?',[secondUserId]);await connection.execute('DELETE FROM users WHERE id=?',[secondUserId]);}
    if(facultyUserId){await connection.execute('DELETE FROM auth_sessions WHERE user_id=?',[facultyUserId]);await connection.execute("DELETE FROM audit_logs WHERE user_id=? OR (entity_type='users' AND entity_id=?)",[facultyUserId,facultyUserId]);await connection.execute('DELETE FROM faculty WHERE user_id=?',[facultyUserId]);await connection.execute('DELETE FROM users WHERE id=?',[facultyUserId]);}
    if(userId){await connection.execute('DELETE FROM notification_recipients WHERE user_id=?',[userId]);await connection.execute('DELETE FROM auth_sessions WHERE user_id=?',[userId]);await connection.execute('DELETE FROM email_change_tokens WHERE user_id=?',[userId]);await connection.execute('DELETE FROM mail_delivery_events WHERE user_id=?',[userId]);await connection.execute("DELETE FROM audit_logs WHERE user_id=? OR (entity_type='users' AND entity_id=?)",[userId,userId]);await connection.execute('DELETE FROM profile_photos WHERE user_id=?',[userId]);await connection.execute('DELETE FROM profile_contacts WHERE user_id=?',[userId]);await connection.execute('DELETE FROM students WHERE user_id=?',[userId]);await connection.execute('DELETE FROM users WHERE id=?',[userId]);}
    await connection.commit();
  }catch(error){await connection.rollback();throw error;}finally{connection.release();await pool.end();}
  if(photoKey)await unlink(path.join(process.env.UPLOAD_DIR||new URL('../private-uploads/',import.meta.url).pathname,`profile-${photoKey}.webp`)).catch(()=>{});
  if(imageKey)await unlink(path.join(process.env.UPLOAD_DIR||new URL('../private-uploads/',import.meta.url).pathname,`announcement-${imageKey}.webp`)).catch(()=>{});
}
