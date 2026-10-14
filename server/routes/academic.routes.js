import { Router } from 'express';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';

const router = Router(); router.use(authenticate);
const id = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const conflict = (error, res, next) => error.code === 'ER_DUP_ENTRY' ? fail(res, 'That record already exists.', 409) : next(error);
const enrollmentError=(message,status)=>Object.assign(new Error(message),{status});
async function enrollStudent(connection,studentId,offeringId,actorId){
  const [[student]]=await connection.execute("SELECT st.id,st.user_id FROM students st LEFT JOIN users u ON u.id=st.user_id WHERE st.id=? AND (st.user_id IS NULL OR u.status='ACTIVE')",[studentId]);
  const [[offering]]=await connection.execute("SELECT id FROM subject_offerings WHERE id=? AND status='ACTIVE'",[offeringId]);
  if(!student||!offering)throw enrollmentError('Student or active class assignment not found.',404);
  const [overlap]=await connection.execute(`SELECT a.id FROM schedule_meetings a JOIN subject_offerings proposed ON proposed.id=a.offering_id
    JOIN enrollments e ON e.student_id=? AND e.status='ENROLLED' JOIN subject_offerings existing ON existing.id=e.offering_id AND existing.term_id=proposed.term_id
    JOIN schedule_meetings b ON b.offering_id=existing.id AND b.status='ACTIVE' AND b.weekday=a.weekday AND b.start_time<a.end_time AND b.end_time>a.start_time
    WHERE a.offering_id=? AND a.status='ACTIVE' LIMIT 1`,[studentId,offeringId]);
  if(overlap.length)throw enrollmentError('This student already has a class at that time.',409);
  const [result]=await connection.execute('INSERT INTO enrollments(student_id,offering_id) VALUES (?,?)',[studentId,offeringId]);
  if(student.user_id){
    const [notice]=await connection.execute("INSERT INTO notifications (type,title,body,resource_type,resource_id) VALUES ('ENROLLMENT','Enrollment updated','You have been enrolled in a class.','subject',?)",[offeringId]);
    await connection.execute('INSERT INTO notification_recipients (notification_id,user_id) VALUES (?,?)',[notice.insertId,student.user_id]);
  }
  await connection.execute("INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,'STUDENT_ENROLLED','enrollments',?)",[actorId,result.insertId]);
  return result.insertId;
}

