import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { getPrivateObject, putPrivateObject, deletePrivateObject } from '../utils/private-storage.js';
import path from 'node:path';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';
import { env } from '../config/env.js';

const router=Router();router.use(authenticate);
const visible="nr.archived_at IS NULL AND (COALESCE(n.resource_type,'')<>'announcement' OR EXISTS(SELECT 1 FROM announcements a WHERE a.id=n.resource_id AND a.status='PUBLISHED'))";
const idOf=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const objectName=key=>`announcement-${key}.webp`;
const imageUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:0,parts:1}}).single('image');
function receiveImage(req,res,next){
  if(req.headers.origin&&req.headers.origin!==env.clientUrl)return fail(res,'Untrusted upload origin.',403);
  imageUpload(req,res,error=>error?fail(res,error.code==='LIMIT_FILE_SIZE'?'Announcement image must be 5 MB or smaller.':'Invalid image upload.',422):next());
}
const roles=['STUDENT','FACULTY','ADMIN'];
function audience(value){return Array.isArray(value)&&value.length>0&&value.every(role=>roles.includes(role))?[...new Set(value)]:null;}
function recipientIds(value){return value==null?null:Array.isArray(value)&&value.length>0&&value.length<=100&&value.every(id=>Number.isSafeInteger(id)&&id>0)?[...new Set(value)]:false;}
async function distribute(connection,id,title,content,targetRoles,targetUsers=null){
  const [notice]=await connection.execute("INSERT INTO notifications (type,title,body,resource_type,resource_id) VALUES ('ANNOUNCEMENT',?,?,'announcement',?)",[title,content,id]);
  const placeholders=targetRoles.map(()=>'?').join(',');
  const userFilter=targetUsers?.length?` AND id IN (${targetUsers.map(()=>'?').join(',')})`:'';
  await connection.query(`INSERT IGNORE INTO notification_recipients (notification_id,user_id) SELECT ?,id FROM users WHERE status='ACTIVE' AND role IN (${placeholders})${userFilter}`,[notice.insertId,...targetRoles,...(targetUsers||[])]);
}
router.get('/',async(req,res,next)=>{try{
  const page=Math.max(1,Math.min(100000,Number(req.query.page)||1)),unread=req.query.unread==='true';
  const where=`nr.user_id=? AND ${visible}${unread?' AND nr.read_at IS NULL':''}`;
  const [[count]]=await pool.execute(`SELECT COUNT(*) total FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id WHERE ${where}`,[req.user.sub]);
  const [rows]=await pool.query(`SELECT n.id,n.type,n.title,n.body,n.resource_type resourceType,n.resource_id resourceId,n.created_at createdAt,nr.read_at readAt,IF(ai.announcement_id IS NULL,0,1) hasImage FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id LEFT JOIN announcement_images ai ON n.resource_type='announcement' AND ai.announcement_id=n.resource_id WHERE ${where} ORDER BY n.created_at DESC,n.id DESC LIMIT 20 OFFSET ?`,[req.user.sub,(page-1)*20]);
  return ok(res,{rows,total:count.total,page});
}catch(e){next(e);}});
router.get('/unread-count',async(req,res,next)=>{try{const [[row]]=await pool.execute(`SELECT COUNT(*) count FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id WHERE nr.user_id=? AND nr.read_at IS NULL AND ${visible}`,[req.user.sub]);return ok(res,row);}catch(e){next(e);}});
router.patch('/read-all',async(req,res,next)=>{try{await pool.execute(`UPDATE notification_recipients nr JOIN notifications n ON n.id=nr.notification_id SET nr.read_at=UTC_TIMESTAMP() WHERE nr.user_id=? AND nr.read_at IS NULL AND ${visible}`,[req.user.sub]);return ok(res,null,'All notifications marked as read.');}catch(e){next(e);}});
router.patch('/archive-all',async(req,res,next)=>{try{await pool.execute('UPDATE notification_recipients SET archived_at=UTC_TIMESTAMP() WHERE user_id=? AND archived_at IS NULL',[req.user.sub]);return ok(res,null,'Your inbox was cleared. Shared announcements were not deleted.');}catch(e){next(e);}});
router.patch('/:id/read',async(req,res,next)=>{try{const id=idOf(req.params.id);if(!id)return fail(res,'Invalid notification.',422);const [result]=await pool.execute('UPDATE notification_recipients SET read_at=COALESCE(read_at,UTC_TIMESTAMP()) WHERE notification_id=? AND user_id=? AND archived_at IS NULL',[id,req.user.sub]);if(!result.affectedRows)return fail(res,'Notification not found.',404);return ok(res,null,'Notification marked as read.');}catch(e){next(e);}});
router.patch('/:id/archive',async(req,res,next)=>{try{const id=idOf(req.params.id);if(!id)return fail(res,'Invalid notification.',422);const [result]=await pool.execute('UPDATE notification_recipients SET archived_at=UTC_TIMESTAMP() WHERE notification_id=? AND user_id=? AND archived_at IS NULL',[id,req.user.sub]);if(!result.affectedRows)return fail(res,'Notification not found.',404);return ok(res,null,'Removed from your inbox.');}catch(e){next(e);}});

