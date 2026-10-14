import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { pool } from '../database/pool.js';
import { authenticate } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';
import { env } from '../config/env.js';

const router=Router();router.use(authenticate);
const directory=process.env.UPLOAD_DIR?path.resolve(process.env.UPLOAD_DIR):fileURLToPath(new URL('../private-uploads/',import.meta.url));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1,fields:0,parts:1}}).single('photo');
const uploadLimit=rateLimit({windowMs:60*60*1000,max:20,standardHeaders:'draft-6',legacyHeaders:false,message:{success:false,message:'Too many photo uploads. Please try later.'}});
function receive(req,res,next){
  if(req.headers.origin&&req.headers.origin!==env.clientUrl)return fail(res,'Untrusted upload origin.',403);
  upload(req,res,error=>error?fail(res,error.code==='LIMIT_FILE_SIZE'?'Photo must be 10 MB or smaller.':'Invalid photo upload.',422):next());
}
function filePath(key){return path.join(directory,`profile-${key}.webp`);}
router.get('/',async(req,res,next)=>{try{
  const [[photo]]=await pool.execute('SELECT storage_key FROM profile_photos WHERE user_id=?',[req.user.sub]);
  if(!photo)return fail(res,'No profile photo.',404);
  const data=await readFile(filePath(photo.storage_key));
  res.set({'Content-Type':'image/webp','Cache-Control':'private, no-store','Content-Disposition':'inline; filename="profile.webp"','X-Content-Type-Options':'nosniff'}).send(data);
}catch(error){next(error);}});
router.put('/',uploadLimit,receive,async(req,res,next)=>{
  if(!req.file)return fail(res,'Choose a PNG, JPEG, or WebP photo.',422);
  let image;
  try{
    const processor=sharp(req.file.buffer,{limitInputPixels:12_000_000,failOn:'error'});
    const meta=await processor.metadata();
    if(!['png','jpeg','webp'].includes(meta.format)||!meta.width||!meta.height||meta.width>5000||meta.height>5000||meta.width*meta.height>12_000_000)throw new Error('Invalid image.');
    image=await processor.rotate().resize(512,512,{fit:'cover'}).webp({quality:82}).toBuffer();
  }catch{return fail(res,'Use a real PNG, JPEG, or WebP photo within the size and dimension limits.',422);}
  const key=randomBytes(32).toString('hex');let oldKey;
  try{
    await mkdir(directory,{recursive:true,mode:0o700});await writeFile(filePath(key),image,{flag:'wx',mode:0o600});
    const connection=await pool.getConnection();try{
      await connection.beginTransaction();
      const [[old]]=await connection.execute('SELECT storage_key FROM profile_photos WHERE user_id=? FOR UPDATE',[req.user.sub]);oldKey=old?.storage_key;
      await connection.execute('INSERT INTO profile_photos(user_id,storage_key,width,height) VALUES (?,?,512,512) ON DUPLICATE KEY UPDATE storage_key=VALUES(storage_key),width=512,height=512,version=version+1',[req.user.sub,key]);
      await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'PROFILE_PHOTO_UPDATED','users',?)",[req.user.sub,req.user.sub]);
      await connection.commit();
    }catch(error){await connection.rollback();throw error;}finally{connection.release();}
    if(oldKey)unlink(filePath(oldKey)).catch(error=>console.error('Old profile photo cleanup:',error.code));
    return ok(res,null,'Profile photo saved.');
  }catch(error){unlink(filePath(key)).catch(()=>{});next(error);}
});
router.delete('/',async(req,res,next)=>{
  const connection=await pool.getConnection();let oldKey;
  try{
    await connection.beginTransaction();
    const [[old]]=await connection.execute('SELECT storage_key FROM profile_photos WHERE user_id=? FOR UPDATE',[req.user.sub]);
    if(!old){await connection.rollback();return ok(res,null,'No profile photo to remove.');}
    oldKey=old.storage_key;
    await connection.execute('DELETE FROM profile_photos WHERE user_id=?',[req.user.sub]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'PROFILE_PHOTO_REMOVED','users',?)",[req.user.sub,req.user.sub]);
    await connection.commit();
    unlink(filePath(oldKey)).catch(error=>console.error('Profile photo cleanup:',error.code));
    return ok(res,null,'Profile photo removed.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
export default router;