const termDate=value=>{if(value==null||value==='')return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return undefined;const parsed=new Date(`${value}T00:00:00Z`);return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value?value:undefined;};
const validYear=value=>typeof value==='string'&&/^(\d{4})–(\d{4})$/.test(value)&&Number(value.slice(5))===Number(value.slice(0,4))+1;
router.get('/terms', async (req, res, next) => { try { const [rows] = await pool.query("SELECT id,academic_year academicYear,semester,is_current isCurrent,DATE_FORMAT(start_date,'%Y-%m-%d') startDate,DATE_FORMAT(end_date,'%Y-%m-%d') endDate FROM academic_terms ORDER BY academic_year DESC,FIELD(semester,'FIRST','SECOND','SUMMER'),id"); return ok(res, rows); } catch(e){next(e);} });
router.post('/terms',authorize('ADMIN'),async(req,res,next)=>{try{
  const {academicYear,semester}=req.body||{},startDate=termDate(req.body?.startDate),endDate=termDate(req.body?.endDate);
  if(!validYear(academicYear)||!['FIRST','SECOND','SUMMER'].includes(semester)||startDate===undefined||endDate===undefined||Boolean(startDate)!==Boolean(endDate)||(startDate&&startDate>endDate))return fail(res,'Enter a consecutive academic year, semester, and optional valid date range.',422);
  const [result]=await pool.execute('INSERT INTO academic_terms(academic_year,semester,is_current,start_date,end_date) VALUES (?,?,FALSE,?,?)',[academicYear,semester,startDate,endDate]);
  await pool.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'ACADEMIC_TERM_CREATED','academic_terms',?)",[req.user.sub,result.insertId]);
  return ok(res,{id:result.insertId},'Academic term created.',201);
}catch(error){conflict(error,res,next);}});
router.patch('/terms/:termId',authorize('ADMIN'),async(req,res,next)=>{try{
  const termId=id(req.params.termId),startDate=termDate(req.body?.startDate),endDate=termDate(req.body?.endDate);
  if(!termId||startDate===undefined||endDate===undefined||Boolean(startDate)!==Boolean(endDate)||(startDate&&startDate>endDate))return fail(res,'Enter a valid date range or leave both dates empty.',422);
  const [result]=await pool.execute('UPDATE academic_terms SET start_date=?,end_date=? WHERE id=?',[startDate,endDate,termId]);
  if(!result.affectedRows)return fail(res,'Academic term not found.',404);
  await pool.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'ACADEMIC_TERM_DATES_UPDATED','academic_terms',?)",[req.user.sub,termId]);
  return ok(res,null,'Academic term dates updated.');
}catch(error){next(error);}});
router.get('/sections', authorize('ADMIN'), async (req,res,next) => { try { const [rows] = await pool.query('SELECT s.id,s.name,s.year_level yearLevel,p.name program FROM sections s JOIN programs p ON p.id=s.program_id ORDER BY p.name,s.year_level,s.name'); return ok(res,rows); }catch(e){next(e);} });
router.get('/faculty', authorize('ADMIN'), async (req,res,next) => { try { const [rows] = await pool.query("SELECT f.id,CONCAT(u.first_name,' ',u.last_name) name FROM faculty f JOIN users u ON u.id=f.user_id WHERE u.status='ACTIVE' ORDER BY name"); return ok(res,rows); }catch(e){next(e);} });

router.get('/subjects', async (req,res,next) => {
  try {
    const page = Math.max(1, Math.min(100000, Number(req.query.page)||1));
    const search = `%${String(req.query.search||'').slice(0,80)}%`;
    const where = "WHERE status='ACTIVE' AND (code LIKE ? OR name LIKE ?)";
    const [[count]] = await pool.execute(`SELECT COUNT(*) total FROM subjects ${where}`, [search,search]);
    const [rows] = await pool.query(`SELECT id,code,name,units,status FROM subjects ${where} ORDER BY code LIMIT 20 OFFSET ?`, [search,search,(page-1)*20]);
    return ok(res,{rows,total:count.total,page});
  } catch(e){next(e);}
});
router.post('/subjects', authorize('ADMIN'), async (req,res,next) => {
  try {
    const {code,name,units} = req.body||{};
    if (typeof code!=='string'||!/^[A-Za-z0-9-]{2,30}$/.test(code)||typeof name!=='string'||!name.trim()||name.length>180||!Number.isFinite(Number(units))||Number(units)<=0||Number(units)>12) return fail(res,'Enter a valid code, title, and units (0–12).',422);
    const [result]=await pool.execute('INSERT INTO subjects (code,name,units) VALUES (?,?,?)',[code.toUpperCase(),name.trim(),Number(units)]);
    await pool.execute("INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,'SUBJECT_CREATED','subjects',?)",[req.user.sub,result.insertId]);
    return ok(res,{id:result.insertId},'Subject created.',201);
  }catch(e){conflict(e,res,next);}
});
router.patch('/subjects/:subjectId',authorize('ADMIN'),async(req,res,next)=>{
  const connection=await pool.getConnection();try {await connection.beginTransaction();
    const subjectId=id(req.params.subjectId),{name,units,status}=req.body||{};
    if(!subjectId||typeof name!=='string'||!name.trim()||name.length>180||!Number.isFinite(Number(units))||Number(units)<=0||Number(units)>12||!['ACTIVE','ARCHIVED'].includes(status)){await connection.rollback();return fail(res,'Invalid subject details.',422);}
    const [[previous]]=await connection.execute('SELECT status FROM subjects WHERE id=? FOR UPDATE',[subjectId]);
    if(!previous){await connection.rollback();return fail(res,'Subject not found.',404);}
    await connection.execute('UPDATE subjects SET name=?,units=?,status=? WHERE id=?',[name.trim(),Number(units),status,subjectId]);
    await connection.execute('INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,?,?,?)',[req.user.sub,status==='ARCHIVED'&&previous.status!=='ARCHIVED'?'SUBJECT_ARCHIVED':'SUBJECT_UPDATED','subjects',subjectId]);
    await connection.commit();
    return ok(res,null,'Subject updated.');
  }catch(e){await connection.rollback();next(e);}finally{connection.release();}
});

