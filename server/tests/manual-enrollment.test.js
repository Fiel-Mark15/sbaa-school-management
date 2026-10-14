import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pool } from '../database/pool.js';

const base=process.env.TEST_API_URL||'http://localhost:5050/api';
const password=process.env.TEST_PASSWORD||process.env.TEST_SEED_PASSWORD;
const adminEmail=process.env.TEST_ADMIN_EMAIL||'admin@schoolportal.test',adminPassword=process.env.TEST_ADMIN_PASSWORD||password;
const studentNo=`MAN-${randomBytes(5).toString('hex')}`;
let studentId,enrollmentId;
async function request(route,{method='GET',token,body}={}){const response=await fetch(base+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
try{
  const login=await request('/auth/login',{method:'POST',body:{identifier:adminEmail,password:adminPassword}});assert.equal(login.status,200,login.data.message);const token=login.data.data.token;
  const [[offering]]=await pool.execute("SELECT id,section_id sectionId FROM subject_offerings WHERE status='ACTIVE' LIMIT 1");assert.ok(offering);
  const body={firstName:'Manual',middleName:'Controlled',lastName:'Student',studentNo,email:'',contactNumber:'',birthDate:'2002-05-14',sectionId:offering.sectionId,offeringId:offering.id};
  const created=await request('/academic/students/manual-enroll',{method:'POST',token,body});assert.equal(created.status,201,created.data.message);studentId=created.data.data.studentId;enrollmentId=created.data.data.enrollmentId;
  const [[record]]=await pool.execute('SELECT user_id,student_no,manual_first_name,birth_date FROM students WHERE id=?',[studentId]);assert.equal(record.user_id,null);assert.equal(record.student_no,studentNo);assert.equal(record.manual_first_name,'Manual');
  const roster=await request(`/academic/offerings/${offering.id}/roster`,{token});assert.ok(roster.data.data.some(row=>row.id===enrollmentId&&row.firstName==='Manual'));
  const grades=await request(`/grades?offeringId=${offering.id}`,{token});assert.ok(grades.data.data.some(row=>row.enrollmentId===enrollmentId&&row.firstName==='Manual'));
  const duplicate=await request('/academic/students/manual-enroll',{method:'POST',token,body});assert.equal(duplicate.status,409);assert.equal((await pool.execute('SELECT COUNT(*) total FROM enrollments WHERE student_id=?',[studentId]))[0][0].total,1);
  assert.equal((await request('/auth/login',{method:'POST',body:{identifier:studentNo,password}})).status,401);
  console.log('Manual enrollment checks passed.');
}finally{
  if(studentId){if(enrollmentId){await pool.execute("DELETE FROM audit_logs WHERE entity_type='enrollments' AND entity_id=?",[enrollmentId]);await pool.execute('DELETE FROM enrollments WHERE id=?',[enrollmentId]);}await pool.execute("DELETE FROM audit_logs WHERE entity_type='students' AND entity_id=?",[studentId]);await pool.execute('DELETE FROM students WHERE id=?',[studentId]);}
  await pool.end();
}
