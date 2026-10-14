import assert from 'node:assert/strict';
import 'dotenv/config';
import { pool } from '../database/pool.js';

const base=process.env.TEST_API_URL||'http://localhost:5050/api',password=process.env.TEST_PASSWORD||process.env.TEST_SEED_PASSWORD;
const adminEmail=process.env.TEST_ADMIN_EMAIL||'admin@schoolportal.test',adminPassword=process.env.TEST_ADMIN_PASSWORD||password;
const suffix=String(Date.now()).slice(-8),email=`workflow-${suffix}@schoolportal.test`,studentNo=`WF-${suffix}`;
async function request(route,{method='GET',token,body}={}){
  const response=await fetch(base+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json()};
}
async function login(identifier,secret){const result=await request('/auth/login',{method:'POST',body:{identifier,password:secret}});assert.equal(result.status,200,result.data.message);return result.data.data.token;}
let userId,studentId,availabilityId,appointmentId,firmId,facultyId;
try{
  const admin=await login(adminEmail,adminPassword),faculty=await login('faculty@schoolportal.test',password);
  const created=await request('/auth/register',{method:'POST',body:{firstName:'Workflow',lastName:'Student',studentId:studentNo,email,password:'Abcdefg!'}});assert.equal(created.status,201,created.data.message);
  const [[user]]=await pool.execute('SELECT id,status FROM users WHERE email=?',[email]);userId=user.id;assert.equal(user.status,'ACTIVE');
  const [[studentRecord]]=await pool.execute('SELECT id FROM students WHERE user_id=?',[userId]);studentId=studentRecord.id;
  const student=await login(email,'Abcdefg!');
  const listed=await request('/account/users',{token:admin});assert.ok(listed.data.data.rows.some(row=>row.id===userId),'admin must see the new active account');
  const teacher=(await request('/appointments/faculty',{token:faculty})).data.data.find(row=>row.userId===listed.data.data.rows.find(row=>row.email==='faculty@schoolportal.test')?.id);
  const [[ownFaculty]]=await pool.execute('SELECT id FROM faculty WHERE user_id=(SELECT id FROM users WHERE email=?)',['faculty@schoolportal.test']);facultyId=ownFaculty.id;
  const today=new Date(),nextSunday=new Date(today.getTime()+((7-today.getUTCDay())%7+7)*86400000),date=nextSunday.toISOString().slice(0,10);
  const added=await request('/appointments/availability',{method:'POST',token:faculty,body:{weekday:7,startTime:'10:00',endTime:'11:00',slotMinutes:30,bufferMinutes:0}});assert.equal(added.status,201,added.data.message);availabilityId=added.data.data.id;
  const slots=await request(`/appointments/slots?facultyId=${facultyId}&date=${date}`,{token:student});assert.equal(slots.status,200,slots.data.message);assert.ok(slots.data.data.some(slot=>slot.available));
  const booking={facultyId,date,startTime:'10:00',endTime:'10:30',purpose:'Course advising'};
  const simultaneous=await Promise.all([request('/appointments',{method:'POST',token:student,body:booking}),request('/appointments',{method:'POST',token:student,body:booking})]);
  assert.deepEqual(simultaneous.map(item=>item.status).sort(),[201,409],'faculty/date lock must prevent double booking');
  appointmentId=simultaneous.find(item=>item.status===201).data.data.id;
  assert.equal((await request(`/appointments/${appointmentId}/status`,{method:'PATCH',token:student,body:{status:'APPROVED'}})).status,403);
  assert.equal((await request(`/appointments/${appointmentId}/status`,{method:'PATCH',token:faculty,body:{status:'APPROVED'}})).status,200);
  assert.equal((await request(`/appointments/${appointmentId}/proposal`,{method:'POST',token:faculty,body:{date,startTime:'10:30',endTime:'11:00'}})).status,200);
  assert.equal((await request(`/appointments/${appointmentId}/accept-proposal`,{method:'POST',token:faculty})).status,403,'proposer may not accept own proposal');
  assert.equal((await request(`/appointments/${appointmentId}/accept-proposal`,{method:'POST',token:student})).status,200);
  const firm=await request('/firms',{method:'POST',token:admin,body:{name:`Workflow Firm ${suffix}`,category:'Accounting',description:'Test public directory entry.',publicAddress:'',publicContact:'',website:'https://example.com',status:'DRAFT'}});assert.equal(firm.status,201,firm.data.message);firmId=firm.data.data.id;
  assert.ok(!(await request('/firms',{token:student})).data.data.rows.some(row=>row.id===firmId),'draft firm must be private');
  assert.equal((await request(`/firms/${firmId}`,{method:'PATCH',token:admin,body:{name:`Workflow Firm ${suffix}`,category:'Accounting',description:'Test public directory entry.',publicAddress:'',publicContact:'',website:'https://example.com',status:'PUBLISHED'}})).status,200);
  assert.ok((await request('/firms',{token:student})).data.data.rows.some(row=>row.id===firmId),'published firm must be visible');
  console.log('New workflow checks passed: immediate registration, admin visibility, appointment locking/ownership, and firm publication.');
}finally{
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    if(appointmentId){const [notices]=await connection.execute("SELECT id FROM notifications WHERE resource_type='appointment' AND resource_id=?",[appointmentId]);for(const notice of notices){await connection.execute('DELETE FROM notification_recipients WHERE notification_id=?',[notice.id]);await connection.execute('DELETE FROM notifications WHERE id=?',[notice.id]);}await connection.execute("DELETE FROM audit_logs WHERE entity_type='appointments' AND entity_id=?",[appointmentId]);await connection.execute('DELETE FROM appointments WHERE id=?',[appointmentId]);}
    if(availabilityId)await connection.execute('DELETE FROM appointment_availability WHERE id=?',[availabilityId]);
    if(firmId){await connection.execute("DELETE FROM audit_logs WHERE entity_type='firms' AND entity_id=?",[firmId]);await connection.execute('DELETE FROM firms WHERE id=?',[firmId]);}
    if(userId){await connection.execute('DELETE FROM notification_recipients WHERE user_id=?',[userId]);await connection.execute('DELETE FROM auth_sessions WHERE user_id=?',[userId]);await connection.execute("DELETE FROM audit_logs WHERE user_id=? OR (entity_type='users' AND entity_id=?)",[userId,userId]);await connection.execute('DELETE FROM students WHERE user_id=?',[userId]);await connection.execute('DELETE FROM users WHERE id=? AND email=?',[userId,email]);}
    await connection.commit();
  }catch(error){await connection.rollback();throw error;}finally{connection.release();await pool.end();}
}
