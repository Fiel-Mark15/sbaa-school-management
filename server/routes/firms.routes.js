import { Router } from 'express';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';
import { isIP } from 'node:net';

const router=Router();router.use(authenticate);
const id=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
function valid(body){
  const name=body?.name,category=body?.category,description=body?.description,address=body?.publicAddress,contact=body?.publicContact,website=body?.website,status=body?.status;
  if(typeof name!=='string'||!name.trim()||name.length>180||typeof category!=='string'||!category.trim()||category.length>100||typeof description!=='string'||!description.trim()||description.length>5000)return null;
  if(address!=null&&(typeof address!=='string'||address.length>300)||contact!=null&&(typeof contact!=='string'||contact.length>190)||!['DRAFT','PUBLISHED','ARCHIVED'].includes(status))return null;
  if(website){try{const url=new URL(website);const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();if(!['https:','http:'].includes(url.protocol)||url.username||url.password||!host||isIP(host)||!host.includes('.')||/\.(local|internal|localhost|test)\.?$/.test(host)||host.endsWith('.'))return null;}catch{return null;}}
  return {name:name.trim(),category:category.trim(),description:description.trim(),address:address?.trim()||null,contact:contact?.trim()||null,website:website?.trim()||null,status};
}
router.get('/',async(req,res,next)=>{try{
  const admin=req.user.role==='ADMIN',page=Math.max(1,Math.min(100000,Number(req.query.page)||1));
  const search=String(req.query.search||'').slice(0,100),category=String(req.query.category||'').slice(0,100);
  const status=admin&&['DRAFT','PUBLISHED','ARCHIVED'].includes(req.query.status)?req.query.status:admin?null:'PUBLISHED';
  const where='WHERE (? IS NULL OR status=?) AND (?=\'\' OR name LIKE ? OR category LIKE ?) AND (?=\'\' OR category=?)';
  const params=[status,status,search,`%${search}%`,`%${search}%`,category,category];
  const [[count]]=await pool.execute(`SELECT COUNT(*) total FROM firms ${where}`,params);
  const [rows]=await pool.query(`SELECT id,name,category,description,public_address publicAddress,public_contact publicContact,website,status,created_at createdAt,updated_at updatedAt FROM firms ${where} ORDER BY name LIMIT 20 OFFSET ?`,[...params,(page-1)*20]);
  return ok(res,{rows,total:count.total,page});
}catch(error){next(error);}});
router.post('/',authorize('ADMIN'),async(req,res,next)=>{
  const values=valid(req.body);if(!values)return fail(res,'Enter a valid firm name, category, description, public contact details, website, and status.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [result]=await connection.execute('INSERT INTO firms(name,category,description,public_address,public_contact,website,status) VALUES (?,?,?,?,?,?,?)',Object.values(values));
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'FIRM_CREATED','firms',?)",[req.user.sub,result.insertId]);
    await connection.commit();return ok(res,{id:result.insertId},'Firm saved.',201);
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
router.patch('/:id',authorize('ADMIN'),async(req,res,next)=>{
  const firmId=id(req.params.id),values=valid(req.body);if(!firmId||!values)return fail(res,'Enter valid firm details.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[previous]]=await connection.execute('SELECT status FROM firms WHERE id=? FOR UPDATE',[firmId]);
    if(!previous){await connection.rollback();return fail(res,'Firm not found.',404);}
    const [result]=await connection.execute('UPDATE firms SET name=?,category=?,description=?,public_address=?,public_contact=?,website=?,status=? WHERE id=?',[...Object.values(values),firmId]);
    if(!result.affectedRows){await connection.rollback();return fail(res,'Firm not found.',404);}
    await connection.execute('INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,?,?,?)',[req.user.sub,values.status==='ARCHIVED'&&previous.status!=='ARCHIVED'?'FIRM_ARCHIVED':'FIRM_UPDATED','firms',firmId]);
    await connection.commit();return ok(res,null,'Firm updated.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
router.delete('/:id',authorize('ADMIN'),async(req,res,next)=>{
  const firmId=id(req.params.id),reason=req.body?.reason;
  if(!firmId||typeof reason!=='string'||!reason.trim()||reason.length>500)return fail(res,'Enter a valid firm and deletion reason.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[firm]]=await connection.execute('SELECT id,name,status FROM firms WHERE id=? FOR UPDATE',[firmId]);
    if(!firm){await connection.rollback();return fail(res,'Firm not found.',404);}
    if(firm.status!=='ARCHIVED'){await connection.rollback();return fail(res,'Archive this firm before permanent deletion.',409);}
    // Restrict delete at the database level as well; any current or future FK keeps its protected record.
    await connection.execute('DELETE FROM firms WHERE id=?',[firmId]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,'FIRM_DELETED','firms',?,?)",[req.user.sub,firmId,JSON.stringify({name:firm.name,status:firm.status,reason:reason.trim()})]);
    await connection.commit();return ok(res,null,'Firm permanently deleted.');
  }catch(error){await connection.rollback();if(error.code==='ER_ROW_IS_REFERENCED_2')return fail(res,'Protected records refer to this firm. Archive it instead.',409);next(error);}finally{connection.release();}
});
export default router;