router.get('/offerings',async(req,res,next)=>{
  try {
    const termId=id(req.query.termId), params=[];
    let scope='';
    const statusScope=req.user.role==='STUDENT'?'1=1':"o.status='ACTIVE'";
    if(req.user.role==='FACULTY'){scope=' AND f.user_id=?';params.push(req.user.sub);}
    if(req.user.role==='STUDENT'){scope=" AND EXISTS (SELECT 1 FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.offering_id=o.id AND e.status='ENROLLED' AND st.user_id=?)";params.push(req.user.sub);}
    const [rows]=await pool.query(`SELECT o.id,o.subject_id subjectId,o.term_id termId,o.section_id sectionId,o.faculty_id facultyId,
      sub.code,sub.name,sub.units,t.academic_year academicYear,t.semester,t.is_current isCurrent,
      sec.name section,CONCAT(u.first_name,' ',u.last_name) faculty,o.status
      FROM subject_offerings o JOIN subjects sub ON sub.id=o.subject_id JOIN academic_terms t ON t.id=o.term_id
      JOIN sections sec ON sec.id=o.section_id LEFT JOIN faculty f ON f.id=o.faculty_id LEFT JOIN users u ON u.id=f.user_id
      WHERE ${statusScope} AND (? IS NULL OR o.term_id=?) ${scope} ORDER BY t.start_date DESC,sub.code LIMIT 200`,[termId,termId,...params]);
    return ok(res,rows);
  }catch(e){next(e);}
});
router.get('/offerings/search',async(req,res,next)=>{try{
  const admin=req.user.role==='ADMIN',termId=id(req.query.termId),sectionId=admin?id(req.query.sectionId):null,facultyId=admin?id(req.query.facultyId):null;
  const status=admin&&['ACTIVE','ARCHIVED'].includes(req.query.status)?req.query.status:'ACTIVE';
  const search=String(req.query.search||'').trim().slice(0,80),academicYear=String(req.query.academicYear||'').trim().slice(0,20);
  const page=Math.max(1,Math.min(100000,Number(req.query.page)||1)),sort=['code','name','newest'].includes(req.query.sort)?req.query.sort:'code';
  const filters=['o.status=?'];const params=[status];
  if(termId){filters.push('o.term_id=?');params.push(termId);}if(sectionId){filters.push('o.section_id=?');params.push(sectionId);}if(facultyId){filters.push('o.faculty_id=?');params.push(facultyId);}
  if(academicYear){filters.push('t.academic_year=?');params.push(academicYear);}
  if(search){filters.push("(sub.code LIKE ? OR sub.name LIKE ? OR sec.name LIKE ? OR CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) LIKE ?)");for(let index=0;index<4;index++)params.push(`%${search}%`);}
  if(req.user.role==='FACULTY'){filters.push('f.user_id=?');params.push(req.user.sub);}
  if(req.user.role==='STUDENT'){filters.push("EXISTS(SELECT 1 FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.offering_id=o.id AND e.status='ENROLLED' AND st.user_id=?)");params.push(req.user.sub);}
  const joins='JOIN subjects sub ON sub.id=o.subject_id JOIN academic_terms t ON t.id=o.term_id JOIN sections sec ON sec.id=o.section_id LEFT JOIN faculty f ON f.id=o.faculty_id LEFT JOIN users u ON u.id=f.user_id';
  const where=filters.join(' AND '),order=sort==='name'?'sub.name,o.id':sort==='newest'?'o.created_at DESC,o.id DESC':'sub.code,o.id';
  const [[count]]=await pool.execute(`SELECT COUNT(*) total FROM subject_offerings o ${joins} WHERE ${where}`,params);
  const [rows]=await pool.query(`SELECT o.id,o.subject_id subjectId,o.term_id termId,o.section_id sectionId,o.faculty_id facultyId,sub.code,sub.name,sub.units,t.academic_year academicYear,t.semester,sec.name section,CONCAT(u.first_name,' ',u.last_name) faculty,o.status,(SELECT COUNT(*) FROM enrollments e WHERE e.offering_id=o.id AND e.status='ENROLLED') enrollmentCount FROM subject_offerings o ${joins} WHERE ${where} ORDER BY ${order} LIMIT 20 OFFSET ?`,[...params,(page-1)*20]);
  return ok(res,{rows,total:count.total,page});
}catch(error){next(error);}});
router.post('/offerings',authorize('ADMIN'),async(req,res,next)=>{
  try{
    const {subjectId,termId,sectionId,facultyId}=req.body||{};
    if(!id(subjectId)||!id(termId)||!id(sectionId)||(facultyId!=null&&!id(facultyId)))return fail(res,'Select a subject, term, section, and valid faculty.',422);
    const [result]=await pool.execute('INSERT INTO subject_offerings (subject_id,term_id,section_id,faculty_id) VALUES (?,?,?,?)',[id(subjectId),id(termId),id(sectionId),facultyId==null?null:id(facultyId)]);
    await pool.execute("INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,'OFFERING_CREATED','subject_offerings',?)",[req.user.sub,result.insertId]);
    return ok(res,{id:result.insertId},'Class assignment created.',201);
  }catch(e){if(e.code==='ER_NO_REFERENCED_ROW_2')return fail(res,'Referenced academic record not found.',422);conflict(e,res,next);}
});
router.patch('/offerings/:offeringId',authorize('ADMIN'),async(req,res,next)=>{
  const offeringId=id(req.params.offeringId),facultyId=req.body?.facultyId,sectionId=req.body?.sectionId,status=req.body?.status;
  if(!offeringId||(facultyId!==undefined&&facultyId!==null&&!id(facultyId))||(sectionId!==undefined&&!id(sectionId))||(status!==undefined&&!['ACTIVE','ARCHIVED'].includes(status)))return fail(res,'Invalid offering details.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[old]]=await connection.execute('SELECT * FROM subject_offerings WHERE id=? FOR UPDATE',[offeringId]);
    if(!old){await connection.rollback();return fail(res,'Offering not found.',404);}
    if((facultyId!==undefined&&facultyId!==old.faculty_id)||(sectionId!==undefined&&sectionId!==old.section_id)){
      const [[meeting]]=await connection.execute("SELECT id FROM schedule_meetings WHERE offering_id=? AND status='ACTIVE' LIMIT 1",[offeringId]);
      if(meeting){await connection.rollback();return fail(res,'Archive or reschedule this class assignment’s meetings before changing its teacher or section.',409);}
    }
    await connection.execute('UPDATE subject_offerings SET faculty_id=?,section_id=?,status=? WHERE id=?',[facultyId===undefined?old.faculty_id:facultyId,sectionId===undefined?old.section_id:sectionId,status===undefined?old.status:status,offeringId]);
    await connection.execute('INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,?,?,?)',[req.user.sub,status==='ARCHIVED'&&old.status!=='ARCHIVED'?'OFFERING_ARCHIVED':'OFFERING_UPDATED','subject_offerings',offeringId]);
    await connection.commit();return ok(res,null,'Class assignment updated.');
  }catch(e){await connection.rollback();if(e.code==='ER_DUP_ENTRY')return fail(res,'Class assignment already exists.',409);next(e);}finally{connection.release();}
});
router.get('/offerings/:offeringId/roster',authorize('ADMIN','FACULTY'),async(req,res,next)=>{
  try{
    const offeringId=id(req.params.offeringId);if(!offeringId)return fail(res,'Invalid class assignment.',422);
    if(req.user.role==='FACULTY'){
      const [[ownership]]=await pool.execute('SELECT o.id FROM subject_offerings o JOIN faculty f ON f.id=o.faculty_id WHERE o.id=? AND f.user_id=?',[offeringId,req.user.sub]);
      if(!ownership)return fail(res,'Class assignment not found.',404);
    }
    const [rows]=await pool.execute(`SELECT e.id,e.status,st.student_no studentId,COALESCE(u.first_name,st.manual_first_name) firstName,COALESCE(u.last_name,st.manual_last_name) lastName
      FROM enrollments e JOIN students st ON st.id=e.student_id LEFT JOIN users u ON u.id=st.user_id
      WHERE e.offering_id=? ORDER BY lastName,firstName LIMIT 300`,[offeringId]);return ok(res,rows);
  }catch(e){next(e);}
});
router.post('/enrollments',authorize('ADMIN'),async(req,res,next)=>{
  const connection=await pool.getConnection();try{
    const studentId=id(req.body?.studentId),offeringId=id(req.body?.offeringId);
    if(!studentId||!offeringId)return fail(res,'Select a student and class.',422);
    const [[locked]]=await connection.execute("SELECT GET_LOCK('sbaa:schedule:write',10) acquired");
    if(locked.acquired!==1)return fail(res,'Enrollment is busy. Please try again.',409);
    await connection.beginTransaction();
    const enrollmentId=await enrollStudent(connection,studentId,offeringId,req.user.sub);
    await connection.commit();
    return ok(res,{id:enrollmentId},'Student enrolled.',201);
  }catch(e){try{await connection.rollback();}catch{}if(e.status)return fail(res,e.message,e.status);conflict(e,res,next);}finally{try{await connection.query("SELECT RELEASE_LOCK('sbaa:schedule:write')");}catch{}connection.release();}
});
router.post('/students/manual-enroll',authorize('ADMIN'),async(req,res,next)=>{
  const body=req.body||{},firstName=body.firstName,lastName=body.lastName,middleName=body.middleName||'',studentNo=body.studentNo,email=body.email||'',contactNumber=body.contactNumber||'',birthDate=body.birthDate||'',sectionId=id(body.sectionId),offeringId=id(body.offeringId);
  if(typeof firstName!=='string'||!firstName.trim()||firstName.length>100||typeof lastName!=='string'||!lastName.trim()||lastName.length>100||typeof middleName!=='string'||middleName.length>100||typeof studentNo!=='string'||!/^[A-Za-z0-9-]{2,40}$/.test(studentNo)||typeof email!=='string'||email.length>190||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))||typeof contactNumber!=='string'||contactNumber.length>30||typeof birthDate!=='string'||(birthDate&&!/^\d{4}-\d{2}-\d{2}$/.test(birthDate))||!sectionId||!offeringId)return fail(res,'Enter a valid name, student ID, section, class, and optional contact details.',422);
  if(birthDate){const parsed=new Date(`${birthDate}T00:00:00Z`);if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==birthDate||parsed>new Date())return fail(res,'Enter a valid past date of birth.',422);}
  const connection=await pool.getConnection();try{
    const [[locked]]=await connection.execute("SELECT GET_LOCK('sbaa:schedule:write',10) acquired");if(locked.acquired!==1)return fail(res,'Enrollment is busy. Please try again.',409);
    await connection.beginTransaction();
    const [[section]]=await connection.execute('SELECT id,program_id FROM sections WHERE id=?',[sectionId]);
    const [[offering]]=await connection.execute("SELECT id FROM subject_offerings WHERE id=? AND section_id=? AND status='ACTIVE'",[offeringId,sectionId]);
    if(!section||!offering){await connection.rollback();return fail(res,'Select a class assignment in the chosen program, year, and section.',422);}
    const [[existing]]=await connection.execute('SELECT id FROM users WHERE email=? OR external_id=? LIMIT 1',[email||null,studentNo]);
    if(existing){await connection.rollback();return fail(res,'An account already uses this email or ID. Select its student record instead; records are never linked by name or typed ID.',409);}
    const [student]=await connection.execute('INSERT INTO students(user_id,student_no,program_id,section_id,manual_first_name,manual_middle_name,manual_last_name,manual_email,contact_number,birth_date) VALUES (NULL,?,?,?,?,?,?,?,?,?)',[studentNo,section.program_id,sectionId,firstName.trim(),middleName.trim()||null,lastName.trim(),email.trim().toLowerCase()||null,contactNumber.trim()||null,birthDate||null]);
    const enrollmentId=await enrollStudent(connection,student.insertId,offeringId,req.user.sub);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'MANUAL_STUDENT_CREATED','students',?)",[req.user.sub,student.insertId]);
    await connection.commit();return ok(res,{studentId:student.insertId,enrollmentId},'Student record created and enrolled without a login account.',201);
  }catch(e){try{await connection.rollback();}catch{}if(e.status)return fail(res,e.message,e.status);conflict(e,res,next);}finally{try{await connection.query("SELECT RELEASE_LOCK('sbaa:schedule:write')");}catch{}connection.release();}
});
router.patch('/enrollments/:enrollmentId',authorize('ADMIN'),async(req,res,next)=>{
  const enrollmentId=id(req.params.enrollmentId),status=req.body?.status;
  if(!enrollmentId||!['ENROLLED','DROPPED'].includes(status))return fail(res,'Invalid enrollment status.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[old]]=await connection.execute('SELECT e.id,st.user_id,e.offering_id FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.id=? FOR UPDATE',[enrollmentId]);
    if(!old){await connection.rollback();return fail(res,'Enrollment not found.',404);}
    await connection.execute('UPDATE enrollments SET status=? WHERE id=?',[status,enrollmentId]);
    if(old.user_id){const [notice]=await connection.execute("INSERT INTO notifications (type,title,body,resource_type,resource_id) VALUES ('ENROLLMENT','Enrollment updated',?,'subject',?)",[status==='ENROLLED'?'You are enrolled in this class.':'Your enrollment in this class was removed.',old.offering_id]);
    await connection.execute('INSERT INTO notification_recipients (notification_id,user_id) VALUES (?,?)',[notice.insertId,old.user_id]);}
    await connection.execute("INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,'ENROLLMENT_UPDATED','enrollments',?)",[req.user.sub,enrollmentId]);
    await connection.commit();return ok(res,null,'Enrollment updated.');
  }catch(e){await connection.rollback();next(e);}finally{connection.release();}
});
router.get('/students',authorize('ADMIN'),async(req,res,next)=>{try{const [rows]=await pool.query("SELECT s.id,s.student_no studentNo,CONCAT(COALESCE(u.first_name,s.manual_first_name),' ',COALESCE(u.last_name,s.manual_last_name)) name,s.user_id userId,s.section_id sectionId,s.manual_email email,s.contact_number contactNumber,s.birth_date birthDate FROM students s LEFT JOIN users u ON u.id=s.user_id WHERE s.user_id IS NULL OR u.status='ACTIVE' ORDER BY name LIMIT 300");return ok(res,rows);}catch(e){next(e);}});
export default router;
