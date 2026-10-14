import assert from 'node:assert/strict';
import 'dotenv/config';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { pool } from '../database/pool.js';

const base=process.env.TEST_API_URL||'http://localhost:5050/api';
const password=process.env.TEST_PASSWORD||process.env.TEST_SEED_PASSWORD;
const adminEmail=process.env.TEST_ADMIN_EMAIL||'admin@schoolportal.test',adminPassword=process.env.TEST_ADMIN_PASSWORD||password;
const suffix=Date.now().toString(36),email=`refine-${suffix}@schoolportal.test`,studentNo=`RF-${suffix}`;
let userId=null,protectedId=null,firmId=null;
async function request(route,{method='GET',token,body,binary=false}={}){
  const response=await fetch(base+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,headers:response.headers,data:binary?Buffer.from(await response.arrayBuffer()):await response.json()};
}
async function login(identifier,secret){const result=await request('/auth/login',{method:'POST',body:{identifier,password:secret}});assert.equal(result.status,200,result.data.message);return result.data.data.token;}
try{
  const admin=await login(adminEmail,adminPassword),student=await login('student@schoolportal.test',password),faculty=await login('faculty@schoolportal.test',password);
  const [[adminRow]]=await pool.execute('SELECT id FROM users WHERE email=?',[adminEmail]);
  const registration=await request('/auth/register',{method:'POST',body:{firstName:'Refinement',lastName:'Test',studentId:studentNo,email,password:'Refinement!2026'}});assert.equal(registration.status,201,registration.data.message);
  const [[created]]=await pool.execute('SELECT id FROM users WHERE email=?',[email]);userId=created.id;
  const temporaryToken=await login(email,'Refinement!2026');
  assert.equal((await request(`/account/users/${userId}`,{method:'DELETE',token:admin,body:{reason:'Test cleanup',currentPassword:'incorrect'}})).status,403);
  assert.equal((await request(`/account/users/${userId}`,{method:'DELETE',token:admin,body:{reason:'Test cleanup',currentPassword:adminPassword}})).status,409);
  assert.equal((await request(`/account/users/${adminRow.id}`,{method:'DELETE',token:admin,body:{reason:'Test cleanup',currentPassword:adminPassword}})).status,409);
  assert.equal((await request(`/account/users/${userId}/status`,{method:'PATCH',token:admin,body:{status:'ARCHIVED',reason:'Refinement test'}})).status,200);
  const attempts=await Promise.all([request(`/account/users/${userId}`,{method:'DELETE',token:admin,body:{reason:'Erroneous test account',currentPassword:adminPassword}}),request(`/account/users/${userId}`,{method:'DELETE',token:admin,body:{reason:'Erroneous test account',currentPassword:adminPassword}})]);
  assert.deepEqual(attempts.map(item=>item.status).sort(),[200,404]);
  assert.equal((await request('/account/profile',{token:temporaryToken})).status,401);
  const [[audit]]=await pool.execute("SELECT COUNT(*) total FROM audit_logs WHERE entity_type='users' AND entity_id=?",[userId]);assert.ok(audit.total>0);

  const protectedEmail=`protected-${suffix}@schoolportal.test`;
  const second=await request('/auth/register',{method:'POST',body:{firstName:'Protected',lastName:'Test',studentId:`RP-${suffix}`,email:protectedEmail,password:'Refinement!2026'}});assert.equal(second.status,201,second.data.message);
  const [[protectedUser]]=await pool.execute('SELECT id FROM users WHERE email=?',[protectedEmail]);protectedId=protectedUser.id;
  const [[offering]]=await pool.query("SELECT id FROM subject_offerings WHERE status='ACTIVE' LIMIT 1");assert.ok(offering);
  await pool.execute("INSERT INTO enrollments(student_id,offering_id,status) SELECT id,?,'ENROLLED' FROM students WHERE user_id=?",[offering.id,protectedId]);
  assert.equal((await request(`/account/users/${protectedId}/status`,{method:'PATCH',token:admin,body:{status:'ARCHIVED',reason:'Refinement protected test'}})).status,200);
  const protectedResult=await request(`/account/users/${protectedId}`,{method:'DELETE',token:admin,body:{reason:'Protected test',currentPassword:adminPassword}});assert.equal(protectedResult.status,409);assert.match(protectedResult.data.message,/enrollment|protected/i);
  await pool.execute('DELETE FROM enrollments WHERE student_id=(SELECT id FROM students WHERE user_id=?)',[protectedId]);
  assert.equal((await request(`/account/users/${protectedId}`,{method:'DELETE',token:admin,body:{reason:'Temporary test cleanup',currentPassword:adminPassword}})).status,200);

  const firm=await request('/firms',{method:'POST',token:admin,body:{name:`Refinement ${suffix}`,category:'Test',description:'Temporary quality assurance entry.',publicAddress:'',publicContact:'',website:'https://example.com',status:'DRAFT'}});assert.equal(firm.status,201,firm.data.message);firmId=firm.data.data.id;
  const updated=await request(`/firms/${firmId}`,{method:'PATCH',token:admin,body:{name:`Updated ${suffix}`,category:'Test',description:'Temporary quality assurance entry.',publicAddress:'',publicContact:'',website:'https://example.com',status:'PUBLISHED'}});assert.equal(updated.status,200,updated.data.message);
  const [[saved]]=await pool.execute('SELECT name,status FROM firms WHERE id=?',[firmId]);assert.equal(saved.name,`Updated ${suffix}`);assert.equal(saved.status,'PUBLISHED');
  assert.equal((await request(`/firms/${firmId}`,{method:'DELETE',token:student,body:{reason:'QA'}})).status,403);
  assert.equal((await request(`/firms/${firmId}`,{method:'DELETE',token:admin,body:{reason:'Temporary QA record'}})).status,409);
  const archived=await request(`/firms/${firmId}`,{method:'PATCH',token:admin,body:{name:`Updated ${suffix}`,category:'Test',description:'Temporary quality assurance entry.',publicAddress:'',publicContact:'',website:'https://example.com',status:'ARCHIVED'}});assert.equal(archived.status,200,archived.data.message);
  assert.equal((await request(`/firms/${firmId}`,{method:'DELETE',token:admin,body:{reason:'Temporary QA record'}})).status,200);
  assert.equal((await request(`/firms/${firmId}`,{method:'DELETE',token:admin,body:{reason:'Temporary QA record'}})).status,404);

  const [[term]]=await pool.query('SELECT id FROM academic_terms WHERE is_current=1 LIMIT 1');assert.ok(term);
  for(const [role,token] of [['admin',admin],['faculty',faculty],['student',student]]){
    const displayed=await request(`/schedule/meetings?termId=${term.id}`,{token});assert.equal(displayed.status,200);
    const expected=displayed.data.data.length;
    const forbidden=await request(`/schedule/export/xlsx?termId=${term.id}&sectionId=1`,{token:role==='admin'?student:token});if(role!=='admin')assert.equal(forbidden.status,422);
    if(!expected)continue;
    const xlsx=await request(`/schedule/export/xlsx?termId=${term.id}`,{token,binary:true});assert.equal(xlsx.status,200);assert.match(xlsx.headers.get('content-type'),/spreadsheetml/);
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(xlsx.data);assert.equal(workbook.getWorksheet('Meeting rows').rowCount-4,expected);
    const ics=await request(`/schedule/export/ics?termId=${term.id}`,{token,binary:true});assert.equal(ics.status,200);assert.equal((ics.data.toString().match(/BEGIN:VEVENT/g)||[]).length,expected);
    const jpg=await request(`/schedule/export/jpg?termId=${term.id}`,{token,binary:true});assert.equal(jpg.status,200);assert.equal((await sharp(jpg.data).metadata()).format,'jpeg');
  }
  assert.equal((await request('/schedule/export/xlsx',{token:admin})).status,422);
  const about=await request('/about',{token:student});assert.equal(about.status,200);assert.ok(['PUBLISHED','UNAVAILABLE'].includes(about.data.data.status));
  const unapproved=await request('/about',{method:'PUT',token:admin,body:{overview:'Unapproved',history:'',mission:'',vision:'',departmentValues:'',programs:'',services:'',contact:'',status:'PUBLISHED',approved:false}});assert.equal(unapproved.status,422);
  console.log('Refinement checks passed: archived-only deletion, protected-record conflict, reauthentication, concurrency, stale session, preserved audit, firm persistence/deletion, role-scoped ICS/XLSX/JPG.');
}finally{
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    if(firmId){await connection.execute("DELETE FROM audit_logs WHERE entity_type='firms' AND entity_id=?",[firmId]);await connection.execute('DELETE FROM firms WHERE id=?',[firmId]);}
    for(const id of [userId,protectedId].filter(Boolean)){await connection.execute("DELETE FROM audit_logs WHERE entity_type='users' AND entity_id=?",[id]);await connection.execute('DELETE FROM enrollments WHERE student_id=(SELECT id FROM students WHERE user_id=?)',[id]);await connection.execute('DELETE FROM notification_recipients WHERE user_id=?',[id]);await connection.execute('DELETE FROM auth_sessions WHERE user_id=?',[id]);await connection.execute('DELETE FROM password_reset_tokens WHERE user_id=?',[id]);await connection.execute('DELETE FROM email_change_tokens WHERE user_id=?',[id]);await connection.execute('DELETE FROM mail_delivery_events WHERE user_id=?',[id]);await connection.execute('DELETE FROM profile_contacts WHERE user_id=?',[id]);await connection.execute('DELETE FROM profile_photos WHERE user_id=?',[id]);await connection.execute('DELETE FROM students WHERE user_id=?',[id]);await connection.execute('DELETE FROM users WHERE id=?',[id]);}
    await connection.commit();
  }catch(error){await connection.rollback();throw error;}finally{connection.release();await pool.end();}
}
