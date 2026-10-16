import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { getPrivateObject, putPrivateObject, deletePrivateObject } from '../utils/private-storage.js';
import rateLimit from 'express-rate-limit';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';
import { env } from '../config/env.js';

const router=Router();router.use(authenticate);
const objectName=key=>`${key}.webp`;
const id=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:10,parts:12}}).single('image');
const uploadLimit=rateLimit({windowMs:60*60*1000,max:Number(process.env.ATTACHMENT_UPLOAD_LIMIT||20),standardHeaders:'draft-6',legacyHeaders:false,message:{success:false,message:'Upload limit reached. Try again later.'}});
function uploadMiddleware(req,res,next){
  if(req.headers.origin&&req.headers.origin!==env.clientUrl)return fail(res,'Untrusted upload origin.',403);
  upload(req,res,error=>{if(error)return fail(res,error.code==='LIMIT_FILE_SIZE'?'Image must be 5 MB or smaller.':'Invalid image upload.',422);next();});
}
async function encodeImage(file){
  if(!file)throw new Error('Choose a PNG, JPEG, or WebP image.');
  try{
    const processor=sharp(file.buffer,{limitInputPixels:16_000_000,failOn:'error'});
    const meta=await processor.metadata();
    if(!['png','jpeg','webp'].includes(meta.format)||!meta.width||!meta.height||meta.width>6000||meta.height>6000||meta.width*meta.height>16_000_000)throw new Error('Invalid image format or dimensions.');
    const {data,info}=await processor.rotate().webp({quality:85}).toBuffer({resolveWithObject:true});
    return {data,width:info.width,height:info.height};
  }catch{throw new Error('Invalid image format or dimensions. Use a real PNG, JPEG, or WebP image.');}
}
export async function accessible(user,row){
  if(user.role==='ADMIN')return true;
  if(row.status!=='PUBLISHED')return false;
  if(row.audience==='ALL')return true;
  if(user.role==='STUDENT'){
    const [[found]]=await pool.execute(`SELECT st.id FROM students st LEFT JOIN enrollments e ON e.student_id=st.id AND e.status='ENROLLED' WHERE st.user_id=? AND ((?='SECTION' AND st.section_id=?) OR (?='OFFERING' AND e.offering_id=?)) LIMIT 1`,[user.sub,row.audience,row.section_id,row.audience,row.offering_id]);
    return Boolean(found);
  }
  const [[found]]=await pool.execute(`SELECT o.id FROM subject_offerings o JOIN faculty f ON f.id=o.faculty_id WHERE f.user_id=? AND o.term_id=? AND ((?='SECTION' AND o.section_id=?) OR (?='OFFERING' AND o.id=?)) LIMIT 1`,[user.sub,row.term_id,row.audience,row.section_id,row.audience,row.offering_id]);
  return Boolean(found);
}
router.get('/',async(req,res,next)=>{try{
  const termId=id(req.query.termId),params=[],admin=req.user.role==='ADMIN';
  let filter=admin?'1=1':"a.status='PUBLISHED'";
  if(termId){filter+=' AND a.term_id=?';params.push(termId);}
  const [rows]=await pool.query(`SELECT a.id,a.title,a.description,a.term_id termId,a.section_id sectionId,a.offering_id offeringId,a.audience,a.status,a.width,a.height,a.version,a.created_at createdAt,a.updated_at updatedAt,CONCAT(u.first_name,' ',u.last_name) author FROM schedule_attachments a JOIN users u ON u.id=a.created_by WHERE ${filter} ORDER BY a.created_at DESC LIMIT 30`,params);
  const visible=[];for(const row of rows){if(admin||await accessible(req.user,{...row,term_id:row.termId,section_id:row.sectionId,offering_id:row.offeringId}))visible.push(row);}
  return ok(res,visible);
}catch(error){next(error);}});
router.get('/:id/image',async(req,res,next)=>{try{
  const attachmentId=id(req.params.id);if(!attachmentId)return fail(res,'Invalid attachment.',422);
  const [[row]]=await pool.execute('SELECT * FROM schedule_attachments WHERE id=?',[attachmentId]);
  if(!row||!await accessible(req.user,row))return fail(res,'Attachment not found.',404);
  const data=await getPrivateObject(objectName(row.storage_key));
  res.set({'Content-Type':'image/webp','Content-Disposition':`${req.query.download==='true'?'attachment':'inline'}; filename="sbaa-schedule-${row.id}.webp"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).send(data);
}catch(error){next(error);}});
router.post('/',authorize('ADMIN'),uploadLimit,uploadMiddleware,async(req,res,next)=>{
  const {title,description,audience}=req.body,termId=id(req.body.termId),sectionId=id(req.body.sectionId),offeringId=id(req.body.offeringId);
  if(typeof title!=='string'||!title.trim()||title.length>180||typeof description!=='string'||!description.trim()||description.length>1000||!termId||!['ALL','SECTION','OFFERING'].includes(audience)||(audience==='SECTION'&&!sectionId)||(audience==='OFFERING'&&!offeringId))return fail(res,'Enter a title, accessibility description, term, and audience.',422);
  let key,connection;
  try{
    const [[term]]=await pool.execute('SELECT id FROM academic_terms WHERE id=?',[termId]);if(!term)return fail(res,'Term not found.',404);
    if(audience==='SECTION'){const [[section]]=await pool.execute('SELECT id FROM sections WHERE id=?',[sectionId]);if(!section)return fail(res,'Section not found.',404);}
    if(audience==='OFFERING'){const [[offering]]=await pool.execute("SELECT id FROM subject_offerings WHERE id=? AND term_id=? AND status='ACTIVE'",[offeringId,termId]);if(!offering)return fail(res,'Offering not found in this term.',404);}
    const image=await encodeImage(req.file);key=randomBytes(32).toString('hex');await putPrivateObject(objectName(key),image.data,'image/webp');
    connection=await pool.getConnection();await connection.beginTransaction();
    const [result]=await connection.execute('INSERT INTO schedule_attachments(title,description,term_id,section_id,offering_id,audience,storage_key,mime_type,width,height,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[title.trim(),description.trim(),termId,audience==='SECTION'?sectionId:null,audience==='OFFERING'?offeringId:null,audience,key,'image/webp',image.width,image.height,req.user.sub]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'SCHEDULE_IMAGE_CREATED','schedule_attachments',?)",[req.user.sub,result.insertId]);
    await connection.commit();
    return ok(res,{id:result.insertId},'Schedule image saved as a draft.',201);
  }catch(error){if(connection)try{await connection.rollback();}catch{}if(key)try{await deletePrivateObject(objectName(key));}catch{}if(error.message?.startsWith('Invalid image')||error.message?.startsWith('Choose a'))return fail(res,error.message,422);next(error);}finally{connection?.release();}
});
router.put('/:id/image',authorize('ADMIN'),uploadLimit,uploadMiddleware,async(req,res,next)=>{
  const attachmentId=id(req.params.id);if(!attachmentId)return fail(res,'Invalid attachment.',422);
  let newKey,oldKey;const connection=await pool.getConnection();try{
    const image=await encodeImage(req.file);newKey=randomBytes(32).toString('hex');await putPrivateObject(objectName(newKey),image.data,'image/webp');
    await connection.beginTransaction();const [[old]]=await connection.execute("SELECT storage_key,status FROM schedule_attachments WHERE id=? FOR UPDATE",[attachmentId]);if(!old||old.status==='ARCHIVED'){await connection.rollback();await deletePrivateObject(objectName(newKey));return fail(res,'Attachment not found.',404);}oldKey=old.storage_key;
    await connection.execute('UPDATE schedule_attachments SET storage_key=?,width=?,height=?,version=version+1,status=\'DRAFT\' WHERE id=?',[newKey,image.width,image.height,attachmentId]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'SCHEDULE_IMAGE_REPLACED','schedule_attachments',?)",[req.user.sub,attachmentId]);await connection.commit();
    try{await deletePrivateObject(objectName(oldKey));}catch(error){console.error('Old attachment cleanup failed:',error.code||'FILE_ERROR');}
    return ok(res,null,'Replacement saved as a draft. Publish when reviewed.');
  }catch(error){try{await connection.rollback();}catch{}if(newKey)try{await deletePrivateObject(objectName(newKey));}catch{}if(error.message?.startsWith('Invalid image')||error.message?.startsWith('Choose a'))return fail(res,error.message,422);next(error);}finally{connection.release();}
});
router.patch('/:id/status',authorize('ADMIN'),async(req,res,next)=>{const connection=await pool.getConnection();try{
  const attachmentId=id(req.params.id),status=req.body?.status;if(!attachmentId||!['PUBLISHED','ARCHIVED'].includes(status))return fail(res,'Invalid attachment status.',422);
  await connection.beginTransaction();
  const [result]=await connection.execute("UPDATE schedule_attachments SET status=? WHERE id=? AND status<>'ARCHIVED'",[status,attachmentId]);if(!result.affectedRows){await connection.rollback();return fail(res,'Attachment not found.',404);}
  await connection.execute('INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,?,?,?)',[req.user.sub,status==='PUBLISHED'?'SCHEDULE_IMAGE_PUBLISHED':'SCHEDULE_IMAGE_ARCHIVED','schedule_attachments',attachmentId]);
  await connection.commit();
  return ok(res,null,status==='PUBLISHED'?'Schedule image published.':'Schedule image archived.');
}catch(error){await connection.rollback();next(error);}finally{connection.release();}});
export default router;
