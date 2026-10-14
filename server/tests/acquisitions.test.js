import assert from 'node:assert/strict';
import { pool } from '../database/pool.js';

const base=process.env.TEST_API_URL||'http://localhost:5050/api';
const password=process.env.TEST_PASSWORD||process.env.TEST_SEED_PASSWORD;
const adminEmail=process.env.TEST_ADMIN_EMAIL||'admin@schoolportal.test',adminPassword=process.env.TEST_ADMIN_PASSWORD||password;
let requestId;
async function request(route,{method='GET',token,body}={}){
  const form=body instanceof FormData;
  const response=await fetch(base+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body&&!form?{'Content-Type':'application/json'}:{})},body:body?(form?body:JSON.stringify(body)):undefined});
  return {status:response.status,data:await response.json()};
}
async function login(email,secret=password){const response=await request('/auth/login',{method:'POST',body:{identifier:email,password:secret}});assert.equal(response.status,200,response.data.message);return response.data.data.token;}
try{
  const admin=await login(adminEmail,adminPassword),student=await login('student@schoolportal.test'),faculty=await login('faculty@schoolportal.test');
  const draft={title:'Controlled resource check',category:'BOOKS',description:'One controlled book request.',quantity:'2',unit:'copy',purpose:'Test resource workflow.',neededBy:'',estimatedUnitCost:'125.50',status:'DRAFT'};
  const created=await request('/acquisitions',{method:'POST',token:student,body:draft});assert.equal(created.status,201,created.data.message);requestId=created.data.data.id;
  assert.equal((await request(`/acquisitions/${requestId}`,{token:faculty})).status,404);
  assert.equal(Number((await request(`/acquisitions/${requestId}`,{token:student})).data.data.estimatedTotal),251);
  assert.equal((await request(`/acquisitions/${requestId}/status`,{method:'PATCH',token:student,body:{status:'APPROVED'}})).status,403);
  assert.equal((await request(`/acquisitions/${requestId}/status`,{method:'PATCH',token:student,body:{status:'SUBMITTED'}})).status,200);
  assert.equal((await request(`/acquisitions/${requestId}/status`,{method:'PATCH',token:student,body:{status:'CANCELLED',comment:''}})).status,422);
  assert.equal((await request(`/acquisitions/${requestId}/status`,{method:'PATCH',token:admin,body:{status:'APPROVED'}})).status,200);
  assert.equal((await request(`/acquisitions/${requestId}/status`,{method:'PATCH',token:admin,body:{status:'ORDERED'}})).status,200);
  assert.equal((await request(`/acquisitions/${requestId}/status`,{method:'PATCH',token:admin,body:{status:'RECEIVED'}})).status,200);
  assert.equal((await request(`/acquisitions/${requestId}/status`,{method:'PATCH',token:admin,body:{status:'RECEIVED'}})).status,403);
  const detail=await request(`/acquisitions/${requestId}`,{token:student});assert.equal(detail.data.data.history.length,5);assert.equal(detail.data.data.status,'RECEIVED');
  const list=await request('/acquisitions?status=RECEIVED&category=BOOKS',{token:student});assert.ok(list.data.data.rows.some(row=>row.id===requestId));
  const [[notice]]=await pool.execute("SELECT COUNT(*) total FROM notifications WHERE resource_type='acquisition' AND resource_id=?",[requestId]);assert.equal(notice.total,3);
  console.log('Acquisition workflow checks passed.');
}finally{
  if(requestId){
    await pool.execute("DELETE nr FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id WHERE n.resource_type='acquisition' AND n.resource_id=?",[requestId]);
    await pool.execute("DELETE FROM notifications WHERE resource_type='acquisition' AND resource_id=?",[requestId]);
    await pool.execute("DELETE FROM acquisition_history WHERE acquisition_id=?",[requestId]);
    await pool.execute("DELETE FROM audit_logs WHERE entity_type='acquisitions' AND entity_id=?",[requestId]);
    await pool.execute('DELETE FROM acquisitions WHERE id=?',[requestId]);
  }
  await pool.end();
}
