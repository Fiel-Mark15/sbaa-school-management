import { randomBytes } from 'node:crypto';
import { pool } from '../database/pool.js';
import { digest } from './sessions.js';
import { env } from '../config/env.js';
import { mailAvailable, safeMailErrorCode, mailFailureOutcome, sendCurrentEmailVerificationMail } from './mail.js';

const cooldownSeconds=60;
function timing(row){
  if(!row?.createdEpoch)return {retryAfterSeconds:0,nextAllowedAt:null};
  const nextEpoch=Number(row?.createdEpoch||0)+cooldownSeconds;
  const retryAfterSeconds=Math.max(0,Math.ceil(nextEpoch-Number(row?.nowEpoch||0)));
  return {retryAfterSeconds,nextAllowedAt:retryAfterSeconds?new Date(nextEpoch*1000).toISOString():null};
}
export async function currentEmailVerificationStatus(userId){
  const [[user]]=await pool.execute(`SELECT u.email,u.email_verified_at verifiedAt,
    (SELECT UNIX_TIMESTAMP(t.created_at) FROM email_verification_tokens t WHERE t.user_id=u.id AND t.email=u.email
      AND t.used_at IS NULL AND t.expires_at>UTC_TIMESTAMP() ORDER BY t.id DESC LIMIT 1) createdEpoch,
    (SELECT m.outcome FROM mail_delivery_events m WHERE m.user_id=u.id AND m.purpose='CURRENT_EMAIL_VERIFICATION'
      ORDER BY m.id DESC LIMIT 1) deliveryOutcome,UNIX_TIMESTAMP() nowEpoch FROM users u WHERE u.id=?`,[userId]);
  if(!user)return null;
  return {email:user.email,verifiedAt:user.verifiedAt,deliveryOutcome:user.deliveryOutcome,
    lastRequestedAt:user.createdEpoch?new Date(Number(user.createdEpoch)*1000).toISOString():null,...timing(user)};
}
export async function requestCurrentEmailVerification(userId,actorId){
  if(!mailAvailable())return {status:503,message:'Email verification is not configured.'};
  const connection=await pool.getConnection();let user,token,tokenId;
  try{
    await connection.beginTransaction();
    [[user]]=await connection.execute("SELECT id,email,first_name firstName,email_verified_at verifiedAt FROM users WHERE id=? AND status='ACTIVE' FOR UPDATE",[userId]);
    if(!user){await connection.rollback();return {status:404,message:'Active account not found.'};}
    if(user.verifiedAt){await connection.rollback();return {status:409,message:'This email is already verified.'};}
    if(env.mailMode==='smtp'&&user.email.toLowerCase().endsWith('.test')){await connection.rollback();return {status:422,message:'This is a test-only address and cannot receive real email. Update the account address first.'};}
    const [[recent]]=await connection.execute(`SELECT UNIX_TIMESTAMP(created_at) createdEpoch,UNIX_TIMESTAMP() nowEpoch
      FROM email_verification_tokens WHERE user_id=? AND email=? AND used_at IS NULL AND expires_at>UTC_TIMESTAMP()
      ORDER BY id DESC LIMIT 1`,[userId,user.email]);
    const wait=timing(recent);
    if(wait.retryAfterSeconds){await connection.rollback();return {status:429,message:`Please wait ${wait.retryAfterSeconds} seconds before requesting another verification email.`,...wait};}
    token=randomBytes(32).toString('base64url');
    const [created]=await connection.execute('INSERT INTO email_verification_tokens(user_id,email,token_digest,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))',[userId,user.email,digest(token)]);
    tokenId=created.insertId;
    await connection.commit();
  }catch(error){await connection.rollback();throw error;}finally{connection.release();}
  let outcome,messageId=null,errorCode=null;
  try{
    const sent=await sendCurrentEmailVerificationMail(user.email,`${env.appPublicUrl}/verify-current-email?token=${encodeURIComponent(token)}`,user.firstName);
    outcome=env.mailMode==='development'?'DEVELOPMENT_LOG':'PROVIDER_ACCEPTED';messageId=sent.messageId?.slice(0,255)||null;
  }catch(error){
    outcome=mailFailureOutcome(error);errorCode=safeMailErrorCode(error);
    // Only definitive pre-delivery failures release the cooldown. Unknown outcomes
    // keep the expiring link usable in case the provider already accepted it.
    if(outcome==='PROVIDER_REJECTED')await pool.execute('DELETE FROM email_verification_tokens WHERE id=?',[tokenId]);
  }
  await pool.execute("INSERT INTO mail_delivery_events(user_id,purpose,outcome,message_id,error_code) VALUES (?,'CURRENT_EMAIL_VERIFICATION',?,?,?)",[userId,outcome,messageId,errorCode]);
  if(errorCode){
    const wait=outcome==='PROVIDER_UNKNOWN'?await currentEmailVerificationStatus(userId):{retryAfterSeconds:0,nextAllowedAt:null};
    return {status:503,message:outcome==='PROVIDER_UNKNOWN'?'The provider did not confirm delivery. A link may still arrive; check your inbox before retrying.':'Verification email was rejected before delivery. Please try again later.',outcome,errorCode,retryAfterSeconds:wait.retryAfterSeconds,nextAllowedAt:wait.nextAllowedAt};
  }
  await pool.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'CURRENT_EMAIL_VERIFICATION_REQUESTED','users',?)",[actorId,userId]);
  const wait=await currentEmailVerificationStatus(userId);
  return {status:200,message:outcome==='DEVELOPMENT_LOG'?'Development mode logged a verification link; no email was sent.':'Verification email accepted by the provider. Check the recipient inbox; delivery is not yet confirmed.',outcome,retryAfterSeconds:wait.retryAfterSeconds,nextAllowedAt:wait.nextAllowedAt};
}
