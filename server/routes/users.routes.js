import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { digest, revokeUserSessions } from '../utils/sessions.js';
import { mailAvailable, safeMailErrorCode, mailFailureOutcome, sendInviteMail, sendEmailChangeMail } from '../utils/mail.js';
import { env } from '../config/env.js';
import { fail, ok } from '../utils/response.js';
import { hashPassword, verifyPassword, passwordValid } from '../utils/password.js';
import { currentEmailVerificationStatus, requestCurrentEmailVerification } from '../utils/email-verification.js';

const router = Router();
router.use(authenticate);
router.get('/profile', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`SELECT u.id,u.email,u.role,u.first_name firstName,u.middle_name middleName,u.last_name lastName,u.external_id externalId,u.last_login_at lastLoginAt,u.email_verified_at emailVerifiedAt,
      p.phone,p.position personalPosition,p.receive_optional_notifications receiveOptionalNotifications,p.theme_preference themePreference,pr.name program,s.name section,s.year_level yearLevel,f.faculty_no facultyNo,f.position,
      photo.version photoVersion
      FROM users u LEFT JOIN profile_contacts p ON p.user_id=u.id
      LEFT JOIN profile_photos photo ON photo.user_id=u.id
      LEFT JOIN students st ON st.user_id=u.id LEFT JOIN programs pr ON pr.id=st.program_id
      LEFT JOIN sections s ON s.id=st.section_id LEFT JOIN faculty f ON f.user_id=u.id WHERE u.id=?`, [req.user.sub]);
    if(rows[0])rows[0].position=rows[0].role==='ADMIN'?rows[0].personalPosition:rows[0].position;
    return ok(res, rows[0]);
  } catch (error) { next(error); }
});
router.patch('/profile', async (req, res, next) => {
  try {
    const { phone, receiveOptionalNotifications,firstName,middleName,lastName,position } = req.body || {};
    if (phone != null && (typeof phone !== 'string' || phone.length > 30 || !/^[+\d\s()-]*$/.test(phone))) return fail(res, 'Enter a valid phone number.', 422);
    if (receiveOptionalNotifications != null && typeof receiveOptionalNotifications !== 'boolean') return fail(res, 'Invalid notification preference.', 422);
    const validName=(value,optional=false)=>optional&&(value==null||value==='')||typeof value==='string'&&value.length<=100&&/^[\p{L}\p{M}][\p{L}\p{M} '’-]*$/u.test(value.trim());
    const identityProvided=[firstName,middleName,lastName].some(value=>value!==undefined);
    if(req.user.role==='ADMIN'){
      if((identityProvided&&(!validName(firstName)||!validName(middleName,true)||!validName(lastName)))||(position!==undefined&&(typeof position!=='string'||position.length>100)))return fail(res,'Enter valid name and position details.',422);
    }else if([firstName,middleName,lastName,position].some(value=>value!==undefined))return fail(res,'Institutional identity is managed by administrators.',403);
    const [[current]] = await pool.execute('SELECT phone,position,receive_optional_notifications preference FROM profile_contacts WHERE user_id=?',[req.user.sub]);
    const connection=await pool.getConnection();try{await connection.beginTransaction();
      await connection.execute(`INSERT INTO profile_contacts (user_id,phone,position,receive_optional_notifications) VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE phone=VALUES(phone),position=VALUES(position),receive_optional_notifications=VALUES(receive_optional_notifications)`,
      [req.user.sub, phone===undefined?(current?.phone||null):(phone?.trim()||null),position===undefined?(current?.position||null):(position.trim()||null), receiveOptionalNotifications==null?(current?.preference??true):receiveOptionalNotifications]);
      if(req.user.role==='ADMIN'&&identityProvided){
        await connection.execute('UPDATE users SET first_name=?,middle_name=?,last_name=? WHERE id=?',[firstName.trim(),middleName?.trim()||null,lastName.trim(),req.user.sub]);
      }
      if(req.user.role==='ADMIN'){
        await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'PROFILE_UPDATED','users',?)",[req.user.sub,req.user.sub]);
      }
      await connection.commit();
    }catch(error){await connection.rollback();throw error;}finally{connection.release();}
    return ok(res, null, 'Profile settings saved.');
  } catch (error) { next(error); }
});
router.patch('/theme',async(req,res,next)=>{
  const theme=req.body?.theme;
  if(!['light','dark','system'].includes(theme))return fail(res,'Choose Light, Dark, or System.',422);
  try{
    await pool.execute('INSERT INTO profile_contacts(user_id,theme_preference) VALUES (?,?) ON DUPLICATE KEY UPDATE theme_preference=VALUES(theme_preference)',[req.user.sub,theme]);
    return ok(res,{theme},'Appearance preference saved.');
  }catch(error){next(error);}
});
router.get('/email-verification',async(req,res,next)=>{try{return ok(res,await currentEmailVerificationStatus(req.user.sub));}catch(error){next(error);}});
function verificationResponse(res,result){
  if(result.retryAfterSeconds)res.set('Retry-After',String(result.retryAfterSeconds));
  return res.status(result.status).json({success:result.status===200,message:result.message,
    ...(result.status===200?{data:{outcome:result.outcome,retryAfterSeconds:result.retryAfterSeconds,nextAllowedAt:result.nextAllowedAt}}:{retryAfterSeconds:result.retryAfterSeconds||0,nextAllowedAt:result.nextAllowedAt||null})});
}
router.post('/email-verification',async(req,res,next)=>{try{return verificationResponse(res,await requestCurrentEmailVerification(req.user.sub,req.user.sub));}catch(error){next(error);}});
router.get('/users/:id/email-verification',authorize('ADMIN'),async(req,res,next)=>{try{
  const userId=Number(req.params.id);if(!Number.isSafeInteger(userId)||userId<1)return fail(res,'Invalid account.',422);
  const status=await currentEmailVerificationStatus(userId);return status?ok(res,status):fail(res,'Account not found.',404);
}catch(error){next(error);}});
router.post('/users/:id/email-verification',authorize('ADMIN'),async(req,res,next)=>{try{
  const userId=Number(req.params.id);if(!Number.isSafeInteger(userId)||userId<1)return fail(res,'Invalid account.',422);
  return verificationResponse(res,await requestCurrentEmailVerification(userId,req.user.sub));
}catch(error){next(error);}});
router.get('/email-change/pending',async(req,res,next)=>{try{
  const [[pending]]=await pool.execute("SELECT pending_email pendingEmail,expires_at expiresAt FROM email_change_tokens WHERE user_id=? AND used_at IS NULL AND expires_at>UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1",[req.user.sub]);
  const [[delivery]]=await pool.execute("SELECT outcome,created_at createdAt FROM mail_delivery_events WHERE user_id=? AND purpose='EMAIL_CHANGE' ORDER BY id DESC LIMIT 1",[req.user.sub]);
  return ok(res,{pending:pending||null,delivery:pending?delivery||null:null});
}catch(error){next(error);}});
router.delete('/email-change/pending',async(req,res,next)=>{try{
  const [result]=await pool.execute('UPDATE email_change_tokens SET used_at=UTC_TIMESTAMP() WHERE user_id=? AND used_at IS NULL',[req.user.sub]);
  if(result.affectedRows)await pool.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'EMAIL_CHANGE_CANCELLED','users',?)",[req.user.sub,req.user.sub]);
  return ok(res,null,'Pending email change cancelled.');
}catch(error){next(error);}});
router.post('/email-change',async(req,res,next)=>{
  const email=typeof req.body?.newEmail==='string'?req.body.newEmail.trim().toLowerCase():'';
  if(!/^\S+@\S+\.\S+$/.test(email)||email.length>190||typeof req.body?.currentPassword!=='string')return fail(res,'Enter a valid new email and your current password.',422);
  if(!mailAvailable())return fail(res,'Email verification is not configured. Contact the administrator.',503);
  try{
    const [[user]]=await pool.execute('SELECT email,password_hash,first_name FROM users WHERE id=?',[req.user.sub]);
    if(!await verifyPassword(req.body.currentPassword,user.password_hash))return fail(res,'Current password is incorrect.',403);
    if(user.email===email)return fail(res,'That is already your current email.',409);
    const [[existing]]=await pool.execute('SELECT id FROM users WHERE email=?',[email]);if(existing)return fail(res,'That email is already registered.',409);
    const token=randomBytes(32).toString('base64url');
    const [result]=await pool.execute('INSERT INTO email_change_tokens(user_id,pending_email,token_digest,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))',[req.user.sub,email,digest(token)]);
    try{
      const sent=await sendEmailChangeMail(email,`${env.appPublicUrl}/verify-email?token=${encodeURIComponent(token)}`,user.first_name);
      await pool.execute("INSERT INTO mail_delivery_events(user_id,purpose,outcome,message_id) VALUES (?,'EMAIL_CHANGE',?,?)",[req.user.sub,env.mailMode==='development'?'DEVELOPMENT_LOG':'PROVIDER_ACCEPTED',sent.messageId?.slice(0,255)||null]);
    }catch(error){
      // A lost SMTP acknowledgement must not invalidate a link already accepted.
      await pool.execute("INSERT INTO mail_delivery_events(user_id,purpose,outcome,error_code) VALUES (?,'EMAIL_CHANGE',?,?)",[req.user.sub,mailFailureOutcome(error),safeMailErrorCode(error)]);
      return fail(res,'Verification email was not confirmed. Your current address is unchanged until a link is verified.',503);
    }
    await pool.execute('UPDATE email_change_tokens SET used_at=UTC_TIMESTAMP() WHERE user_id=? AND id<>? AND used_at IS NULL',[req.user.sub,result.insertId]);
    await pool.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'EMAIL_CHANGE_REQUESTED','users',?)",[req.user.sub,req.user.sub]);
    return ok(res,null,'Verification requested. Your current email stays active until you confirm the new address.');
  }catch(error){next(error);}
});
router.patch('/account-id',authorize('ADMIN'),async(req,res,next)=>{
  const externalId=typeof req.body?.externalId==='string'?req.body.externalId.trim():'';
  if(!/^[A-Za-z0-9-]{4,40}$/.test(externalId)||typeof req.body?.currentPassword!=='string'||typeof req.body?.reason!=='string'||!req.body.reason.trim()||req.body.reason.length>500)return fail(res,'Enter a valid Account ID, current password, and audit reason.',422);
  try{
    const [[user]]=await pool.execute('SELECT password_hash,external_id FROM users WHERE id=?',[req.user.sub]);
    if(!await verifyPassword(req.body.currentPassword,user.password_hash))return fail(res,'Current password is incorrect.',403);
    const connection=await pool.getConnection();try{await connection.beginTransaction();
      await connection.execute('UPDATE users SET external_id=? WHERE id=?',[externalId,req.user.sub]);
      await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,'ADMIN_ACCOUNT_ID_CHANGED','users',?,?)",[req.user.sub,req.user.sub,JSON.stringify({old:user.external_id,new:externalId,reason:req.body.reason.trim()})]);
      await connection.commit();return ok(res,{externalId},'Account ID updated.');
    }catch(error){await connection.rollback();if(error.code==='ER_DUP_ENTRY')return fail(res,'That Account ID is already in use.',409);throw error;}finally{connection.release();}
  }catch(error){next(error);}
});
router.post('/change-password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!passwordValid(newPassword)) return fail(res, 'Use at least 8 characters, one uppercase letter, and one special character. Avoid common passwords.', 422);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[user]] = await connection.execute('SELECT password_hash FROM users WHERE id=? FOR UPDATE', [req.user.sub]);
      if (!user || typeof currentPassword !== 'string' || !await verifyPassword(currentPassword, user.password_hash)){await connection.rollback();return fail(res, 'Current password is incorrect.', 403);}
      await connection.execute('UPDATE users SET password_hash=? WHERE id=?', [await hashPassword(newPassword), req.user.sub]);
      await connection.execute('UPDATE email_change_tokens SET used_at=UTC_TIMESTAMP() WHERE user_id=? AND used_at IS NULL',[req.user.sub]);
      await revokeUserSessions(req.user.sub, connection);
      await connection.execute("INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,'PASSWORD_CHANGED','users',?)", [req.user.sub, req.user.sub]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    return ok(res, null, 'Password changed. Please sign in again.');
  } catch (error) { next(error); }
});
router.post('/logout-others',async(req,res,next)=>{try{
  await pool.execute('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE user_id=? AND id<>? AND revoked_at IS NULL',[req.user.sub,req.user.sessionId]);
  await pool.execute("INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,'OTHER_SESSIONS_REVOKED','users',?)",[req.user.sub,req.user.sub]);
  return ok(res,null,'Other sessions signed out.');
}catch(error){next(error);}});
function describeDevice(value){
  if(!value)return null;
  const browser=/Edg\//.test(value)?'Edge':/Firefox\//.test(value)?'Firefox':/Chrome\//.test(value)?'Chrome':/Safari\//.test(value)?'Safari':null;
  const platform=/iPhone/.test(value)?'iPhone':/iPad/.test(value)?'iPad':/Android/.test(value)?'Android':/Macintosh|Mac OS/.test(value)?'Mac':/Windows/.test(value)?'Windows':/Linux/.test(value)?'Linux':null;
  return [browser,platform].filter(Boolean).join(' on ')||null;
}
router.get('/sessions',async(req,res,next)=>{try{
  const page=Math.max(1,Math.min(10000,Number(req.query.page)||1)),limit=req.query.all==='true'?10:3;
  const [[count]]=await pool.execute('SELECT COUNT(*) total FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP()',[req.user.sub]);
  const [rows]=await pool.query('SELECT id,created_at createdAt,last_seen_at lastSeenAt,expires_at expiresAt,user_agent userAgent FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP() ORDER BY (id=?) DESC,COALESCE(last_seen_at,created_at) DESC,id DESC LIMIT ? OFFSET ?',[req.user.sub,req.user.sessionId,limit,(page-1)*limit]);
  return ok(res,{rows:rows.map(row=>({id:row.id,createdAt:row.createdAt,lastSeenAt:row.lastSeenAt,expiresAt:row.expiresAt,device:describeDevice(row.userAgent),current:row.id===req.user.sessionId})),total:count.total,page});
}catch(error){next(error);}});
router.patch('/sessions/:id/revoke',async(req,res,next)=>{try{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return fail(res,'Invalid session.',422);
  const [result]=await pool.execute('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE id=? AND user_id=? AND revoked_at IS NULL',[id,req.user.sub]);
  if(!result.affectedRows)return fail(res,'Session not found or already revoked.',404);
  await pool.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,'SESSION_REVOKED','users',?,?)",[req.user.sub,req.user.sub,JSON.stringify({sessionId:id})]);
  return ok(res,{current:id===req.user.sessionId},'Session revoked.');
}catch(error){next(error);}});

