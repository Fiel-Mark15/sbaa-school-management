import { pool } from '../database/pool.js';
import { createSession, digest, revokeUserSessions } from '../utils/sessions.js';
import { mailAvailable, checkMailService, safeMailErrorCode, mailFailureOutcome, sendResetMail, sendPasswordChangedMail, sendEmailChangedNotice } from '../utils/mail.js';
import { hashPassword, verifyPassword, passwordValid } from '../utils/password.js';
import { env } from '../config/env.js';
import { randomBytes } from 'node:crypto';
import { fail, ok } from '../utils/response.js';
import { requestCurrentEmailVerification } from '../utils/email-verification.js';
import { clearSessionCookie, csrfTokenForSession, setSessionCookie } from '../utils/session-cookie.js';

const publicUser = (user) => ({ id: user.id, email: user.email, role: user.role, firstName: user.first_name, middleName:user.middle_name, lastName: user.last_name, status: user.status });
const validName=(value,optional=false)=>optional&&(value==null||value.trim?.()==='') || typeof value==='string'&&value.length<=100&&/^[\p{L}\p{M}][\p{L}\p{M} '’-]*$/u.test(value.trim());

export async function register(req, res, next) {
  let connection;
  try {
    const { firstName, middleName, lastName, studentId, email, password } = req.body || {};
    const errors = [];
    if (!validName(firstName)) errors.push({ field: 'firstName', message: 'Enter a valid first name up to 100 characters.' });
    if (!validName(middleName,true)) errors.push({ field: 'middleName', message: 'Enter a valid middle name or leave it blank.' });
    if (!validName(lastName)) errors.push({ field: 'lastName', message: 'Enter a valid last name up to 100 characters.' });
    if (typeof studentId !== 'string' || !/^[A-Za-z0-9-]{4,40}$/.test(studentId.trim()) || studentId.includes('@')) errors.push({ field: 'studentId', message: 'Enter the student number on your school ID.' });
    if (typeof email !== 'string' || email.length > 190 || !/^\S+@\S+\.\S+$/.test(email)) errors.push({ field: 'email', message: 'Enter a valid email address.' });
    if (!passwordValid(password)) errors.push({ field: 'password', message: 'Use at least 8 characters, one uppercase letter, and one special character. Avoid common passwords.' });
    if (errors.length) return fail(res, 'Please correct the highlighted fields.', 422, errors);
    connection = await pool.getConnection(); await connection.beginTransaction();
    const passwordHash = await hashPassword(password);
    const [result] = await connection.execute('INSERT INTO users (external_id, email, password_hash, role, first_name, middle_name, last_name, status) VALUES (?, ?, ?, \'STUDENT\', ?, ?, ?, \'ACTIVE\')', [studentId.trim(), email.trim().toLowerCase(), passwordHash, firstName.trim(),middleName?.trim()||null,lastName.trim()]);
    await connection.execute('INSERT INTO students (user_id, student_no) VALUES (?, ?)', [result.insertId, studentId.trim()]);
    await connection.execute('INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, \'ACCOUNT_REGISTERED\', \'users\', ?)', [result.insertId, result.insertId]);
    await connection.commit();
    let verificationOutcome='NOT_SENT';
    try{
      const delivery=await requestCurrentEmailVerification(result.insertId,result.insertId);
      verificationOutcome=delivery.outcome||'NOT_SENT';
    }catch{
      // The committed account must never look like a failed registration just
      // because mail is temporarily unavailable. Users can resend from Profile.
    }
    const mailNotice=email.trim().toLowerCase().endsWith('.test')?' This is a test-only address and cannot receive real email.':verificationOutcome==='PROVIDER_ACCEPTED'?' A verification message was accepted by the mail provider; check your inbox and spam folder.':verificationOutcome==='DEVELOPMENT_LOG'?' Email is in development mode, so no message was delivered.':' Email verification was not confirmed; sign in and retry from Profile.';
    return ok(res, { active: true, academicRecordsLinked: false, verificationOutcome }, `Student account created. You can sign in now; academic records appear once school staff verify and link them.${mailNotice}`, 201);
  } catch (error) {
    if (connection) await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return fail(res, 'That email address or student ID is already registered.', 409);
    return next(error);
  } finally { connection?.release(); }
}
export async function login(req, res, next) {
  try {
    const { identifier, password } = req.body || {};
    const errors = [];
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 190) errors.push({ field: 'identifier', message: 'Email or student ID is required.' });
    if (typeof password !== 'string' || !password) errors.push({ field: 'password', message: 'Password is required.' });
    if (errors.length) return fail(res, 'Please correct the highlighted fields.', 422, errors);
    const [rows] = await pool.execute('SELECT id, email, password_hash, role, first_name, middle_name, last_name, status FROM users WHERE email = ? OR external_id = ? LIMIT 1', [identifier.trim(), identifier.trim()]);
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) return fail(res, 'Invalid email/student ID or password.', 401);
    if (user.status !== 'ACTIVE') return fail(res, 'This account is unavailable. Please contact the administrator.', 403);
    const safeUser = publicUser(user);
    const token = await createSession(user.id,pool,req.headers['user-agent']);
    await pool.execute("INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'LOGIN', 'users', ?)", [user.id, user.id]);
    await pool.execute('UPDATE users SET last_login_at=UTC_TIMESTAMP() WHERE id=?',[user.id]);
    if (env.sessionTransport === 'cookie') {
      setSessionCookie(res, token);
      return ok(res, { user: safeUser, csrfToken: csrfTokenForSession(digest(token)) }, 'Welcome back.');
    }
    return ok(res, { token, user: safeUser }, 'Welcome back.');
  } catch (error) { return next(error); }
}
export async function me(req, res, next) {
  try {
    const [rows] = await pool.execute('SELECT id, email, role, first_name, middle_name, last_name, status FROM users WHERE id = ? LIMIT 1', [req.user.sub]);
    if (!rows[0] || rows[0].status !== 'ACTIVE') return fail(res, 'Account is unavailable.', 401);
    return ok(res, publicUser(rows[0]));
  } catch (error) { return next(error); }
}
export function csrf(req, res) {
  res.set('Cache-Control', 'no-store');
  return ok(res, { csrfToken: env.sessionTransport === 'cookie' ? csrfTokenForSession(req.sessionDigest) : null });
}
export async function logout(req, res, next) {
  try {
    await pool.execute('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE id=?', [req.user.sessionId]);
    await pool.execute("INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'LOGOUT', 'users', ?)", [req.user.sub, req.user.sub]);
    if (env.sessionTransport === 'cookie') clearSessionCookie(res);
    return ok(res, null, 'Signed out.');
  } catch (error) { next(error); }
}
const resetResponse='If an eligible account matches this address, the portal will attempt to send reset instructions. Check your inbox and spam folder, or contact the administrator.';
export async function forgotPassword(req,res,next){
  try{
    if(!mailAvailable())return fail(res,'Password reset email is not configured. Contact the administrator.',503);
    const email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'';
    if(!/^\S+@\S+\.\S+$/.test(email)||email.length>190)return fail(res,'Enter a valid email address.',422);
    try{await checkMailService();}catch(error){
      await pool.execute("INSERT INTO mail_delivery_events (purpose,outcome,error_code) VALUES ('RESET','PROVIDER_REJECTED',?)",[safeMailErrorCode(error)]);
      console.error('Mail service unavailable:',safeMailErrorCode(error));return fail(res,'Password reset email is temporarily unavailable.',503);
    }
    const started=Date.now();
    const [[user]]=await pool.execute("SELECT id,email,first_name firstName FROM users WHERE email=? AND status='ACTIVE'",[email]);
    if(user){
      const token=randomBytes(32).toString('base64url');
      await pool.execute('INSERT INTO password_reset_tokens (user_id,token_digest,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))',[user.id,digest(token)]);
      try{
        const sent=await sendResetMail(user.email,`${env.appPublicUrl}/reset-password?token=${encodeURIComponent(token)}`,user.firstName);
        await pool.execute("INSERT INTO mail_delivery_events (user_id,purpose,outcome,message_id) VALUES (?,'RESET',?,?)",[user.id,env.mailMode==='development'?'DEVELOPMENT_LOG':'PROVIDER_ACCEPTED',sent.messageId?.slice(0,255)||null]);
      }catch(error){
        // Preserve the expiring link: a transport failure can happen after acceptance.
        await pool.execute("INSERT INTO mail_delivery_events (user_id,purpose,outcome,error_code) VALUES (?,'RESET',?,?)",[user.id,mailFailureOutcome(error),safeMailErrorCode(error)]);
        console.error('Reset delivery not confirmed:',safeMailErrorCode(error));
      }
    }
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,650-(Date.now()-started))));
    return ok(res,null,resetResponse);
  }catch(error){next(error);}
}
export async function validateResetToken(req,res,next){
  res.set('Cache-Control','no-store').set('Referrer-Policy','no-referrer');
  const token=req.query.token;
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return fail(res,'This reset link is invalid or has expired.',400);
  try{
    const [[row]]=await pool.execute("SELECT u.email FROM password_reset_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_digest=? AND t.used_at IS NULL AND t.expires_at>UTC_TIMESTAMP() AND u.status='ACTIVE'",[digest(token)]);
    if(!row)return fail(res,'This reset link is invalid or has expired.',400);
    const [local,domain]=row.email.split('@');
    return ok(res,{maskedEmail:`${local[0]}***@${domain}`});
  }catch(error){next(error);}
}
export async function resetPassword(req,res,next){
  const {token,password}=req.body||{};
  res.set('Cache-Control','no-store').set('Referrer-Policy','no-referrer');
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!passwordValid(password))return fail(res,'Invalid reset link or password format.',422);
  const connection=await pool.getConnection();
  try{
    await connection.beginTransaction();
    const [[reset]]=await connection.execute("SELECT t.id,t.user_id,u.email,u.first_name firstName FROM password_reset_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_digest=? AND t.used_at IS NULL AND t.expires_at>UTC_TIMESTAMP() AND u.status='ACTIVE' FOR UPDATE",[digest(token)]);
    if(!reset){await connection.rollback();return fail(res,'This reset link is invalid or has expired.',400);}
    await connection.execute("UPDATE users SET password_hash=? WHERE id=? AND status='ACTIVE'",[await hashPassword(password),reset.user_id]);
    await connection.execute('UPDATE password_reset_tokens SET used_at=UTC_TIMESTAMP() WHERE user_id=? AND used_at IS NULL',[reset.user_id]);
    await connection.execute('UPDATE email_change_tokens SET used_at=UTC_TIMESTAMP() WHERE user_id=? AND used_at IS NULL',[reset.user_id]);
    await revokeUserSessions(reset.user_id,connection);
    await connection.execute("INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,'PASSWORD_RESET','users',?)",[reset.user_id,reset.user_id]);
    await connection.commit();
    sendPasswordChangedMail(reset.email,reset.firstName).catch(error=>console.error('Password change notice failed:',safeMailErrorCode(error)));
    return ok(res,null,'Password updated. Sign in with your new password.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
}
export async function validateEmailChange(req,res,next){
  res.set('Cache-Control','no-store').set('Referrer-Policy','no-referrer');
  const token=req.query.token;
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return fail(res,'This verification link is invalid or expired.',400);
  try{
    const [[row]]=await pool.execute("SELECT pending_email pendingEmail FROM email_change_tokens WHERE token_digest=? AND used_at IS NULL AND expires_at>UTC_TIMESTAMP()",[digest(token)]);
    if(!row)return fail(res,'This verification link is invalid or expired.',400);
    return ok(res,{pendingEmail:row.pendingEmail});
  }catch(error){next(error);}
}
export async function confirmEmailChange(req,res,next){
  res.set('Cache-Control','no-store').set('Referrer-Policy','no-referrer');
  const token=req.body?.token;
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return fail(res,'This verification link is invalid or expired.',400);
  const connection=await pool.getConnection();let previous;
  try{
    await connection.beginTransaction();
    const [[row]]=await connection.execute("SELECT t.id,t.user_id,t.pending_email,u.email previousEmail,u.first_name firstName FROM email_change_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_digest=? AND t.used_at IS NULL AND t.expires_at>UTC_TIMESTAMP() AND u.status='ACTIVE' FOR UPDATE",[digest(token)]);
    if(!row){await connection.rollback();return fail(res,'This verification link is invalid or expired.',400);}
    const [[existing]]=await connection.execute('SELECT id FROM users WHERE email=? AND id<>?',[row.pending_email,row.user_id]);
    if(existing){await connection.rollback();return fail(res,'That email is already registered.',409);}
    await connection.execute('UPDATE users SET email=?,email_verified_at=UTC_TIMESTAMP() WHERE id=?',[row.pending_email,row.user_id]);
    await connection.execute('UPDATE email_change_tokens SET used_at=UTC_TIMESTAMP() WHERE user_id=? AND used_at IS NULL',[row.user_id]);
    await connection.execute('UPDATE email_verification_tokens SET used_at=UTC_TIMESTAMP() WHERE user_id=? AND used_at IS NULL',[row.user_id]);
    await revokeUserSessions(row.user_id,connection);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'EMAIL_CHANGED','users',?)",[row.user_id,row.user_id]);
    await connection.commit();previous=row;
  }catch(error){await connection.rollback();if(error.code==='ER_DUP_ENTRY')return fail(res,'That email is already registered.',409);return next(error);}finally{connection.release();}
  void (async()=>{
    let outcome,errorCode=null,messageId=null;
    try{
      const sent=await sendEmailChangedNotice(previous.previousEmail,previous.firstName);
      outcome=env.mailMode==='development'?'DEVELOPMENT_LOG':'PROVIDER_ACCEPTED';
      messageId=sent.messageId?.slice(0,255)||null;
    }catch(error){outcome='PROVIDER_REJECTED';errorCode=safeMailErrorCode(error);console.error('Email change notice failed:',errorCode);}
    try{
      // The account may have been removed while the asynchronous notice was in flight.
      await pool.execute("INSERT INTO mail_delivery_events(user_id,purpose,outcome,message_id,error_code) SELECT id,'EMAIL_CHANGED',?,?,? FROM users WHERE id=?",[outcome,messageId,errorCode,previous.user_id]);
    }catch(error){console.error('Mail diagnostic recording failed:',error.code||'DATABASE_ERROR');}
  })();
  return ok(res,null,'New email verified. Please sign in again.');
}
export async function validateCurrentEmail(req,res,next){
  res.set('Cache-Control','no-store').set('Referrer-Policy','no-referrer');
  const token=req.query.token;
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return fail(res,'This verification link is invalid or expired.',400);
  try{
    const [[row]]=await pool.execute("SELECT t.email FROM email_verification_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_digest=? AND t.used_at IS NULL AND t.expires_at>UTC_TIMESTAMP() AND u.status='ACTIVE' AND u.email=t.email AND u.email_verified_at IS NULL",[digest(token)]);
    return row?ok(res,{email:row.email}):fail(res,'This verification link is invalid, expired, or already used.',400);
  }catch(error){next(error);}
}
export async function confirmCurrentEmail(req,res,next){
  res.set('Cache-Control','no-store').set('Referrer-Policy','no-referrer');
  const token=req.body?.token;
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return fail(res,'This verification link is invalid or expired.',400);
  const connection=await pool.getConnection();try{
    await connection.beginTransaction();
    const [[row]]=await connection.execute("SELECT t.id,t.user_id,t.email FROM email_verification_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_digest=? AND t.used_at IS NULL AND t.expires_at>UTC_TIMESTAMP() AND u.status='ACTIVE' AND u.email=t.email AND u.email_verified_at IS NULL FOR UPDATE",[digest(token)]);
    if(!row){await connection.rollback();return fail(res,'This verification link is invalid, expired, or already used.',400);}
    const [updated]=await connection.execute('UPDATE users SET email_verified_at=UTC_TIMESTAMP() WHERE id=? AND email=? AND email_verified_at IS NULL',[row.user_id,row.email]);
    if(updated.affectedRows!==1){await connection.rollback();return fail(res,'This verification link is invalid, expired, or already used.',400);}
    await connection.execute('UPDATE email_verification_tokens SET used_at=UTC_TIMESTAMP() WHERE user_id=? AND used_at IS NULL',[row.user_id]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'CURRENT_EMAIL_VERIFIED','users',?)",[row.user_id,row.user_id]);
    await connection.commit();return ok(res,null,'Email verified. You may return to your profile.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
}
