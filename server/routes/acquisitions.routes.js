import { Router } from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { getPrivateObject, putPrivateObject, deletePrivateObject } from '../utils/private-storage.js';
import path from 'node:path';
import { pool } from '../database/pool.js';
import { authenticate } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';
import { env } from '../config/env.js';

const router=Router();router.use(authenticate);
const objectName=key=>`acquisition-${key}`;
const id=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const statuses=['DRAFT','SUBMITTED','APPROVED','REJECTED','ORDERED','RECEIVED','CANCELLED'];
const categories=['SUPPLIES','EQUIPMENT','BOOKS','LEARNING_RESOURCES'];
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:16,parts:18}}).single('attachment');
function acceptUpload(req,res,next){
  if(req.headers.origin&&req.headers.origin!==env.clientUrl)return fail(res,'Untrusted upload origin.',403);
  upload(req,res,error=>error?fail(res,error.code==='LIMIT_FILE_SIZE'?'Attachment must be 5 MB or smaller.':'Invalid attachment.',422):next());
}
function documentType(file){
  if(!file)return null;
  const data=file.buffer;
  if(data.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
  if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(data[0]===255&&data[1]===216&&data[2]===255)return 'image/jpeg';
  return null;
}
function textField(value,max,required=true){return typeof value==='string'&&value.trim().length<=(max)&&(!required||Boolean(value.trim()))?value.trim():null;}
function valid(body){
  const title=textField(body.title,180),description=textField(body.description,5000),purpose=textField(body.purpose,3000),unit=textField(body.unit,40),category=body.category;
  const quantity=String(body.quantity??''),cost=String(body.estimatedUnitCost??'');
  const date=body.neededBy==null||body.neededBy===''?null:String(body.neededBy);
  if(!title||!description||!purpose||!unit||!categories.includes(category)||!/^\d{1,8}(?:\.\d{1,2})?$/.test(quantity)||Number(quantity)<=0||cost&&!/^\d{1,9}(?:\.\d{1,2})?$/.test(cost))return null;
  if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;
  if(date){const parsed=new Date(`${date}T00:00:00Z`);if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)return null;}
  return {title,category,description,quantity,unit,purpose,neededBy:date,estimatedUnitCost:cost||null};
}
async function storeAttachment(file){
  if(!file)return null;
  const mime=documentType(file);if(!mime)throw Object.assign(new Error('Use a real PDF, PNG, or JPEG attachment.'),{status:422});
  const key=randomBytes(32).toString('hex');await putPrivateObject(objectName(key),file.buffer,mime);
  return {key,name:path.basename(file.originalname).slice(0,180)||'attachment',mime};
}
async function removeAttachment(key){if(key)try{await deletePrivateObject(objectName(key));}catch(error){if(error.code!=='ENOENT')console.error('Acquisition attachment cleanup failed:',error.code||'UNKNOWN');}}
export function canRead(user,row){return user.role==='ADMIN'||Number(row.requester_id)===Number(user.sub);}
const details=`a.id,a.requester_id requesterId,a.reviewer_id reviewerId,a.title,a.category,a.description,a.quantity,a.unit,a.purpose,a.needed_by neededBy,a.estimated_unit_cost estimatedUnitCost,(a.quantity*a.estimated_unit_cost) estimatedTotal,a.status,a.attachment_name attachmentName,a.created_at createdAt,a.updated_at updatedAt,a.archived_at archivedAt,CONCAT(u.first_name,' ',u.last_name) requesterName`;

