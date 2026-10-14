import { Router } from 'express';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';

const router=Router();router.use(authenticate,authorize('ADMIN'));
const imageDirectory=process.env.UPLOAD_DIR?path.resolve(process.env.UPLOAD_DIR):fileURLToPath(new URL('../private-uploads/',import.meta.url));
const id=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const modules=['subjects','classes','firms','announcements','users','schedule_images'];
const source=`(
 SELECT 'subjects' module,s.id,CONCAT(s.code,' · ',s.name) title,(SELECT MAX(l.created_at) FROM audit_logs l WHERE l.entity_type='subjects' AND l.entity_id=s.id AND l.action='SUBJECT_ARCHIVED') archivedAt,(SELECT l.user_id FROM audit_logs l WHERE l.entity_type='subjects' AND l.entity_id=s.id AND l.action='SUBJECT_ARCHIVED' ORDER BY l.id DESC LIMIT 1) archivedBy FROM subjects s WHERE s.status='ARCHIVED'
 UNION ALL SELECT 'classes',o.id,CONCAT(sub.code,' · ',sec.name,' · ',t.academic_year,' ',t.semester),(SELECT MAX(l.created_at) FROM audit_logs l WHERE l.entity_type='subject_offerings' AND l.entity_id=o.id AND l.action='OFFERING_ARCHIVED'),(SELECT l.user_id FROM audit_logs l WHERE l.entity_type='subject_offerings' AND l.entity_id=o.id AND l.action='OFFERING_ARCHIVED' ORDER BY l.id DESC LIMIT 1) FROM subject_offerings o JOIN subjects sub ON sub.id=o.subject_id JOIN sections sec ON sec.id=o.section_id JOIN academic_terms t ON t.id=o.term_id WHERE o.status='ARCHIVED'
 UNION ALL SELECT 'firms',f.id,f.name,(SELECT MAX(l.created_at) FROM audit_logs l WHERE l.entity_type='firms' AND l.entity_id=f.id AND l.action='FIRM_ARCHIVED'),(SELECT l.user_id FROM audit_logs l WHERE l.entity_type='firms' AND l.entity_id=f.id AND l.action='FIRM_ARCHIVED' ORDER BY l.id DESC LIMIT 1) FROM firms f WHERE f.status='ARCHIVED'
 UNION ALL SELECT 'announcements',a.id,a.title,(SELECT MAX(l.created_at) FROM audit_logs l WHERE l.entity_type='announcements' AND l.entity_id=a.id AND l.action='ANNOUNCEMENT_ARCHIVED'),(SELECT l.user_id FROM audit_logs l WHERE l.entity_type='announcements' AND l.entity_id=a.id AND l.action='ANNOUNCEMENT_ARCHIVED' ORDER BY l.id DESC LIMIT 1) FROM announcements a WHERE a.status='ARCHIVED'
 UNION ALL SELECT 'users',u.id,CONCAT(u.first_name,' ',u.last_name,' · ',u.external_id),(SELECT MAX(l.created_at) FROM audit_logs l WHERE l.entity_type='users' AND l.entity_id=u.id AND l.action='ACCOUNT_ARCHIVED'),(SELECT l.user_id FROM audit_logs l WHERE l.entity_type='users' AND l.entity_id=u.id AND l.action='ACCOUNT_ARCHIVED' ORDER BY l.id DESC LIMIT 1) FROM users u WHERE u.status='ARCHIVED'
 UNION ALL SELECT 'schedule_images',a.id,a.title,(SELECT MAX(l.created_at) FROM audit_logs l WHERE l.entity_type='schedule_attachments' AND l.entity_id=a.id AND l.action='SCHEDULE_IMAGE_ARCHIVED'),(SELECT l.user_id FROM audit_logs l WHERE l.entity_type='schedule_attachments' AND l.entity_id=a.id AND l.action='SCHEDULE_IMAGE_ARCHIVED' ORDER BY l.id DESC LIMIT 1) FROM schedule_attachments a WHERE a.status='ARCHIVED'
) records`;
const restoreTargets={subjects:{table:'subjects',status:'ACTIVE'},classes:{table:'subject_offerings',status:'ACTIVE'},firms:{table:'firms',status:'DRAFT'},announcements:{table:'announcements',status:'DRAFT'},users:{table:'users',status:'DISABLED'},schedule_images:{table:'schedule_attachments',status:'DRAFT'}};
router.get('/',async(req,res,next)=>{try{
  const module=modules.includes(req.query.module)?req.query.module:'',search=String(req.query.search||'').trim().slice(0,100),page=Math.max(1,Math.min(100000,Number(req.query.page)||1));
  const params=[module,module,`%${search}%`],where="WHERE (?='' OR module=?) AND title LIKE ?";
  const [[count]]=await pool.query(`SELECT COUNT(*) total FROM ${source} ${where}`,params);
  const [rows]=await pool.query(`SELECT module,id,title,archivedAt,archivedBy FROM ${source} ${where} ORDER BY COALESCE(archivedAt,'1970-01-01') DESC,module,id DESC LIMIT 20 OFFSET ?`,[...params,(page-1)*20]);
  return ok(res,{rows,total:count.total,page});
}catch(error){next(error);}});
async function preview(connection,module,recordId){
  const config=restoreTargets[module];if(!config)return null;
  const [[record]]=await connection.execute(`SELECT id FROM ${config.table} WHERE id=? AND status='ARCHIVED'`,[recordId]);if(!record)return null;
  if(module==='subjects'){const [[dependent]]=await connection.execute('SELECT COUNT(*) total FROM subject_offerings WHERE subject_id=?',[recordId]);return {canDelete:dependent.total===0,reason:dependent.total?`${dependent.total} class assignment(s) depend on this subject.`:'No class assignments depend on this subject.',restoreStatus:'ACTIVE'};}
  if(module==='firms')return {canDelete:true,reason:'Firm deletion is checked again against database references when confirmed.',restoreStatus:'DRAFT'};
  if(module==='classes'){
    const [[counts]]=await connection.execute(`SELECT
      (SELECT COUNT(*) FROM enrollments WHERE offering_id=?) enrollments,
      (SELECT COUNT(*) FROM schedule_meetings WHERE offering_id=?) meetings,
      (SELECT COUNT(*) FROM schedule_attachments WHERE offering_id=?) scheduleImages,
      (SELECT COUNT(*) FROM grade_records g JOIN enrollments e ON e.id=g.enrollment_id WHERE e.offering_id=?) grades`,[recordId,recordId,recordId,recordId]);
    const dependencies=Object.entries(counts).filter(([,count])=>Number(count)>0).map(([name,count])=>`${count} ${name}`);
    return {canDelete:false,reason:dependencies.length?`Protected class history depends on this assignment: ${dependencies.join(', ')}. Keep it archived.`:'Class assignments are retained as academic history even when no dependent records are currently present.',dependencies:counts,restoreStatus:'ACTIVE'};
  }
  if(module==='users')return {canDelete:false,reason:'Account deletion requires separate reauthentication and academic-dependency checks in User Accounts.',restoreStatus:'DISABLED'};
  if(module==='announcements'){
    const [[counts]]=await connection.execute(`SELECT (SELECT COUNT(*) FROM notifications WHERE resource_type='announcement' AND resource_id=?) notifications,(SELECT COUNT(*) FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id WHERE n.resource_type='announcement' AND n.resource_id=?) inboxCopies,(SELECT COUNT(*) FROM announcement_images WHERE announcement_id=?) images`,[recordId,recordId,recordId]);
    return {canDelete:true,reason:`Permanent deletion removes this archived announcement, ${counts.notifications} notification(s), ${counts.inboxCopies} inbox copy/copies, and ${counts.images} private image(s). Audit events remain.`,dependencies:counts,restoreStatus:'DRAFT'};
  }
  return {canDelete:true,reason:'Permanent deletion removes this archived schedule image file and its database record. The class assignment and academic history remain.',restoreStatus:'DRAFT'};
}
router.get('/:module/:id/preview',async(req,res,next)=>{try{const recordId=id(req.params.id),module=req.params.module;if(!recordId||!modules.includes(module))return fail(res,'Archive record not found.',404);const result=await preview(pool,module,recordId);return result?ok(res,result):fail(res,'Archive record not found.',404);}catch(error){next(error);}});
router.patch('/:module/:id/restore',async(req,res,next)=>{
  const module=req.params.module,recordId=id(req.params.id),reason=req.body?.reason,config=restoreTargets[module];
  if(!config||!recordId||typeof reason!=='string'||!reason.trim()||reason.length>500)return fail(res,'Enter a valid archive record and restoration reason.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[record]]=await connection.execute(`SELECT id FROM ${config.table} WHERE id=? AND status='ARCHIVED' FOR UPDATE`,[recordId]);if(!record){await connection.rollback();return fail(res,'Archive record not found.',404);}
    if(module==='classes'){const [[subject]]=await connection.execute("SELECT s.status FROM subject_offerings o JOIN subjects s ON s.id=o.subject_id WHERE o.id=?",[recordId]);if(subject.status!=='ACTIVE'){await connection.rollback();return fail(res,'Restore the subject before its class assignment.',409);}}
    await connection.execute(`UPDATE ${config.table} SET status=? WHERE id=?`,[config.status,recordId]);
    await connection.execute('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?)',[req.user.sub,'ARCHIVE_RESTORED',config.table,recordId,JSON.stringify({from:'ARCHIVED',to:config.status,reason:reason.trim()})]);
    await connection.commit();return ok(res,{status:config.status},'Record restored. Review it before publishing or enabling access.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
router.delete('/subjects/:id',async(req,res,next)=>{
  const recordId=id(req.params.id),reason=req.body?.reason;if(!recordId||typeof reason!=='string'||!reason.trim()||reason.length>500)return fail(res,'Enter a subject and deletion reason.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[subject]]=await connection.execute("SELECT id,code FROM subjects WHERE id=? AND status='ARCHIVED' FOR UPDATE",[recordId]);if(!subject){await connection.rollback();return fail(res,'Archived subject not found.',404);}
    const [[dependent]]=await connection.execute('SELECT COUNT(*) total FROM subject_offerings WHERE subject_id=?',[recordId]);if(dependent.total){await connection.rollback();return fail(res,`${dependent.total} class assignment(s) depend on this subject. Delete is blocked; keep the subject archived.`,409);}
    await connection.execute('DELETE FROM subjects WHERE id=?',[recordId]);
    await connection.execute('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?)',[req.user.sub,'SUBJECT_DELETED','subjects',recordId,JSON.stringify({code:subject.code,reason:reason.trim()})]);
    await connection.commit();return ok(res,null,'Archived subject permanently deleted.');
  }catch(error){await connection.rollback();if(error.code==='ER_ROW_IS_REFERENCED_2')return fail(res,'Protected academic records refer to this subject. Keep it archived.',409);next(error);}finally{connection.release();}
});
router.delete('/:module(announcements|schedule_images)/:id',async(req,res,next)=>{
  const module=req.params.module,recordId=id(req.params.id),reason=req.body?.reason;
  if(!recordId||typeof reason!=='string'||!reason.trim()||reason.length>500)return fail(res,'Enter a valid archived record and deletion reason.',422);
  const table=module==='announcements'?'announcements':'schedule_attachments';
  const connection=await pool.getConnection();let filePath=null;
  try{
    await connection.beginTransaction();
    const [[record]]=await connection.execute(`SELECT storage_key storageKey FROM ${module==='announcements'?'announcement_images':'schedule_attachments'} WHERE ${module==='announcements'?'announcement_id':'id'}=? ${module==='announcements'?'':'AND status=\'ARCHIVED\''} FOR UPDATE`,[recordId]);
    const [[archived]]=await connection.execute(`SELECT id FROM ${table} WHERE id=? AND status='ARCHIVED' FOR UPDATE`,[recordId]);
    if(!archived){await connection.rollback();return fail(res,'Archived record not found.',404);}
    if(module==='announcements'){
      await connection.execute("DELETE nr FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id WHERE n.resource_type='announcement' AND n.resource_id=?",[recordId]);
      await connection.execute("DELETE FROM notifications WHERE resource_type='announcement' AND resource_id=?",[recordId]);
      await connection.execute('DELETE FROM announcement_images WHERE announcement_id=?',[recordId]);
      if(record?.storageKey)filePath=path.join(imageDirectory,`announcement-${record.storageKey}.webp`);
    }else if(record?.storageKey)filePath=path.join(imageDirectory,`${record.storageKey}.webp`);
    await connection.execute(`DELETE FROM ${table} WHERE id=?`,[recordId]);
    await connection.execute('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?)',[req.user.sub,'ARCHIVE_PERMANENTLY_DELETED',table,recordId,JSON.stringify({reason:reason.trim()})]);
    await connection.commit();
    let fileCleanupPending=false;
    if(filePath)try{await unlink(filePath);}catch(error){if(error.code!=='ENOENT'){fileCleanupPending=true;console.error('Archive file cleanup failed:',error.code||'FILE_ERROR');}}
    return ok(res,{fileCleanupPending},fileCleanupPending?'Record deleted; private file cleanup needs administrator attention.':'Archived record permanently deleted.');
  }catch(error){await connection.rollback();if(error.code==='ER_ROW_IS_REFERENCED_2')return fail(res,'Protected records still refer to this item. Keep it archived.',409);next(error);}finally{connection.release();}
});
export default router;