router.get('/users', authorize('ADMIN'), async (req, res, next) => {
  try {
    const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
    const search = String(req.query.search || '').slice(0, 100);
    const status = ['ACTIVE','DISABLED','PENDING','ARCHIVED'].includes(req.query.status) ? req.query.status : null;
    const role = ['ADMIN','FACULTY','STUDENT'].includes(req.query.role) ? req.query.role : null;
    const verification=['verified','unverified'].includes(req.query.emailVerification)?req.query.emailVerification:null;
    const params = [`%${search}%`, `%${search}%`, `%${search}%`, status, status, role, role,verification,verification];
    const where = `WHERE (u.email LIKE ? OR u.external_id LIKE ? OR CONCAT_WS(' ',u.first_name,u.middle_name,u.last_name) LIKE ?) AND (? IS NULL OR u.status=?) AND (? IS NULL OR u.role=?) AND (? IS NULL OR IF(u.email_verified_at IS NULL,'unverified','verified')=?)`;
    const [[count]] = await pool.execute(`SELECT COUNT(*) total FROM users u ${where}`, params);
    const [rows] = await pool.query(`SELECT u.id,u.external_id externalId,u.email,u.role,u.first_name firstName,u.middle_name middleName,u.last_name lastName,u.status,u.created_at createdAt,u.email_verified_at emailVerifiedAt,st.identity_status identityStatus,IF(photo.user_id IS NULL,0,1) hasPhoto,
      (SELECT UNIX_TIMESTAMP(t.created_at)+60 FROM email_verification_tokens t WHERE t.user_id=u.id AND t.email=u.email AND t.used_at IS NULL AND t.expires_at>UTC_TIMESTAMP() ORDER BY t.id DESC LIMIT 1) verificationNextEpoch,
      (SELECT m.outcome FROM mail_delivery_events m WHERE m.user_id=u.id AND m.purpose='CURRENT_EMAIL_VERIFICATION' ORDER BY m.id DESC LIMIT 1) verificationOutcome,
      UNIX_TIMESTAMP() nowEpoch FROM users u LEFT JOIN students st ON st.user_id=u.id LEFT JOIN profile_photos photo ON photo.user_id=u.id ${where} ORDER BY u.created_at DESC LIMIT 20 OFFSET ?`, [...params, (page-1)*20]);
    return ok(res, { rows:rows.map(row=>({...row,verificationNextAllowedAt:row.verificationNextEpoch&&row.verificationNextEpoch>row.nowEpoch?new Date(Number(row.verificationNextEpoch)*1000).toISOString():null,verificationNextEpoch:undefined,nowEpoch:undefined})), total: count.total, page });
  } catch (error) { next(error); }
});
router.get('/users/:id',authorize('ADMIN'),async(req,res,next)=>{try{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return fail(res,'Invalid account.',422);
  const [[row]]=await pool.execute(`SELECT u.id,u.external_id externalId,u.email,u.role,u.first_name firstName,u.middle_name middleName,u.last_name lastName,u.status,u.created_at createdAt,u.last_login_at lastLoginAt,u.email_verified_at emailVerifiedAt,
    st.student_no studentNo,st.identity_status identityStatus,pr.name program,s.name section,s.year_level yearLevel,f.faculty_no facultyNo,f.position,IF(photo.user_id IS NULL,0,1) hasPhoto
    FROM users u LEFT JOIN students st ON st.user_id=u.id LEFT JOIN programs pr ON pr.id=st.program_id LEFT JOIN sections s ON s.id=st.section_id LEFT JOIN faculty f ON f.user_id=u.id LEFT JOIN profile_photos photo ON photo.user_id=u.id WHERE u.id=?`,[id]);
  if(!row)return fail(res,'Account not found.',404);return ok(res,row);
}catch(error){next(error);}});
router.get('/users/:id/photo',authorize('ADMIN'),async(req,res,next)=>{try{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return fail(res,'Invalid account.',422);
  const [[photo]]=await pool.execute('SELECT storage_key FROM profile_photos WHERE user_id=?',[id]);
  if(!photo)return fail(res,'No profile photo.',404);
  const directory=process.env.UPLOAD_DIR?path.resolve(process.env.UPLOAD_DIR):fileURLToPath(new URL('../private-uploads/',import.meta.url));
  const image=await readFile(path.join(directory,`profile-${photo.storage_key}.webp`));
  return res.set({'Content-Type':'image/webp','Cache-Control':'private, no-store','Content-Disposition':'inline; filename="profile.webp"','X-Content-Type-Options':'nosniff'}).send(image);
}catch(error){if(error.code==='ENOENT')return fail(res,'Profile photo is unavailable.',404);next(error);}});
router.patch('/users/:id/identity',authorize('ADMIN'),async(req,res,next)=>{
  const id=Number(req.params.id),verified=req.body?.verified,reason=req.body?.reason;
  if(!Number.isSafeInteger(id)||id<1||typeof verified!=='boolean'||typeof reason!=='string'||!reason.trim()||reason.length>500)return fail(res,'Provide a verification decision and audit reason.',422);
  const connection=await pool.getConnection();try{
    await connection.beginTransaction();
    const [[student]]=await connection.execute('SELECT st.id,u.status FROM students st JOIN users u ON u.id=st.user_id WHERE u.id=? FOR UPDATE',[id]);
    if(!student){await connection.rollback();return fail(res,'Student account not found.',404);}
    await connection.execute('UPDATE students SET identity_status=? WHERE id=?',[verified?'VERIFIED':'UNVERIFIED',student.id]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,'STUDENT_IDENTITY_REVIEWED','users',?,?)",[req.user.sub,id,JSON.stringify({verified,reason:reason.trim()})]);
    await connection.commit();return ok(res,{identityStatus:verified?'VERIFIED':'UNVERIFIED'},'Identity review saved. Academic records are not linked automatically.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
router.post('/users',authorize('ADMIN'),async(req,res,next)=>{
  const {firstName,lastName,email,externalId,role,position}=req.body||{};
  if(!mailAvailable())return fail(res,'Invitation email is not configured.',503);
  if(typeof firstName!=='string'||!firstName.trim()||firstName.length>100||typeof lastName!=='string'||!lastName.trim()||lastName.length>100||typeof email!=='string'||email.length>190||!/^\S+@\S+\.\S+$/.test(email)||typeof externalId!=='string'||!/^[A-Za-z0-9-]{4,40}$/.test(externalId)||!['ADMIN','FACULTY'].includes(role)||(position!=null&&(typeof position!=='string'||position.length>100)))return fail(res,'Enter valid staff account details.',422);
  const connection=await pool.getConnection();try{
    await connection.beginTransaction();
    const randomPassword=randomBytes(48).toString('base64url');
    const [result]=await connection.execute("INSERT INTO users (external_id,email,password_hash,role,first_name,last_name,status) VALUES (?,?,?,?,?,?,'ACTIVE')",[externalId.trim(),email.trim().toLowerCase(),await hashPassword(randomPassword),role,firstName.trim(),lastName.trim()]);
    if(role==='FACULTY')await connection.execute('INSERT INTO faculty (user_id,faculty_no,position) VALUES (?,?,?)',[result.insertId,externalId.trim(),position?.trim()||null]);
    const token=randomBytes(32).toString('base64url');
    await connection.execute('INSERT INTO password_reset_tokens (user_id,token_digest,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))',[result.insertId,digest(token)]);
    await connection.execute("INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,'STAFF_CREATED','users',?)",[req.user.sub,result.insertId]);
    await sendInviteMail(email.trim().toLowerCase(),`${env.appPublicUrl}/reset-password?token=${encodeURIComponent(token)}`);
    await connection.commit();return ok(res,{id:result.insertId},'Staff account created and invitation sent.',201);
  }catch(error){await connection.rollback();if(error.code==='ER_DUP_ENTRY')return fail(res,'That email or staff ID is already in use.',409);next(error);}finally{connection.release();}
});
router.patch('/users/:id/status', authorize('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id), status = req.body?.status,reason=req.body?.reason;
  if (!Number.isSafeInteger(id) || id < 1 || !['ACTIVE','DISABLED','ARCHIVED'].includes(status) || typeof reason!=='string'||!reason.trim()||reason.length>500) return fail(res, 'Enter a valid account action and audit reason.', 422);
  if (id === req.user.sub && status !== 'ACTIVE') return fail(res, 'You cannot disable or archive your own account.', 409);
  const connection = await pool.getConnection();
  try {
    const [[locked]]=await connection.execute("SELECT GET_LOCK('sbaa:admin:status',10) acquired");
    if(locked.acquired!==1)return fail(res,'Account update is busy. Try again.',409);
    await connection.beginTransaction();
    const [[target]] = await connection.execute('SELECT id,role,status FROM users WHERE id=? FOR UPDATE', [id]);
    if (!target) { await connection.rollback(); return fail(res, 'Account not found.', 404); }
    if (target.role === 'ADMIN' && status !== 'ACTIVE' && target.status==='ACTIVE') {
      const [[active]] = await connection.query("SELECT COUNT(*) total FROM users WHERE role='ADMIN' AND status='ACTIVE'");
      if (active.total <= 1) { await connection.rollback(); return fail(res, 'The final active administrator cannot be disabled.', 409); }
    }
    await connection.execute('UPDATE users SET status=? WHERE id=?', [status,id]);
    await revokeUserSessions(id, connection);
    const action=status==='ACTIVE'?'ACCOUNT_REACTIVATED':status==='ARCHIVED'?'ACCOUNT_ARCHIVED':'ACCOUNT_DISABLED';
    await connection.execute('INSERT INTO audit_logs (user_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?)', [req.user.sub,action,'users', id,JSON.stringify({reason:reason.trim()})]);
    await connection.commit();
    return ok(res, null, 'Account status updated.');
  } catch (error) { await connection.rollback(); next(error); } finally {try{await connection.query("SELECT RELEASE_LOCK('sbaa:admin:status')");}catch{}connection.release();}
});
router.delete('/users/:id',authorize('ADMIN'),async(req,res,next)=>{
  const id=Number(req.params.id),reason=req.body?.reason,currentPassword=req.body?.currentPassword;
  if(!Number.isSafeInteger(id)||id<1||typeof reason!=='string'||!reason.trim()||reason.length>500||typeof currentPassword!=='string'||!currentPassword)return fail(res,'Enter a valid account, deletion reason, and your current password.',422);
  if(id===req.user.sub)return fail(res,'You cannot delete your own account.',409);
  const connection=await pool.getConnection();let photoKey=null;try{
    const [[locked]]=await connection.execute("SELECT GET_LOCK('sbaa:admin:status',10) acquired");
    if(locked.acquired!==1)return fail(res,'Account update is busy. Try again.',409);
    await connection.beginTransaction();
    const [[actor]]=await connection.execute("SELECT password_hash FROM users WHERE id=? AND status='ACTIVE' FOR UPDATE",[req.user.sub]);
    if(!actor||!await verifyPassword(currentPassword,actor.password_hash)){await connection.rollback();return fail(res,'Current password is incorrect.',403);}
    const [[user]]=await connection.execute('SELECT id,email,external_id,role,status FROM users WHERE id=? FOR UPDATE',[id]);
    if(!user){await connection.rollback();return fail(res,'Account not found.',404);}
    if(user.role==='ADMIN'&&user.status==='ACTIVE'){
      const [[active]]=await connection.execute("SELECT COUNT(*) total FROM users WHERE role='ADMIN' AND status='ACTIVE'");
      if(active.total<=1){await connection.rollback();return fail(res,'The final active administrator cannot be deleted.',409);}
    }
    if(user.status!=='ARCHIVED'){await connection.rollback();return fail(res,'Archive the account before permanent deletion.',409);}
    const [[history]]=await connection.execute(`SELECT
      (SELECT COUNT(*) FROM announcements WHERE author_id=?) announcementCount,
      (SELECT COUNT(*) FROM enrollments e JOIN students st ON st.id=e.student_id WHERE st.user_id=?) enrollmentCount,
      (SELECT COUNT(*) FROM appointments a JOIN students st ON st.id=a.student_id WHERE st.user_id=?) studentAppointmentCount,
      (SELECT COUNT(*) FROM appointments a JOIN faculty f ON f.id=a.faculty_id WHERE f.user_id=?) facultyAppointmentCount,
      (SELECT COUNT(*) FROM subject_offerings o JOIN faculty f ON f.id=o.faculty_id WHERE f.user_id=?) offeringCount,
      (SELECT COUNT(*) FROM schedule_attachments WHERE created_by=?) attachmentCount,
      (SELECT COUNT(*) FROM grade_records WHERE graded_by=?) gradeCount,
      (SELECT COUNT(*) FROM grading_policy WHERE updated_by=?) policyCount,
      (SELECT COUNT(*) FROM appointment_availability a JOIN faculty f ON f.id=a.faculty_id WHERE f.user_id=?) availabilityCount,
      (SELECT COUNT(*) FROM appointment_exceptions a JOIN faculty f ON f.id=a.faculty_id WHERE f.user_id=?) exceptionCount`,[id,id,id,id,id,id,id,id,id,id]);
    const blockers=Object.entries(history).filter(([,count])=>Number(count)>0).map(([name])=>name.replace(/Count$/,''));
    if(blockers.length){await connection.rollback();return fail(res,`Protected records (${blockers.join(', ')}) prevent permanent deletion. Archive this account instead.`,409);}
    const [[photo]]=await connection.execute('SELECT storage_key FROM profile_photos WHERE user_id=? FOR UPDATE',[id]);photoKey=photo?.storage_key||null;
    await connection.execute("UPDATE audit_logs SET metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()),'$.deletedActorId',?),user_id=NULL WHERE user_id=?",[id,id]);
    await connection.execute('DELETE FROM notification_recipients WHERE user_id=?',[id]);
    await connection.execute('DELETE FROM password_reset_tokens WHERE user_id=?',[id]);
    await connection.execute('DELETE FROM email_change_tokens WHERE user_id=?',[id]);
    await connection.execute('DELETE FROM email_verification_tokens WHERE user_id=?',[id]);
    await connection.execute('UPDATE mail_delivery_events SET user_id=NULL WHERE user_id=?',[id]);
    await connection.execute('DELETE FROM auth_sessions WHERE user_id=?',[id]);
    await connection.execute('DELETE FROM profile_contacts WHERE user_id=?',[id]);
    await connection.execute('DELETE FROM profile_photos WHERE user_id=?',[id]);
    await connection.execute('DELETE FROM students WHERE user_id=?',[id]);
    await connection.execute('DELETE FROM faculty WHERE user_id=?',[id]);
    await connection.execute('DELETE FROM users WHERE id=?',[id]);
    await connection.execute('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?)',[req.user.sub,'ACCOUNT_DELETED','users',id,JSON.stringify({reason:reason.trim(),deletedEmail:user.email,deletedExternalId:user.external_id,deletedRole:user.role})]);
    await connection.commit();
    if(photoKey){const directory=process.env.UPLOAD_DIR?path.resolve(process.env.UPLOAD_DIR):fileURLToPath(new URL('../private-uploads/',import.meta.url));unlink(path.join(directory,`profile-${photoKey}.webp`)).catch(error=>console.error('Deleted account photo cleanup:',error.code));}
    return ok(res,null,'Account permanently deleted.');
  }catch(error){await connection.rollback();if(error.code==='ER_ROW_IS_REFERENCED_2')return fail(res,'Protected records prevent permanent deletion. Archive this account instead.',409);next(error);}finally{try{await connection.query("SELECT RELEASE_LOCK('sbaa:admin:status')");}catch{}connection.release();}
});
export default router;
