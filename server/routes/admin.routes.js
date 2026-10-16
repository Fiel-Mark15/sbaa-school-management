import { Router } from 'express';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { ok } from '../utils/response.js';
import { env } from '../config/env.js';
import { mailAvailable } from '../utils/mail.js';

const router = Router();
router.get('/system-overview', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const [[result]] = await pool.query('SELECT COUNT(*) AS auditEvents FROM audit_logs');
    return ok(res, { auditEvents: result.auditEvents });
  } catch (error) { return next(error); }
});
router.get('/mail-diagnostics',authenticate,authorize('ADMIN'),async(req,res,next)=>{
  try{
    const email=typeof req.query.email==='string'?req.query.email.trim().toLowerCase():'';
    const [[account]]=email?await pool.execute('SELECT id,status,role FROM users WHERE email=? LIMIT 1',[email]):[[null]];
    const [events]=await pool.query(`SELECT m.id,m.purpose,m.outcome,m.message_id messageId,m.error_code errorCode,m.created_at createdAt
      FROM mail_delivery_events m WHERE (?=0 OR m.user_id=?) ORDER BY m.id DESC LIMIT 25`,[email?1:0,account?.id||0]);
    return ok(res,{
      mode:env.mailMode||'unconfigured',configured:mailAvailable(),smtpHostConfigured:Boolean(env.smtp.host),smtpSenderConfigured:Boolean(env.smtp.from),smtpCredentialsConfigured:Boolean(env.smtp.user&&env.smtp.password),
      httpsProviderConfigured:Boolean(env.resendApiKey&&env.mailFrom),publicUrl:env.appPublicUrl,
      account:email?(account?{status:account.status,role:account.role}:null):undefined,
      events,
      note:'Provider acceptance does not prove mailbox delivery. Check provider logs, recipient spam, and school quarantine.'
    });
  }catch(error){next(error);}
});
export default router;
