import { appendFile, readFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function transport(){return nodemailer.createTransport({host:env.smtp.host,port:env.smtp.port,secure:env.smtp.secure,...(env.smtp.user&&env.smtp.password?{auth:{user:env.smtp.user,pass:env.smtp.password}}:{}),connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});}
async function retryTemporaryDns(operation){
  try{return await operation();}
  catch(error){
    // DNS failures happen before an SMTP connection exists, so this retry cannot duplicate a sent message.
    if(!['EDNS','EAI_AGAIN'].includes(error?.code))throw error;
    await new Promise(resolve=>setTimeout(resolve,350));
    return operation();
  }
}
const senderAddress=()=>env.smtp.from?.match(/^SBAA School Portal <([^<>\s@]+@[^<>\s@]+)>$/)?.[1]?.toLowerCase();
export function mailAvailable(){
  if(env.mailMode==='development')return process.env.NODE_ENV!=='production';
  if(env.mailMode==='resend')return Boolean(env.resendApiKey && /^SBAA School Portal <[^<>\s@]+@[^<>\s@]+>$/.test(env.mailFrom));
  if(env.mailMode!=='smtp'||!env.smtp.host||!env.smtp.from||!Number.isInteger(env.smtp.port)||env.smtp.port<1||env.smtp.port>65535)return false;
  if(env.smtp.port===465?!env.smtp.secure:env.smtp.secure)return false;
  if(env.smtp.host.toLowerCase()==='smtp.gmail.com')return Boolean(env.smtp.user&&env.smtp.password&&senderAddress()===env.smtp.user.toLowerCase());
  return Boolean(env.smtp.user)===Boolean(env.smtp.password);
}
export function safeMailErrorCode(error){const code=error?.code;return typeof code==='string'&&/^[A-Z0-9_]{2,64}$/.test(code)?code:'MAIL_ERROR';}
// A transport error after DATA may occur after provider acceptance. Never assume
// that a missing acknowledgement means the emailed link was not delivered.
export function mailFailureOutcome(error){
  return ['EDNS','EAI_AGAIN','EAUTH','EENVELOPE','HTTP_400','HTTP_401','HTTP_403','HTTP_422'].includes(error?.code)?'PROVIDER_REJECTED':'PROVIDER_UNKNOWN';
}
export async function checkMailService(){if(!mailAvailable())throw new Error('Mail is not configured.');if(env.mailMode==='smtp')await retryTemporaryDns(()=>transport().verify());}
async function sendViaResend({address,subject,text,html,logo}) {
  // Do not automatically retry an ambiguous network failure: the provider may
  // have accepted the first request even if its acknowledgement was lost.
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.mailFrom, to: [address], subject, text, html,
        ...(html ? { attachments: [{ filename: 'sbaa-logo.png', content: logo.toString('base64'), content_id: 'sbaa-school-portal-logo' }] } : {}) })
    });
  } catch {
    const error = new Error('Mail provider response was not confirmed.'); error.code = 'HTTP_UNKNOWN'; throw error;
  }
  if (!response.ok) {
    const error = new Error('Mail provider rejected the request.'); error.code = `HTTP_${response.status}`; throw error;
  }
  let data;
  try { data = await response.json(); } catch {
    const error = new Error('Mail provider response was not confirmed.'); error.code = 'HTTP_UNKNOWN'; throw error;
  }
  if (typeof data?.id !== 'string' || !data.id) {
    const error = new Error('Mail provider response was not confirmed.'); error.code = 'HTTP_UNKNOWN'; throw error;
  }
  return { messageId: data.id };
}
async function send({address,subject,text,html,devLine}){
  if(env.mailMode==='development'){
    if(process.env.NODE_ENV==='production')throw new Error('Development mail cannot run in production.');
    await appendFile(new URL('../dev-mail.log',import.meta.url),`${devLine}\n`,{mode:0o600});
    return {messageId:'development-log'};
  }
  if(!mailAvailable())throw new Error('Mail is not configured.');
  const logo=await readFile(new URL('../../public/assets/sbaa-logo.png',import.meta.url));
  if(env.mailMode==='resend')return sendViaResend({address,subject,text,html,logo});
  const result=await retryTemporaryDns(()=>transport().sendMail({from:env.smtp.from,to:address,subject,text,html,attachments:html?[{filename:'sbaa-logo.png',content:logo,cid:'sbaa-school-portal-logo',contentDisposition:'inline'}]:[]}));
  if(result.rejected?.length||!result.accepted?.length)throw new Error('Mail provider rejected the recipient.');
  return {messageId:result.messageId};
}
function emailLayout(heading,body,buttonLabel,link){
  const action=buttonLabel&&link?`<p style="margin:22px 0;text-align:center"><a href="${escapeHtml(link)}" style="display:inline-block;background:#075e49;color:#ffffff;padding:14px 24px;border-radius:7px;text-decoration:none;font-size:15px;font-weight:bold">${escapeHtml(buttonLabel)}</a></p>`:'';
  const fallback=link?`<p style="font-size:12px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word;margin:20px 0 0">If the button does not work, copy this link:<br><a href="${escapeHtml(link)}" style="color:#075e49">${escapeHtml(link)}</a></p>`:'';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f3f8f5;font-family:Arial,Helvetica,sans-serif;color:#163c31"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#f3f8f5"><tr><td align="center" style="padding:20px 12px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;max-width:600px;background:#ffffff;border:1px solid #dcece4"><tr><td style="background:#075e49;padding:18px 24px;color:#ffffff;font-size:17px;font-weight:bold;line-height:38px"><img src="cid:sbaa-school-portal-logo" alt="SBAA School of Business Administration and Accountancy seal" width="38" height="38" style="display:inline-block;vertical-align:middle;margin-right:10px;background:#ffffff;border-radius:50%;object-fit:contain">SBAA School Portal</td></tr><tr><td style="padding:24px 28px 12px;font-size:14px;line-height:1.55"><h1 style="font-size:22px;line-height:1.25;margin:0 0 16px;color:#163c31">${escapeHtml(heading)}</h1>${body}${action}${fallback}</td></tr><tr><td style="padding:16px 28px 22px;border-top:1px solid #dcece4;color:#597367;font-size:12px;line-height:1.5">SBAA School Portal<br>School of Business Administration and Accountancy</td></tr></table></td></tr></table></body></html>`;
}
export async function sendResetMail(address,link,firstName='there'){
  const body=`<p>Hi ${escapeHtml(firstName)},</p><p>We received a request to reset your SBAA School Portal password. Use the button below to choose a new password.</p><p>This link expires in 30 minutes and can be used once. Your password will stay the same until you complete the reset.</p><p>If you did not request this, you can ignore this email. For help, contact your school's verified support channel.</p>`;
  const text=`Reset your password\n\nHi ${firstName},\n\nWe received a request to reset your SBAA School Portal password. Use the link below to choose a new password.\n\n${link}\n\nThis link expires in 30 minutes and can be used once. Your password will stay the same until you complete the reset.\n\nIf you did not request this, you can ignore this email. For help, contact your school's verified support channel.\n\nSBAA School Portal\nSchool of Business Administration and Accountancy`;
  return send({address,subject:'Reset your SBAA School Portal password',text,html:emailLayout('Reset your password',body,'Reset password',link),devLine:`Password reset for ${address}: ${link}`});
}
export async function sendPasswordChangedMail(address,firstName='there'){
  const text=`Hi ${firstName},\n\nYour SBAA School Portal password was changed. If you did not do this, contact your school's verified support channel immediately.\n\nSBAA School Portal`;
  return send({address,subject:'Your SBAA School Portal password changed',text,html:emailLayout('Password changed',`<p>Hi ${escapeHtml(firstName)},</p><p>Your SBAA School Portal password was changed. If you did not do this, contact your school's verified support channel immediately.</p>`),devLine:`Password changed notice for ${address}`});
}
export async function sendInviteMail(address,link){
  const text=`An administrator created your SBAA School Portal account. Set your password using this one-time link within 30 minutes:\n\n${link}\n\nIf you did not expect this invitation, contact the school administrator.`;
  return send({address,subject:'Your SBAA School Portal account',text,html:emailLayout('Set your password','<p>An administrator created your SBAA School Portal account. Use the button below within 30 minutes to set your password.</p><p>If you did not expect this invitation, contact the school administrator.</p>','Set password',link),devLine:`Account invitation for ${address}: ${link}`});
}
export async function sendEmailChangeMail(address,link,firstName='there'){
  const text=`Hi ${firstName},\n\nConfirm this new email address for your SBAA School Portal account within 30 minutes:\n\n${link}\n\nIf you did not request this, ignore this message. Your current email stays active until verification.`;
  return send({address,subject:'Verify your new SBAA School Portal email',text,html:emailLayout('Verify your new email',`<p>Hi ${escapeHtml(firstName)},</p><p>Confirm this new email address within 30 minutes. Your current email stays active until verification.</p>`,'Verify email',link),devLine:`Email change verification for ${address}: ${link}`});
}
export async function sendCurrentEmailVerificationMail(address,link,firstName='there'){
  const text=`Hi ${firstName},\n\nVerify that this is the email address for your SBAA School Portal account. Open this single-use link within 30 minutes:\n\n${link}\n\nIf you did not request this, ignore this message. No account details have changed.`;
  return send({address,subject:'Verify your SBAA School Portal email',text,html:emailLayout('Verify your email',`<p>Hi ${escapeHtml(firstName)},</p><p>Confirm that this is your current SBAA School Portal email address. This single-use link expires in 30 minutes.</p><p>If you did not request this, ignore this message. No account details have changed.</p>`,'Verify email',link),devLine:`Current email verification for ${address}: ${link}`});
}
export async function sendEmailChangedNotice(address,firstName='there'){
  const text=`Hi ${firstName},\n\nThe email address on your SBAA School Portal account was changed. If you did not do this, contact your school's verified support channel immediately.`;
  return send({address,subject:'Your SBAA School Portal email changed',text,html:emailLayout('Email changed',`<p>Hi ${escapeHtml(firstName)},</p><p>The email address on your account was changed. If this was not you, contact your school's verified support channel immediately.</p>`),devLine:`Email changed notice for ${address}`});
}