router.get('/announcements',async(req,res,next)=>{try{const [rows]=await pool.query(`SELECT a.id,a.title,a.content,a.priority,a.published_at publishedAt,CONCAT(u.first_name,' ',u.last_name) author,IF(ai.announcement_id IS NULL,0,1) hasImage FROM announcements a JOIN users u ON u.id=a.author_id LEFT JOIN announcement_images ai ON ai.announcement_id=a.id WHERE a.status='PUBLISHED' AND (?='ADMIN' OR EXISTS (SELECT 1 FROM notifications n JOIN notification_recipients nr ON nr.notification_id=n.id WHERE n.resource_type='announcement' AND n.resource_id=a.id AND nr.user_id=?)) ORDER BY a.published_at DESC LIMIT 50`,[req.user.role,req.user.sub]);return ok(res,rows);}catch(e){next(e);}});
router.get('/announcements/manage',authorize('ADMIN'),async(req,res,next)=>{try{const includeArchived=req.query.includeArchived==='true';const [rows]=await pool.query(`SELECT a.id,a.title,a.content,a.priority,a.status,a.published_at publishedAt,a.audience_roles audienceRoles,a.recipient_user_ids recipientUserIds,IF(ai.announcement_id IS NULL,0,1) hasImage FROM announcements a LEFT JOIN announcement_images ai ON ai.announcement_id=a.id ${includeArchived?'':"WHERE a.status<>'ARCHIVED'"} ORDER BY a.id DESC LIMIT 100`);return ok(res,rows);}catch(e){next(e);}});
router.post('/announcements',authorize('ADMIN'),async(req,res,next)=>{
  const {title,content,priority='NORMAL',publish=false,requestId}=req.body||{};
  const targetRoles=audience(req.body?.audienceRoles||roles),targetUsers=recipientIds(req.body?.recipientUserIds);
  if(typeof title!=='string'||!title.trim()||title.length>200||typeof content!=='string'||!content.trim()||content.length>10000||!['LOW','NORMAL','HIGH'].includes(priority)||typeof publish!=='boolean'||!targetRoles||targetUsers===false||(requestId!=null&&!/^[0-9a-f-]{36}$/i.test(requestId)))return fail(res,'Enter a valid title, content, priority, audience, and publish setting.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    if(requestId){const [[existing]]=await connection.execute('SELECT id FROM announcements WHERE client_request_id=?',[requestId]);if(existing){await connection.rollback();return ok(res,{id:existing.id},'Announcement already saved.');}}
    const [result]=await connection.execute('INSERT INTO announcements (author_id,title,content,priority,status,published_at,audience_roles,client_request_id,recipient_user_ids) VALUES (?,?,?,?,?,?,?,?,?)',[req.user.sub,title.trim(),content.trim(),priority,publish?'PUBLISHED':'DRAFT',publish?new Date():null,JSON.stringify(targetRoles),requestId||null,targetUsers?JSON.stringify(targetUsers):null]);
    if(publish)await distribute(connection,result.insertId,title.trim(),content.trim(),targetRoles,targetUsers);
    await connection.execute("INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,'ANNOUNCEMENT_CREATED','announcements',?)",[req.user.sub,result.insertId]);await connection.commit();return ok(res,{id:result.insertId},'Announcement saved.',201);
  }catch(e){await connection.rollback();if(e.code==='ER_DUP_ENTRY'&&requestId){const [[existing]]=await pool.execute('SELECT id FROM announcements WHERE client_request_id=?',[requestId]);if(existing)return ok(res,{id:existing.id},'Announcement already saved.');}next(e);}finally{connection.release();}
});
router.patch('/announcements/:id',authorize('ADMIN'),async(req,res,next)=>{
  const id=idOf(req.params.id),{title,content,priority}=req.body||{},targetRoles=audience(req.body?.audienceRoles||roles),targetUsers=recipientIds(req.body?.recipientUserIds);
  if(!id||typeof title!=='string'||!title.trim()||title.length>200||typeof content!=='string'||!content.trim()||content.length>10000||!['LOW','NORMAL','HIGH'].includes(priority)||!targetRoles||targetUsers===false)return fail(res,'Enter valid announcement details and audience.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();const [[row]]=await connection.execute('SELECT status FROM announcements WHERE id=? FOR UPDATE',[id]);if(!row){await connection.rollback();return fail(res,'Announcement not found.',404);}if(row.status!=='DRAFT'){await connection.rollback();return fail(res,'Only drafts can be edited.',409);}await connection.execute('UPDATE announcements SET title=?,content=?,priority=?,audience_roles=?,recipient_user_ids=? WHERE id=?',[title.trim(),content.trim(),priority,JSON.stringify(targetRoles),targetUsers?JSON.stringify(targetUsers):null,id]);await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'ANNOUNCEMENT_EDITED','announcements',?)",[req.user.sub,id]);await connection.commit();return ok(res,null,'Draft updated.');}catch(e){await connection.rollback();next(e);}finally{connection.release();}
});
router.patch('/announcements/:id/status',authorize('ADMIN'),async(req,res,next)=>{
  const id=idOf(req.params.id),status=req.body?.status;if(!id||!['PUBLISHED','ARCHIVED'].includes(status))return fail(res,'Invalid announcement status.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();const [[row]]=await connection.execute('SELECT title,content,status,audience_roles audienceRoles,recipient_user_ids recipientUserIds FROM announcements WHERE id=? FOR UPDATE',[id]);if(!row){await connection.rollback();return fail(res,'Announcement not found.',404);}if(status==='PUBLISHED'&&row.status!=='DRAFT'){await connection.rollback();return fail(res,'Only drafts can be published.',409);}if(status==='ARCHIVED'&&row.status==='ARCHIVED'){await connection.rollback();return fail(res,'Announcement already archived.',409);}await connection.execute("UPDATE announcements SET status=?,published_at=IF(?='PUBLISHED',UTC_TIMESTAMP(),published_at) WHERE id=?",[status,status,id]);if(status==='PUBLISHED'){const savedRoles=typeof row.audienceRoles==='string'?JSON.parse(row.audienceRoles):row.audienceRoles;const savedRecipients=typeof row.recipientUserIds==='string'?JSON.parse(row.recipientUserIds):row.recipientUserIds;await distribute(connection,id,row.title,row.content,audience(savedRoles)||roles,recipientIds(savedRecipients));}await connection.execute('INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,?,?,?)',[req.user.sub,status==='PUBLISHED'?'ANNOUNCEMENT_PUBLISHED':'ANNOUNCEMENT_ARCHIVED','announcements',id]);await connection.commit();return ok(res,null,status==='PUBLISHED'?'Announcement published.':'Announcement withdrawn.');}catch(e){await connection.rollback();next(e);}finally{connection.release();}
});
router.get('/announcements/:id/image',async(req,res,next)=>{
  const id=idOf(req.params.id);if(!id)return fail(res,'Invalid announcement.',422);
  try{
    const [[image]]=await pool.execute(`SELECT ai.storage_key storageKey,a.status FROM announcement_images ai JOIN announcements a ON a.id=ai.announcement_id WHERE a.id=?`,[id]);
    if(!image)return fail(res,'Announcement image not found.',404);
    if(req.user.role!=='ADMIN'){
      if(image.status!=='PUBLISHED')return fail(res,'Announcement image not found.',404);
      const [[permission]]=await pool.execute("SELECT 1 allowed FROM notifications n JOIN notification_recipients nr ON nr.notification_id=n.id WHERE n.resource_type='announcement' AND n.resource_id=? AND nr.user_id=? LIMIT 1",[id,req.user.sub]);
      if(!permission)return fail(res,'Announcement image not found.',404);
    }
    const data=await getPrivateObject(objectName(image.storageKey));
    return res.set({'Content-Type':'image/webp','Content-Disposition':'inline; filename="announcement.webp"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).send(data);
  }catch(error){if(error.code==='ENOENT')return fail(res,'Announcement image is unavailable.',404);next(error);}
});
router.put('/announcements/:id/image',authorize('ADMIN'),receiveImage,async(req,res,next)=>{
  const id=idOf(req.params.id);if(!id||!req.file)return fail(res,'Choose an announcement image.',422);
  let image,metadata;
  try{
    const processor=sharp(req.file.buffer,{limitInputPixels:12_000_000,failOn:'error'});
    metadata=await processor.metadata();
    if(!['jpeg','png','webp'].includes(metadata.format)||!metadata.width||!metadata.height||metadata.width>5000||metadata.height>5000||metadata.width*metadata.height>12_000_000)throw new Error('Invalid image');
    image=await processor.rotate().resize({width:1600,height:1200,fit:'inside',withoutEnlargement:true}).webp({quality:84}).toBuffer();
  }catch{return fail(res,'Use a real JPEG, PNG, or WebP image within 5 MB and 12 megapixels.',422);}
  const key=randomBytes(32).toString('hex');let oldKey;
  try{
    await putPrivateObject(objectName(key),image,'image/webp');
    const output=await sharp(image).metadata(),connection=await pool.getConnection();
    try{
      await connection.beginTransaction();
      const [[announcement]]=await connection.execute('SELECT status FROM announcements WHERE id=? FOR UPDATE',[id]);
      if(!announcement||announcement.status!=='DRAFT'){await connection.rollback();await deletePrivateObject(objectName(key)).catch(()=>{});return fail(res,'Only a draft announcement can receive or replace an image.',409);}
      const [[old]]=await connection.execute('SELECT storage_key storageKey FROM announcement_images WHERE announcement_id=? FOR UPDATE',[id]);oldKey=old?.storageKey;
      await connection.execute('INSERT INTO announcement_images(announcement_id,storage_key,original_name,width,height) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE storage_key=VALUES(storage_key),original_name=VALUES(original_name),width=VALUES(width),height=VALUES(height)',[id,key,path.basename(req.file.originalname).slice(0,180),output.width,output.height]);
      await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'ANNOUNCEMENT_IMAGE_UPDATED','announcements',?)",[req.user.sub,id]);
      await connection.commit();
      if(oldKey)deletePrivateObject(objectName(oldKey)).catch(error=>console.error('Announcement image cleanup:',error.code));
      return ok(res,{hasImage:true},'Announcement image saved.');
    }catch(error){await connection.rollback();throw error;}finally{connection.release();}
  }catch(error){deletePrivateObject(objectName(key)).catch(()=>{});next(error);}
});
router.delete('/announcements/:id/image',authorize('ADMIN'),async(req,res,next)=>{
  const id=idOf(req.params.id);if(!id)return fail(res,'Invalid announcement.',422);
  const connection=await pool.getConnection();let key;
  try{
    await connection.beginTransaction();
    const [[announcement]]=await connection.execute('SELECT status FROM announcements WHERE id=? FOR UPDATE',[id]);
    if(!announcement||announcement.status!=='DRAFT'){await connection.rollback();return fail(res,'Only a draft image can be removed.',409);}
    const [[image]]=await connection.execute('SELECT storage_key storageKey FROM announcement_images WHERE announcement_id=? FOR UPDATE',[id]);key=image?.storageKey;
    if(key){await connection.execute('DELETE FROM announcement_images WHERE announcement_id=?',[id]);await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'ANNOUNCEMENT_IMAGE_REMOVED','announcements',?)",[req.user.sub,id]);}
    await connection.commit();
    if(key)deletePrivateObject(objectName(key)).catch(error=>console.error('Announcement image cleanup:',error.code));
    return ok(res,null,'Announcement image removed.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
export default router;
