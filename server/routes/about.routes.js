import { Router } from 'express';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';

const router=Router();router.use(authenticate);
const fields=['overview','history','mission','vision','departmentValues','programs','goals','objectives','retentionPolicy','sourceAttribution','services','contact'];
const column=field=>field.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`);
const select=`SELECT ${fields.map(field=>`\`${column(field)}\` ${field}`).join(',')},status,updated_at updatedAt FROM about_sbaa WHERE id=1`;
router.get('/',async(req,res,next)=>{try{const [[about]]=await pool.query(select);if(req.user.role!=='ADMIN'&&about?.status!=='PUBLISHED')return ok(res,{status:'UNAVAILABLE'},'Department information has not been published.');return ok(res,about||{status:'UNAVAILABLE'});}catch(error){next(error);}});
router.get('/revisions',authorize('ADMIN'),async(req,res,next)=>{try{const [rows]=await pool.query('SELECT id,revision_number revisionNumber,status,changed_by changedBy,created_at createdAt FROM about_sbaa_revisions WHERE about_id=1 ORDER BY revision_number DESC LIMIT 30');return ok(res,rows);}catch(error){next(error);}});
router.put('/',authorize('ADMIN'),async(req,res,next)=>{try{
  const status=req.body?.status;
  if(!['DRAFT','PUBLISHED'].includes(status))return fail(res,'Choose Draft or Published.',422);
  const values={};for(const field of fields){const value=req.body?.[field];if(typeof value!=='string'||value.length>8000)return fail(res,`Enter valid ${field} content.`,422);values[field]=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim();}
  if(status==='PUBLISHED'&&(!req.body?.confirmedSource||['overview','mission','vision','programs','sourceAttribution'].some(field=>!values[field])))return fail(res,'Publishing requires the handbook source, core content, and confirmation.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    await connection.execute(`UPDATE about_sbaa SET ${fields.map(field=>`\`${column(field)}\`=?`).join(',')},status=? WHERE id=1`,[...fields.map(field=>values[field]),status]);
    const [[revision]]=await connection.query('SELECT COALESCE(MAX(revision_number),0)+1 nextRevision FROM about_sbaa_revisions WHERE about_id=1 FOR UPDATE');
    await connection.execute('INSERT INTO about_sbaa_revisions(about_id,revision_number,content_snapshot,status,changed_by) VALUES (1,?,?,?,?)',[revision.nextRevision,JSON.stringify({...values,status}),status,req.user.sub]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,?,'about_sbaa',1,?)",[req.user.sub,status==='PUBLISHED'?'ABOUT_PUBLISHED':'ABOUT_DRAFT_SAVED',JSON.stringify({status,revision:revision.nextRevision})]);
    await connection.commit();return ok(res,{revision:revision.nextRevision},status==='PUBLISHED'?'About SBAA published.':'About SBAA draft saved.');
  }catch(error){await connection.rollback();throw error;}finally{connection.release();}
}catch(error){next(error);}});
export default router;
