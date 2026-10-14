import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import 'dotenv/config';
import { pool } from '../database/pool.js';

const base=process.env.TEST_API_URL||'http://localhost:5050/api';
const password=process.env.TEST_PASSWORD||process.env.TEST_SEED_PASSWORD;
const adminEmail=process.env.TEST_ADMIN_EMAIL||'admin@schoolportal.test',adminPassword=process.env.TEST_ADMIN_PASSWORD||password;
async function request(url,{method='GET',token,body}={}){const response=await fetch(base+url,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
async function login(email,secret=password){const result=await request('/auth/login',{method:'POST',body:{identifier:email,password:secret}});assert.equal(result.status,200,result.data.message);return result.data.data.token;}
async function uploadImage(token,bytes,fields,route='/schedule-attachments',method='POST'){const body=new FormData();for(const [key,value] of Object.entries(fields))body.append(key,String(value));body.append('image',new Blob([bytes],{type:'image/png'}),'schedule.png');const response=await fetch(base+route,{method,headers:{Authorization:`Bearer ${token}`},body});return {status:response.status,data:await response.json()};}
const admin=await login(adminEmail,adminPassword),student=await login('student@schoolportal.test');
const term=(await request('/academic/terms',{token:admin})).data.data[0];assert.ok(term);
const png=await sharp({create:{width:20,height:20,channels:3,background:'#087f5b'}}).png().toBuffer();
let attachmentId,announcementId;
try{
  const fields={title:'Temporary schedule test',description:'A green test image with no timetable information.',termId:term.id,audience:'ALL'};
  assert.equal((await uploadImage(student,png,fields)).status,403,'student upload forbidden');
  const created=await uploadImage(admin,png,fields);assert.equal(created.status,201,created.data.message);attachmentId=created.data.data.id;
  assert.ok(!(await request('/schedule-attachments',{token:student})).data.data.some(row=>row.id===attachmentId),'draft hidden from students');
  assert.equal((await request(`/schedule-attachments/${attachmentId}/status`,{method:'PATCH',token:admin,body:{status:'PUBLISHED'}})).status,200);
  assert.ok((await request('/schedule-attachments',{token:student})).data.data.some(row=>row.id===attachmentId),'published ALL image visible');
  const imageResponse=await fetch(`${base}/schedule-attachments/${attachmentId}/image`,{headers:{Authorization:`Bearer ${student}`}});
  assert.equal(imageResponse.status,200);assert.match(imageResponse.headers.get('content-type'),/image\/webp/);
  assert.equal((await uploadImage(admin,Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),fields)).status,422,'SVG must be rejected');
  assert.equal((await uploadImage(admin,png,{},`/schedule-attachments/${attachmentId}/image`,'PUT')).status,200);
  assert.ok(!(await request('/schedule-attachments',{token:student})).data.data.some(row=>row.id===attachmentId),'replacement returns to draft');
  assert.equal((await request(`/schedule-attachments/${attachmentId}/status`,{method:'PATCH',token:admin,body:{status:'PUBLISHED'}})).status,200);
  const item=(await request('/schedule-attachments',{token:admin})).data.data.find(row=>row.id===attachmentId);assert.equal(item.version,2);
  assert.equal((await request(`/schedule-attachments/${attachmentId}/status`,{method:'PATCH',token:admin,body:{status:'ARCHIVED'}})).status,200);
  assert.ok(!(await request('/schedule-attachments',{token:student})).data.data.some(row=>row.id===attachmentId));

  const announcement=await request('/notifications/announcements',{method:'POST',token:admin,body:{title:'Temporary repair announcement',content:'Test-only message',priority:'LOW',publish:true}});
  assert.equal(announcement.status,201,announcement.data.message);announcementId=announcement.data.data.id;
  const adminNotice=(await request('/notifications',{token:admin})).data.data.rows.find(row=>row.resourceType==='announcement'&&row.resourceId===announcementId);
  const studentNotice=(await request('/notifications',{token:student})).data.data.rows.find(row=>row.resourceType==='announcement'&&row.resourceId===announcementId);
  assert.ok(adminNotice&&studentNotice);
  assert.equal((await request(`/notifications/${studentNotice.id}/archive`,{method:'PATCH',token:student})).status,200);
  assert.ok(!(await request('/notifications',{token:student})).data.data.rows.some(row=>row.id===studentNotice.id));
  assert.ok((await request('/notifications',{token:admin})).data.data.rows.some(row=>row.id===adminNotice.id),'another recipient retains message');
  assert.equal((await request(`/notifications/announcements/${announcementId}/status`,{method:'PATCH',token:admin,body:{status:'ARCHIVED'}})).status,200);
  assert.ok(!(await request('/notifications',{token:admin})).data.data.rows.some(row=>row.id===adminNotice.id),'withdrawal hides linked notice');
  console.log('Repair checks passed: upload scope/type/version, recipient-only archive, announcement withdrawal.');
}finally{
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    if(announcementId){await connection.execute("DELETE nr FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id WHERE n.resource_type='announcement' AND n.resource_id=?",[announcementId]);await connection.execute("DELETE FROM notifications WHERE resource_type='announcement' AND resource_id=?",[announcementId]);await connection.execute("DELETE FROM audit_logs WHERE entity_type='announcements' AND entity_id=?",[announcementId]);await connection.execute('DELETE FROM announcements WHERE id=? AND title=\'Temporary repair announcement\'',[announcementId]);}
    if(attachmentId){const [[row]]=await connection.execute('SELECT storage_key FROM schedule_attachments WHERE id=? AND title=\'Temporary schedule test\'',[attachmentId]);if(row){await connection.execute("DELETE FROM audit_logs WHERE entity_type='schedule_attachments' AND entity_id=?",[attachmentId]);await connection.execute('DELETE FROM schedule_attachments WHERE id=?',[attachmentId]);const dir=process.env.UPLOAD_DIR?path.resolve(process.env.UPLOAD_DIR):fileURLToPath(new URL('../private-uploads/',import.meta.url));try{await unlink(path.join(dir,`${row.storage_key}.webp`));}catch{}}}
    await connection.commit();
  }catch(error){await connection.rollback();throw error;}finally{connection.release();await pool.end();}}
