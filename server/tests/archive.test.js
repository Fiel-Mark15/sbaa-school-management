import assert from 'node:assert/strict';
import { pool } from '../database/pool.js';

const base=process.env.TEST_API_URL||'http://localhost:5050/api';
const adminEmail=process.env.TEST_ADMIN_EMAIL,adminPassword=process.env.TEST_ADMIN_PASSWORD;
if(!adminEmail||!adminPassword)throw new Error('Provide private admin test credentials.');
async function request(path,{method='GET',token,body}={}){const response=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
async function login(identifier,password){const response=await request('/auth/login',{method:'POST',body:{identifier,password}});assert.equal(response.status,200,response.data.message);return response.data.data.token;}
let subjectId,firmId,announcementId,notificationId;
try{
  const admin=await login(adminEmail,adminPassword),faculty=await login('faculty@schoolportal.test',process.env.TEST_PASSWORD||process.env.TEST_SEED_PASSWORD);
  const adminContext=await request('/dashboard/context',{token:admin});assert.equal(adminContext.status,200,adminContext.data.message);assert.ok(Array.isArray(adminContext.data.data.activity));
  const facultyContext=await request('/dashboard/context',{token:faculty});assert.equal(facultyContext.status,200,facultyContext.data.message);assert.equal(facultyContext.data.data.pendingAcquisitions,null);
  const code=`QAARC${Date.now().toString(36).toUpperCase()}`;
  const [result]=await pool.execute("INSERT INTO subjects(code,name,units,status) VALUES (?,'Controlled archive verification',3,'ARCHIVED')",[code]);subjectId=result.insertId;
  assert.equal((await request('/archive',{token:faculty})).status,403);
  const list=await request(`/archive?module=subjects&search=${code}`,{token:admin});assert.equal(list.status,200,list.data.message);assert.ok(list.data.data.rows.some(row=>row.id===subjectId));
  const preview=await request(`/archive/subjects/${subjectId}/preview`,{token:admin});assert.equal(preview.status,200);assert.equal(preview.data.data.canDelete,true);
  assert.equal((await request(`/archive/subjects/${subjectId}/restore`,{method:'PATCH',token:admin,body:{reason:'Controlled restore test'}})).status,200);
  const [[restored]]=await pool.execute('SELECT status FROM subjects WHERE id=?',[subjectId]);assert.equal(restored.status,'ACTIVE');
  assert.equal((await request(`/archive/subjects/${subjectId}/restore`,{method:'PATCH',token:admin,body:{reason:'Repeat'}})).status,404);
  await pool.execute("UPDATE subjects SET status='ARCHIVED' WHERE id=?",[subjectId]);
  assert.equal((await request(`/archive/subjects/${subjectId}`,{method:'DELETE',token:admin,body:{reason:'Controlled cleanup'}})).status,200);
  const [[gone]]=await pool.execute('SELECT COUNT(*) total FROM subjects WHERE id=?',[subjectId]);assert.equal(gone.total,0);subjectId=null;
  const [createdFirm]=await pool.execute("INSERT INTO firms(name,category,description,status) VALUES ('Controlled archive firm','Other','Controlled deletion test','DRAFT')");firmId=createdFirm.insertId;
  assert.equal((await request(`/firms/${firmId}`,{method:'DELETE',token:admin,body:{reason:'Controlled test'}})).status,409);
  await pool.execute("UPDATE firms SET status='ARCHIVED' WHERE id=?",[firmId]);
  assert.equal((await request(`/archive/firms/${firmId}/preview`,{token:admin})).data.data.canDelete,true);
  assert.equal((await request(`/firms/${firmId}`,{method:'DELETE',token:admin,body:{reason:'Controlled cleanup'}})).status,200);firmId=null;
  const [[author]]=await pool.execute('SELECT id FROM users WHERE email=?',[adminEmail]);
  const [createdAnnouncement]=await pool.execute("INSERT INTO announcements(author_id,title,content,status) VALUES (?,'Controlled archive announcement','Temporary test notice','ARCHIVED')",[author.id]);announcementId=createdAnnouncement.insertId;
  const [createdNotice]=await pool.execute("INSERT INTO notifications(type,title,body,resource_type,resource_id) VALUES ('ANNOUNCEMENT','Controlled archive announcement','Temporary test notice','announcement',?)",[announcementId]);notificationId=createdNotice.insertId;
  await pool.execute('INSERT INTO notification_recipients(notification_id,user_id) VALUES (?,?)',[notificationId,author.id]);
  const announcementPreview=await request(`/archive/announcements/${announcementId}/preview`,{token:admin});
  assert.equal(announcementPreview.status,200);assert.equal(announcementPreview.data.data.canDelete,true);assert.equal(announcementPreview.data.data.dependencies.inboxCopies,1);
  assert.equal((await request(`/archive/announcements/${announcementId}`,{method:'DELETE',token:faculty,body:{reason:'Not permitted'}})).status,403);
  assert.equal((await request(`/archive/announcements/${announcementId}`,{method:'DELETE',token:admin,body:{reason:'Controlled cleanup'}})).status,200);
  const [[announcementGone]]=await pool.execute('SELECT COUNT(*) total FROM announcements WHERE id=?',[announcementId]);assert.equal(announcementGone.total,0);announcementId=null;
  const [[noticeGone]]=await pool.execute('SELECT COUNT(*) total FROM notifications WHERE id=?',[notificationId]);assert.equal(noticeGone.total,0);notificationId=null;
  console.log('Archive access, preview, restore, and guarded deletion passed.');
}finally{if(subjectId)await pool.execute('DELETE FROM subjects WHERE id=?',[subjectId]);if(firmId)await pool.execute('DELETE FROM firms WHERE id=?',[firmId]);if(notificationId){await pool.execute('DELETE FROM notification_recipients WHERE notification_id=?',[notificationId]);await pool.execute('DELETE FROM notifications WHERE id=?',[notificationId]);}if(announcementId)await pool.execute('DELETE FROM announcements WHERE id=?',[announcementId]);await pool.end();}
