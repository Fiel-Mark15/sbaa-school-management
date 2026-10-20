import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import 'dotenv/config';
import { pool } from '../database/pool.js';
import { passwordValid } from '../../shared/password-policy.js';

const base=process.env.TEST_API_URL||'http://localhost:5050/api';
assert.equal(passwordValid('Abcdefg!'),true);
assert.equal(passwordValid('ABCDEFG!'),true,'lowercase must not be mandatory');
assert.equal(passwordValid('A!!!!!!?'),true,'digits must not be mandatory');
assert.equal(passwordValid('Abcdefgh'),false,'special character is required');
assert.equal(passwordValid('abcdefg!'),false,'uppercase letter is required');
assert.equal(passwordValid('Abcde!'),false,'eight characters are required');
const seedPassword=process.env.TEST_PASSWORD||process.env.TEST_SEED_PASSWORD;
const adminEmail=process.env.TEST_ADMIN_EMAIL||'admin@schoolportal.test',adminPassword=process.env.TEST_ADMIN_PASSWORD||seedPassword;
async function request(route,{method='GET',token,body}={}){
  const response=await fetch(base+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json()};
}
async function login(email,password){const response=await request('/auth/login',{method:'POST',body:{identifier:email,password}});assert.equal(response.status,200,response.data.message);return response.data.data.token;}
const suffix=String(Date.now()).slice(-8),email=`extended-${suffix}@schoolportal.test`,newEmail=`extended-new-${suffix}@schoolportal.test`,studentNo=`EXT-${suffix}`,newPassword='Abcdefg!';
let userId,studentId,enrollmentId,photoKey,createdPolicy=false,admin,faculty,student;
try{
  admin=await login(adminEmail,adminPassword);faculty=await login('faculty@schoolportal.test',seedPassword);
  assert.equal((await request('/auth/register',{method:'POST',body:{firstName:'Extended',lastName:'Check',studentId:studentNo,email,password:newPassword}})).status,201,'eight-character policy should allow immediate registration');
  const [[account]]=await pool.execute('SELECT id,status FROM users WHERE email=?',[email]);assert.equal(account.status,'ACTIVE');userId=account.id;
  assert.equal((await request('/grades',{token:studentNo})).status,401);
  student=await login(email,newPassword);
  assert.equal((await request('/dashboard/summary',{token:student})).data.data.academicRecordsLinked,false);
  assert.equal((await request('/grades',{token:student})).data.data.length,0,'new account may not inherit another student’s grades');
  const [[studentRecord]]=await pool.execute('SELECT id FROM students WHERE user_id=?',[userId]);studentId=studentRecord.id;
  const assigned=(await request('/academic/offerings',{token:faculty})).data.data[0];assert.ok(assigned);
  const enrollment=await request('/academic/enrollments',{method:'POST',token:admin,body:{studentId,offeringId:assigned.id}});assert.equal(enrollment.status,201,enrollment.data.message);enrollmentId=enrollment.data.data.id;
  const ownClasses=(await request('/academic/offerings',{token:student})).data.data;assert.ok(ownClasses.some(item=>item.id===assigned.id));
  const fake=new FormData();fake.append('photo',new Blob(['<script>alert(1)</script>'],{type:'image/png'}),'fake.png');
  assert.equal((await fetch(base+'/account/photo',{method:'PUT',headers:{Authorization:`Bearer ${student}`},body:fake})).status,422,'disguised image must fail');
  const png=await sharp({create:{width:80,height:80,channels:3,background:'#087f5b'}}).png().toBuffer();
  const image=new FormData();image.append('photo',new Blob([png],{type:'image/png'}),'profile.png');
  assert.equal((await fetch(base+'/account/photo',{method:'PUT',headers:{Authorization:`Bearer ${student}`},body:image})).status,200);
  assert.equal((await fetch(base+'/account/photo',{headers:{Authorization:`Bearer ${student}`}})).status,200);
  assert.ok((await request('/account/profile',{token:student})).data.data.photoVersion);
  const [[photo]]=await pool.execute('SELECT storage_key FROM profile_photos WHERE user_id=?',[userId]);photoKey=photo.storage_key;
  assert.equal((await request('/account/photo',{method:'DELETE',token:student})).status,200);
  assert.equal((await fetch(base+'/account/photo',{headers:{Authorization:`Bearer ${student}`}})).status,404,'removed photo must be inaccessible');
  photoKey=null;
  const policy=(await request('/grades/policy',{token:admin})).data.data;
  if(!policy){assert.equal((await request('/grades/policy',{method:'PUT',token:admin,body:{label:'Temporary test scale',minimum:0,maximum:100,passingValue:50,passDirection:'AT_LEAST',reason:'Automated test; remove after run'}})).status,200);createdPolicy=true;}
  const effective=policy||(await request('/grades/policy',{token:admin})).data.data;
  const gradeValue=Number(effective.minimum);
  assert.equal((await request(`/grades/${enrollmentId}`,{method:'PUT',token:student,body:{value:gradeValue,status:'PUBLISHED'}})).status,403,'student may not assign a grade');
  assert.equal((await request(`/grades/${enrollmentId}`,{method:'PUT',token:faculty,body:{value:gradeValue,status:'DRAFT'}})).status,200);
  const draft=(await request(`/grades?offeringId=${assigned.id}`,{token:admin})).data.data.find(row=>row.enrollmentId===enrollmentId);
  assert.equal((await request(`/grades/${enrollmentId}`,{method:'PUT',token:admin,body:{value:gradeValue}})).status,409,'existing drafts require a version to prevent silent overwrites');
  assert.equal((await request(`/grades/${enrollmentId}`,{method:'PUT',token:admin,body:{value:gradeValue,version:draft.version}})).status,200,'admin may edit a draft through the same workflow');
  assert.equal((await request(`/grades/${enrollmentId}`,{method:'PUT',token:faculty,body:{value:gradeValue,version:draft.version}})).status,409,'stale edits must not overwrite another encoder');
  const [[gradeCount]]=await pool.execute('SELECT COUNT(*) count FROM grade_records WHERE enrollment_id=?',[enrollmentId]);
  assert.equal(gradeCount.count,1,'editing must not create a duplicate grade record');
  assert.ok(!(await request('/grades',{token:student})).data.data.some(row=>row.code===assigned.code),'draft grade must stay private');
  assert.equal((await request(`/grades/${enrollmentId}`,{method:'PUT',token:faculty,body:{value:gradeValue,status:'PUBLISHED'}})).status,422,'legacy status input cannot publish directly');
  assert.equal((await request(`/grades/${enrollmentId}/submit`,{method:'POST',token:student})).status,403,'student cannot submit a grade');
  const submit=await request(`/grades/${enrollmentId}/submit`,{method:'POST',token:faculty});
  if(effective.passingValue==null){assert.equal(submit.status,409,'no grade can be submitted without an approved passing rule');}
  else{
    assert.equal(submit.status,200,submit.data.message);
    assert.ok(!(await request('/grades',{token:student})).data.data.some(row=>row.code===assigned.code),'submitted grade must stay private');
    assert.equal((await request(`/grades/${enrollmentId}/decision`,{method:'POST',token:faculty,body:{decision:'APPROVE'}})).status,403);
    assert.equal((await request(`/grades/${enrollmentId}/decision`,{method:'POST',token:admin,body:{decision:'RETURN',reason:'Controlled review correction'}})).status,200);
    assert.ok(!(await request('/grades',{token:student})).data.data.some(row=>row.code===assigned.code),'returned grade must stay private');
    assert.equal((await request(`/grades/${enrollmentId}/submit`,{method:'POST',token:faculty})).status,200);
    assert.equal((await request(`/grades/${enrollmentId}/decision`,{method:'POST',token:admin,body:{decision:'APPROVE'}})).status,200);
    assert.ok((await request('/grades',{token:student})).data.data.some(row=>row.code===assigned.code),'published own grade should be visible');
    const ownCsv=await fetch(base+'/grades/export.csv',{headers:{Authorization:`Bearer ${student}`}});assert.equal(ownCsv.status,200);assert.match(await ownCsv.text(),new RegExp(studentNo));
    const facultyCsv=await fetch(base+`/grades/export.csv?offeringId=${assigned.id}`,{headers:{Authorization:`Bearer ${faculty}`}});assert.equal(facultyCsv.status,200);assert.match(await facultyCsv.text(),new RegExp(studentNo));
    assert.equal((await request(`/grades/${enrollmentId}`,{method:'PUT',token:faculty,body:{value:gradeValue,status:'DRAFT'}})).status,409,'faculty cannot silently edit published grade');
    assert.equal((await request(`/grades/${enrollmentId}/reopen`,{method:'POST',token:admin,body:{reason:'Verified test correction'}})).status,200);
    assert.ok(!(await request('/grades',{token:student})).data.data.some(row=>row.code===assigned.code),'reopened grade must be hidden until republished');
    const reopened=(await request(`/grades?offeringId=${assigned.id}`,{token:admin})).data.data.find(row=>row.enrollmentId===enrollmentId);
    assert.equal((await request(`/grades/${enrollmentId}`,{method:'PUT',token:admin,body:{value:gradeValue,version:reopened.version}})).status,200,'admin may save a reopened draft');
    assert.equal((await request(`/grades/${enrollmentId}/submit`,{method:'POST',token:admin})).status,200,'admin may submit a draft for review');
    assert.ok(!(await request('/grades',{token:student})).data.data.some(row=>row.code===assigned.code),'admin-submitted grade must stay private');
    assert.equal((await request(`/grades/${enrollmentId}/decision`,{method:'POST',token:admin,body:{decision:'APPROVE'}})).status,200,'admin review publishes the submitted grade');
    assert.ok((await request('/grades',{token:student})).data.data.some(row=>row.code===assigned.code),'only published grades appear to students');
  }
  if(process.env.MAIL_MODE==='development'){
    assert.equal((await request('/account/email-change',{method:'POST',token:student,body:{newEmail,currentPassword:newPassword}})).status,200);
    assert.equal((await request('/auth/me',{token:student})).status,200,'old email/session must work while verification is pending');
    const mail=await readFile(process.env.DEV_MAIL_LOG_PATH || new URL('../dev-mail.log',import.meta.url),'utf8');
    const line=mail.split('\n').findLast(row=>row.includes(`Email change verification for ${newEmail}:`));assert.ok(line);
    const token=new URL(line.match(/https?:\/\/\S+/)?.[0]).searchParams.get('token');assert.ok(token);
    assert.equal((await request(`/auth/email-change/validate?token=${encodeURIComponent(token)}`)).status,200);
    assert.equal((await request(`/auth/email-change/validate?token=${encodeURIComponent(token)}`)).status,200,'preview must not consume token');
    assert.equal((await request('/auth/email-change/confirm',{method:'POST',body:{token}})).status,200);
    assert.equal((await request('/auth/me',{token:student})).status,401,'verified change revokes old sessions');
    assert.equal((await request('/auth/email-change/confirm',{method:'POST',body:{token}})).status,400,'verification token is single-use');
    assert.equal((await request('/auth/login',{method:'POST',body:{identifier:email,password:newPassword}})).status,401,'old email is no longer a login');
    student=await login(newEmail,newPassword);
  }
  assert.equal((await request('/auth/logout',{method:'POST',token:student})).status,200);
  assert.equal((await request('/auth/me',{token:student})).status,401);
  console.log('Extended checks passed: immediate student registration/login, academic isolation, photo safety, draft/published/corrected grade privacy, verified email change, and logout.');
}finally{
  const connection=await pool.getConnection();try{
    await connection.beginTransaction();
    if(userId){
      const [notices]=await connection.execute('SELECT notification_id id FROM notification_recipients WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM notification_recipients WHERE user_id=?',[userId]);
      for(const notice of notices)await connection.execute('DELETE FROM notifications WHERE id=? AND type IN (\'ACCOUNT\',\'ENROLLMENT\',\'GRADE\')',[notice.id]);
      await connection.execute('DELETE FROM grade_records WHERE enrollment_id=?',[enrollmentId||0]);
      await connection.execute('DELETE FROM audit_logs WHERE entity_type=\'enrollments\' AND entity_id=?',[enrollmentId||0]);
      await connection.execute('DELETE FROM enrollments WHERE id=?',[enrollmentId||0]);
      await connection.execute('DELETE FROM email_change_tokens WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM email_verification_tokens WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM password_reset_tokens WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM mail_delivery_events WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM auth_sessions WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM profile_photos WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM profile_contacts WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM audit_logs WHERE user_id=? OR (entity_type=\'users\' AND entity_id=?)',[userId,userId]);
      await connection.execute('DELETE FROM students WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM users WHERE id=? AND external_id=?',[userId,studentNo]);
    }
    if(createdPolicy){await connection.execute('DELETE FROM grading_policy WHERE id=1 AND label=\'Temporary test scale\'');await connection.execute("DELETE FROM audit_logs WHERE action='GRADE_POLICY_CHANGED' AND metadata LIKE '%Automated test; remove after run%'");await connection.execute("DELETE FROM grading_policy_versions WHERE label='Temporary test scale' AND passing_value=50");}
    await connection.commit();
  }catch(error){await connection.rollback();throw error;}finally{connection.release();await pool.end();}
  if(photoKey){const directory=process.env.UPLOAD_DIR?path.resolve(process.env.UPLOAD_DIR):fileURLToPath(new URL('../private-uploads/',import.meta.url));await unlink(path.join(directory,`profile-${photoKey}.webp`)).catch(()=>{});}
}