router.get('/',async(req,res,next)=>{try{
  const admin=req.user.role==='ADMIN',search=String(req.query.search||'').trim().slice(0,100),status=statuses.includes(req.query.status)?req.query.status:null,category=categories.includes(req.query.category)?req.query.category:null,requester=admin?id(req.query.requester):null;
  const date=typeof req.query.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(req.query.date)?req.query.date:null;
  const page=Math.max(1,Math.min(100000,Number(req.query.page)||1));
  const filters=['a.archived_at IS NULL'];const params=[];
  if(!admin){filters.push('a.requester_id=?');params.push(req.user.sub);}
  if(status){filters.push('a.status=?');params.push(status);}if(category){filters.push('a.category=?');params.push(category);}
  if(requester){filters.push('a.requester_id=?');params.push(requester);}if(date){filters.push('DATE(a.created_at)=?');params.push(date);}
  if(search){filters.push('(a.title LIKE ? OR a.description LIKE ?)');params.push(`%${search}%`,`%${search}%`);}
  const where=filters.join(' AND ');
  const [[count]]=await pool.execute(`SELECT COUNT(*) total FROM acquisitions a WHERE ${where}`,params);
  const [rows]=await pool.query(`SELECT ${details} FROM acquisitions a JOIN users u ON u.id=a.requester_id WHERE ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT 20 OFFSET ?`,[...params,(page-1)*20]);
  return ok(res,{rows,total:count.total,page});
}catch(error){next(error);}});
router.get('/:id',async(req,res,next)=>{try{
  const requestId=id(req.params.id);if(!requestId)return fail(res,'Invalid request.',422);
  const [[row]]=await pool.execute(`SELECT ${details} FROM acquisitions a JOIN users u ON u.id=a.requester_id WHERE a.id=? AND a.archived_at IS NULL`,[requestId]);
  if(!row||!canRead(req.user,{requester_id:row.requesterId}))return fail(res,'Request not found.',404);
  const [history]=await pool.execute(`SELECT h.from_status fromStatus,h.to_status toStatus,h.comment,h.created_at createdAt,CONCAT(u.first_name,' ',u.last_name) actorName FROM acquisition_history h JOIN users u ON u.id=h.actor_id WHERE h.acquisition_id=? ORDER BY h.id`,[requestId]);
  return ok(res,{...row,history});
}catch(error){next(error);}});
router.get('/:id/attachment',async(req,res,next)=>{try{
  const requestId=id(req.params.id);if(!requestId)return fail(res,'Invalid request.',422);
  const [[row]]=await pool.execute('SELECT requester_id,attachment_key,attachment_name,attachment_mime FROM acquisitions WHERE id=? AND archived_at IS NULL',[requestId]);
  if(!row||!row.attachment_key||!canRead(req.user,row))return fail(res,'Attachment not found.',404);
  const data=await getPrivateObject(objectName(row.attachment_key));
  res.set({'Content-Type':row.attachment_mime,'Content-Disposition':`attachment; filename="${row.attachment_mime==='application/pdf'?'resource-request.pdf':row.attachment_mime==='image/png'?'resource-request.png':'resource-request.jpg'}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).send(data);
}catch(error){next(error);}});
router.post('/',acceptUpload,async(req,res,next)=>{
  const values=valid(req.body);if(!values||!['DRAFT','SUBMITTED'].includes(req.body.status))return fail(res,'Enter valid request details and status.',422);
  let attachment,connection;
  try{
    attachment=await storeAttachment(req.file);connection=await pool.getConnection();await connection.beginTransaction();
    const [result]=await connection.execute(`INSERT INTO acquisitions(requester_id,title,category,description,quantity,unit,purpose,needed_by,estimated_unit_cost,status,attachment_key,attachment_name,attachment_mime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,[req.user.sub,values.title,values.category,values.description,values.quantity,values.unit,values.purpose,values.neededBy,values.estimatedUnitCost,req.body.status,attachment?.key||null,attachment?.name||null,attachment?.mime||null]);
    await connection.execute('INSERT INTO acquisition_history(acquisition_id,actor_id,to_status) VALUES (?,?,?)',[result.insertId,req.user.sub,req.body.status]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'ACQUISITION_CREATED','acquisitions',?)",[req.user.sub,result.insertId]);
    await connection.commit();return ok(res,{id:result.insertId},'Resource request saved.',201);
  }catch(error){if(connection)await connection.rollback();await removeAttachment(attachment?.key);if(error.status===422)return fail(res,error.message,422);next(error);}finally{connection?.release();}
});
router.patch('/:id',acceptUpload,async(req,res,next)=>{
  const requestId=id(req.params.id),values=valid(req.body);if(!requestId||!values)return fail(res,'Enter valid request details.',422);
  let attachment,oldKey;const connection=await pool.getConnection();try{
    attachment=await storeAttachment(req.file);await connection.beginTransaction();
    const [[row]]=await connection.execute('SELECT requester_id,status,attachment_key FROM acquisitions WHERE id=? AND archived_at IS NULL FOR UPDATE',[requestId]);
    if(!row||!canRead(req.user,row)||row.status!=='DRAFT'){await connection.rollback();await removeAttachment(attachment?.key);return fail(res,'Only your draft requests can be edited.',403);}
    oldKey=attachment?row.attachment_key:null;
    await connection.execute(`UPDATE acquisitions SET title=?,category=?,description=?,quantity=?,unit=?,purpose=?,needed_by=?,estimated_unit_cost=?,attachment_key=?,attachment_name=COALESCE(?,attachment_name),attachment_mime=COALESCE(?,attachment_mime) WHERE id=?`,[values.title,values.category,values.description,values.quantity,values.unit,values.purpose,values.neededBy,values.estimatedUnitCost,attachment?.key||row.attachment_key,attachment?.name||null,attachment?.mime||null,requestId]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'ACQUISITION_UPDATED','acquisitions',?)",[req.user.sub,requestId]);
    await connection.commit();await removeAttachment(oldKey);return ok(res,null,'Draft updated.');
  }catch(error){await connection.rollback();await removeAttachment(attachment?.key);if(error.status===422)return fail(res,error.message,422);next(error);}finally{connection.release();}
});
router.patch('/:id/status',async(req,res,next)=>{
  const requestId=id(req.params.id),to=req.body?.status,comment=textField(req.body?.comment??'',1000,false);
  if(!requestId||!statuses.includes(to)||comment===null)return fail(res,'Invalid status or comment.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[row]]=await connection.execute('SELECT requester_id,status FROM acquisitions WHERE id=? AND archived_at IS NULL FOR UPDATE',[requestId]);
    if(!row){await connection.rollback();return fail(res,'Request not found.',404);}
    const owner=Number(row.requester_id)===Number(req.user.sub),admin=req.user.role==='ADMIN';
    const allowed=(owner&&row.status==='DRAFT'&&to==='SUBMITTED')||(owner&&['DRAFT','SUBMITTED'].includes(row.status)&&to==='CANCELLED')||(admin&&row.status==='SUBMITTED'&&['APPROVED','REJECTED'].includes(to))||(admin&&row.status==='APPROVED'&&to==='ORDERED')||(admin&&row.status==='ORDERED'&&to==='RECEIVED');
    if(!allowed){await connection.rollback();return fail(res,'This status change is not permitted.',403);}
    if(['REJECTED','CANCELLED'].includes(to)&&!comment){await connection.rollback();return fail(res,'A reason is required.',422);}
    await connection.execute('UPDATE acquisitions SET status=?,reviewer_id=IF(?, ?, reviewer_id) WHERE id=?',[to,admin,req.user.sub,requestId]);
    await connection.execute('INSERT INTO acquisition_history(acquisition_id,actor_id,from_status,to_status,comment) VALUES (?,?,?,?,?)',[requestId,req.user.sub,row.status,to,comment||null]);
    await connection.execute('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?)',[req.user.sub,'ACQUISITION_STATUS_CHANGED','acquisitions',requestId,JSON.stringify({from:row.status,to,reason:comment||null})]);
    if(admin&&Number(row.requester_id)!==Number(req.user.sub)){
      const [notice]=await connection.execute("INSERT INTO notifications(type,title,body,resource_type,resource_id) VALUES ('ACQUISITION','Resource request updated',?,'acquisition',?)",[`Your resource request is now ${to.toLowerCase()}.`,requestId]);
      await connection.execute('INSERT INTO notification_recipients(notification_id,user_id) VALUES (?,?)',[notice.insertId,row.requester_id]);
    }
    await connection.commit();return ok(res,null,'Request status updated.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
export default router;
