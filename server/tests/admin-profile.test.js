import assert from 'node:assert/strict';
import 'dotenv/config';
import { pool } from '../database/pool.js';
import { hashPassword } from '../utils/password.js';

const base=process.env.TEST_API_URL||'http://localhost:5050/api',password='Abcdefg!';
const suffix=String(Date.now()).slice(-8),email=`profile-admin-${suffix}@schoolportal.test`,externalId=`PA-${suffix}`,newId=`PX-${suffix}`;
async function request(route,{method='GET',token,body}={}){const response=await fetch(base+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
let userId;
try{
  const [created]=await pool.execute("INSERT INTO users(external_id,email,password_hash,role,first_name,last_name,status) VALUES (?,?,?,'ADMIN','Temporary','Admin','ACTIVE')",[externalId,email,await hashPassword(password)]);userId=created.insertId;
  const signed=await request('/auth/login',{method:'POST',body:{identifier:email,password}});assert.equal(signed.status,200,signed.data.message);const token=signed.data.data.token;
  const saved=await request('/account/profile',{method:'PATCH',token,body:{firstName:'Revised',middleName:'Test',lastName:'Administrator',position:'Program Coordinator',phone:'+63 900 111 2222',receiveOptionalNotifications:false}});assert.equal(saved.status,200,saved.data.message);
  const details=(await request('/account/profile',{token})).data.data;assert.equal(details.firstName,'Revised');assert.equal(details.middleName,'Test');assert.equal(details.lastName,'Administrator');assert.equal(details.position,'Program Coordinator');assert.equal(details.phone,'+63 900 111 2222');assert.equal(Boolean(details.receiveOptionalNotifications),false);
  const [[faculty]]=await pool.execute("SELECT external_id externalId FROM users WHERE role='FACULTY' LIMIT 1");assert.ok(faculty);
  assert.equal((await request('/account/account-id',{method:'PATCH',token,body:{externalId:faculty.externalId,currentPassword:password,reason:'Check uniqueness'}})).status,409);
  assert.equal((await request('/account/account-id',{method:'PATCH',token,body:{externalId:newId,currentPassword:password,reason:'Temporary test of visible ID'}})).status,200);
  const current=(await request('/account/profile',{token})).data.data;assert.equal(current.id,userId,'internal database key must remain stable');assert.equal(current.externalId,newId);
  assert.equal((await request('/auth/logout',{method:'POST',token})).status,200);
  console.log('Admin profile checks passed: persisted names/phone/title, visible ID uniqueness, immutable primary key, and logout.');
}finally{
  if(userId){const connection=await pool.getConnection();try{await connection.beginTransaction();await connection.execute('DELETE FROM notification_recipients WHERE user_id=?',[userId]);await connection.execute('DELETE FROM auth_sessions WHERE user_id=?',[userId]);await connection.execute('DELETE FROM profile_contacts WHERE user_id=?',[userId]);await connection.execute('DELETE FROM audit_logs WHERE user_id=? OR (entity_type=\'users\' AND entity_id=?)',[userId,userId]);await connection.execute('DELETE FROM users WHERE id=? AND email=?',[userId,email]);await connection.commit();}catch(error){await connection.rollback();throw error;}finally{connection.release();}}
  await pool.end();
}
