import { Router } from 'express';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';

const router=Router();router.use(authenticate);
const id=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const remarkSql="CASE WHEN pv.passing_value IS NULL THEN NULL WHEN pv.pass_direction='AT_LEAST' AND g.value>=pv.passing_value OR pv.pass_direction='AT_MOST' AND g.value<=pv.passing_value THEN 'PASSED' ELSE 'FAILED' END";
router.get('/policy',async(req,res,next)=>{try{const [[row]]=await pool.query('SELECT label,minimum,maximum,passing_value passingValue,pass_direction passDirection,current_version_id currentVersionId,updated_at updatedAt FROM grading_policy WHERE id=1');return ok(res,row||null);}catch(error){next(error);}});
router.put('/policy',authorize('ADMIN'),async(req,res,next)=>{
  const {label,minimum,maximum,reason,passingValue,passDirection}=req.body||{};
  const min=Number(minimum),max=Number(maximum),hasPassing=passingValue!==undefined&&passingValue!==null&&passingValue!=='';
  const pass=hasPassing?Number(passingValue):null;
  if(typeof label!=='string'||!label.trim()||label.length>100||!Number.isFinite(min)||!Number.isFinite(max)||min>=max||min<0||max>9999||typeof reason!=='string'||!reason.trim()||reason.length>500||(hasPassing&&(!Number.isFinite(pass)||pass<min||pass>max||!['AT_LEAST','AT_MOST'].includes(passDirection)))||(!hasPassing&&passDirection))return fail(res,'Enter an approved scale, optional passing rule with direction, and reason.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[outside]]=await connection.execute('SELECT id FROM grade_records WHERE value<? OR value>? LIMIT 1',[min,max]);
    if(outside){await connection.rollback();return fail(res,'Existing grades fall outside that range. Review the policy before changing it.',409);}
    const [version]=await connection.execute('INSERT INTO grading_policy_versions(label,minimum,maximum,passing_value,pass_direction,created_by) VALUES (?,?,?,?,?,?)',[label.trim(),min,max,pass,hasPassing?passDirection:null,req.user.sub]);
    await connection.execute('INSERT INTO grading_policy(id,label,minimum,maximum,passing_value,pass_direction,current_version_id,updated_by) VALUES (1,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label),minimum=VALUES(minimum),maximum=VALUES(maximum),passing_value=VALUES(passing_value),pass_direction=VALUES(pass_direction),current_version_id=VALUES(current_version_id),updated_by=VALUES(updated_by)',[label.trim(),min,max,pass,hasPassing?passDirection:null,version.insertId,req.user.sub]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,'GRADE_POLICY_CHANGED','grading_policy',1,?)",[req.user.sub,JSON.stringify({versionId:version.insertId,label:label.trim(),minimum:min,maximum:max,passingValue:pass,passDirection:hasPassing?passDirection:null,reason:reason.trim()})]);
    await connection.commit();return ok(res,null,'Grading policy saved.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
router.get('/',async(req,res,next)=>{try{
  if(req.user.role==='STUDENT'){
    const [rows]=await pool.execute(`SELECT g.id,g.value,g.published_at publishedAt,${remarkSql} remark,pv.id policyVersionId,sub.code,sub.name,sub.units,sec.name section,t.academic_year academicYear,t.semester
      FROM grade_records g JOIN enrollments e ON e.id=g.enrollment_id JOIN students st ON st.id=e.student_id
      JOIN subject_offerings o ON o.id=e.offering_id JOIN subjects sub ON sub.id=o.subject_id JOIN sections sec ON sec.id=o.section_id JOIN academic_terms t ON t.id=o.term_id
      LEFT JOIN grading_policy_versions pv ON pv.id=g.policy_version_id
      WHERE st.user_id=? AND g.status='PUBLISHED' ORDER BY t.start_date DESC,sub.code LIMIT 200`,[req.user.sub]);return ok(res,rows);
  }
  const offeringId=id(req.query.offeringId);if(!offeringId)return fail(res,'Select a class assignment.',422);
  if(req.user.role==='FACULTY'){
    const [[owned]]=await pool.execute('SELECT o.id FROM subject_offerings o JOIN faculty f ON f.id=o.faculty_id WHERE o.id=? AND f.user_id=?',[offeringId,req.user.sub]);
    if(!owned)return fail(res,'Class assignment not found.',404);
  }
  const [rows]=await pool.execute(`SELECT e.id enrollmentId,e.status enrollmentStatus,st.student_no studentId,COALESCE(u.first_name,st.manual_first_name) firstName,COALESCE(u.last_name,st.manual_last_name) lastName,
    g.id gradeId,g.value,g.status gradeStatus,g.version,g.published_at publishedAt,g.submitted_at submittedAt,g.approved_at approvedAt,g.policy_version_id policyVersionId,${remarkSql} remark
    FROM enrollments e JOIN students st ON st.id=e.student_id LEFT JOIN users u ON u.id=st.user_id
    LEFT JOIN grade_records g ON g.enrollment_id=e.id LEFT JOIN grading_policy_versions pv ON pv.id=g.policy_version_id WHERE e.offering_id=? ORDER BY lastName,firstName LIMIT 300`,[offeringId]);
  return ok(res,rows);
}catch(error){next(error);}});
router.get('/export.csv',async(req,res,next)=>{try{
  const student=req.user.role==='STUDENT',offeringId=id(req.query.offeringId);
  if(!student&&!offeringId)return fail(res,'Select a class assignment to export.',422);
  if(req.user.role==='FACULTY'){const [[owned]]=await pool.execute('SELECT o.id FROM subject_offerings o JOIN faculty f ON f.id=o.faculty_id WHERE o.id=? AND f.user_id=?',[offeringId,req.user.sub]);if(!owned)return fail(res,'Class assignment not found.',404);}
  const params=student?[req.user.sub]:[offeringId];
  const [rows]=await pool.execute(`SELECT t.academic_year academicYear,t.semester,sub.code subjectCode,sub.name subjectTitle,sec.name section,CONCAT_WS(' ',fu.first_name,fu.last_name) teacher,st.student_no studentId,CONCAT_WS(' ',COALESCE(su.first_name,st.manual_first_name),COALESCE(su.last_name,st.manual_last_name)) studentName,g.value,${remarkSql} remark,g.status,g.policy_version_id policyVersionId
    FROM grade_records g JOIN enrollments e ON e.id=g.enrollment_id JOIN students st ON st.id=e.student_id LEFT JOIN users su ON su.id=st.user_id JOIN subject_offerings o ON o.id=e.offering_id JOIN subjects sub ON sub.id=o.subject_id JOIN sections sec ON sec.id=o.section_id JOIN academic_terms t ON t.id=o.term_id LEFT JOIN faculty f ON f.id=o.faculty_id LEFT JOIN users fu ON fu.id=f.user_id LEFT JOIN grading_policy_versions pv ON pv.id=g.policy_version_id
    WHERE ${student?"st.user_id=? AND g.status='PUBLISHED'":"o.id=?"} ORDER BY t.start_date DESC,sub.code,st.student_no LIMIT 1000`,params);
  const fields=['Academic year','Semester','Subject code','Subject title','Section','Teacher','Student ID','Student name','Grade','Remark','Workflow status','Policy version'];
  const safe=value=>{const raw=String(value??'');const escaped=/^[=+\-@\t\r]/.test(raw)?`'${raw}`:raw;return `"${escaped.replaceAll('"','""')}"`;};
  const lines=[fields.map(safe).join(','),...rows.map(row=>[row.academicYear,row.semester,row.subjectCode,row.subjectTitle,row.section,row.teacher,row.studentId,row.studentName,row.value,row.remark,row.status,row.policyVersionId].map(safe).join(','))];
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="sbaa-grade-report.csv"');res.setHeader('Cache-Control','private, no-store');return res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
}catch(error){next(error);}});
router.put('/:enrollmentId',authorize('FACULTY'),async(req,res,next)=>{
  const enrollmentId=id(req.params.enrollmentId),value=Number(req.body?.value),expectedVersion=req.body?.version;
  if(!enrollmentId||req.body?.value===''||req.body?.value==null||!Number.isFinite(value)||Number(value.toFixed(2))!==value||(req.body?.status!=null&&req.body.status!=='DRAFT')||(expectedVersion!=null&&!id(expectedVersion)))return fail(res,'Enter a draft grade with at most two decimal places.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[policy]]=await connection.execute('SELECT minimum,maximum,current_version_id versionId FROM grading_policy WHERE id=1');
    if(!policy||!policy.versionId){await connection.rollback();return fail(res,'The school grading scale must be configured before grades can be entered.',409);}
    if(value<Number(policy.minimum)||value>Number(policy.maximum)){await connection.rollback();return fail(res,'Grade is outside the current school scale.',422);}
    const [[record]]=await connection.execute(`SELECT e.id,e.status enrollmentStatus,f.user_id facultyUserId,g.id gradeId,g.value oldValue,g.status oldStatus,g.version
      FROM enrollments e JOIN subject_offerings o ON o.id=e.offering_id LEFT JOIN faculty f ON f.id=o.faculty_id
      LEFT JOIN grade_records g ON g.enrollment_id=e.id WHERE e.id=? FOR UPDATE`,[enrollmentId]);
    if(!record||record.enrollmentStatus!=='ENROLLED'){await connection.rollback();return fail(res,'Active enrollment not found.',404);}
    if(record.facultyUserId!==req.user.sub){await connection.rollback();return fail(res,'This class is not assigned to you.',403);}
    if(record.oldStatus&&record.oldStatus!=='DRAFT'){await connection.rollback();return fail(res,'Only draft grades can be edited. Ask an administrator to return or reopen this grade.',409);}
    if(expectedVersion!=null&&Number(expectedVersion)!==Number(record.version)){await connection.rollback();return fail(res,'This grade changed elsewhere. Reload before saving.',409);}
    if(record.gradeId)await connection.execute('UPDATE grade_records SET value=?,graded_by=?,policy_version_id=?,version=version+1 WHERE id=?',[value,req.user.sub,policy.versionId,record.gradeId]);
    else await connection.execute("INSERT INTO grade_records(enrollment_id,value,status,graded_by,policy_version_id) VALUES (?,?,'DRAFT',?,?)",[enrollmentId,value,req.user.sub,policy.versionId]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,'GRADE_DRAFT_SAVED','enrollments',?,?)",[req.user.sub,enrollmentId,JSON.stringify({oldValue:record.oldValue??null,newValue:value,policyVersionId:policy.versionId})]);
    await connection.commit();return ok(res,null,'Grade draft saved.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
router.post('/:enrollmentId/submit',authorize('FACULTY'),async(req,res,next)=>{
  const enrollmentId=id(req.params.enrollmentId);if(!enrollmentId)return fail(res,'Choose a grade.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[record]]=await connection.execute(`SELECT g.id,g.status,g.policy_version_id policyVersionId,pv.passing_value passingValue,pv.pass_direction passDirection,f.user_id facultyUserId
      FROM grade_records g JOIN enrollments e ON e.id=g.enrollment_id JOIN subject_offerings o ON o.id=e.offering_id
      JOIN faculty f ON f.id=o.faculty_id LEFT JOIN grading_policy_versions pv ON pv.id=g.policy_version_id WHERE e.id=? FOR UPDATE`,[enrollmentId]);
    if(!record){await connection.rollback();return fail(res,'Save a draft grade first.',404);}
    if(record.facultyUserId!==req.user.sub){await connection.rollback();return fail(res,'This class is not assigned to you.',403);}
    if(record.status!=='DRAFT'){await connection.rollback();return fail(res,'Only draft grades can be submitted.',409);}
    if(record.passingValue==null||!record.passDirection){await connection.rollback();return fail(res,'An approved passing rule is required before submission. Ask an administrator to configure the official policy.',409);}
    await connection.execute("UPDATE grade_records SET status='SUBMITTED',submitted_at=UTC_TIMESTAMP(),submitted_by=?,version=version+1 WHERE id=?",[req.user.sub,record.id]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,'GRADE_SUBMITTED','enrollments',?,?)",[req.user.sub,enrollmentId,JSON.stringify({policyVersionId:record.policyVersionId})]);
    await connection.commit();return ok(res,null,'Grade submitted for review.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
router.post('/:enrollmentId/decision',authorize('ADMIN'),async(req,res,next)=>{
  const enrollmentId=id(req.params.enrollmentId),decision=req.body?.decision,reason=req.body?.reason;
  if(!enrollmentId||!['APPROVE','RETURN'].includes(decision)||(decision==='RETURN'&&(typeof reason!=='string'||!reason.trim()||reason.length>500)))return fail(res,'Choose approval or provide a return reason.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[record]]=await connection.execute(`SELECT g.id,g.status,g.value,g.policy_version_id policyVersionId,pv.passing_value passingValue,pv.pass_direction passDirection,st.user_id studentUserId,f.user_id facultyUserId
      FROM grade_records g JOIN enrollments e ON e.id=g.enrollment_id JOIN students st ON st.id=e.student_id
      JOIN subject_offerings o ON o.id=e.offering_id LEFT JOIN faculty f ON f.id=o.faculty_id
      LEFT JOIN grading_policy_versions pv ON pv.id=g.policy_version_id WHERE e.id=? FOR UPDATE`,[enrollmentId]);
    if(!record){await connection.rollback();return fail(res,'Grade not found.',404);}
    if(record.status!=='SUBMITTED'){await connection.rollback();return fail(res,'Only submitted grades can be reviewed.',409);}
    if(decision==='APPROVE'&&(record.passingValue==null||!record.passDirection)){await connection.rollback();return fail(res,'The grade has no approved passing rule.',409);}
    const nextStatus=decision==='APPROVE'?'PUBLISHED':'DRAFT';
    await connection.execute("UPDATE grade_records SET status=?,approved_at=IF(?='PUBLISHED',UTC_TIMESTAMP(),NULL),approved_by=IF(?='PUBLISHED',?,NULL),published_at=IF(?='PUBLISHED',UTC_TIMESTAMP(),NULL),version=version+1 WHERE id=?",[nextStatus,nextStatus,nextStatus,req.user.sub,nextStatus,record.id]);
    if(decision==='APPROVE'&&record.studentUserId){const [notification]=await connection.execute("INSERT INTO notifications(type,title,body,resource_type,resource_id) VALUES ('GRADE','Grade published','A final grade is available for one of your classes.','grades',?)",[enrollmentId]);await connection.execute('INSERT INTO notification_recipients(notification_id,user_id) VALUES (?,?)',[notification.insertId,record.studentUserId]);}
    await connection.execute('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?)',[req.user.sub,decision==='APPROVE'?'GRADE_APPROVED':'GRADE_RETURNED','enrollments',enrollmentId,JSON.stringify({reason:decision==='RETURN'?reason.trim():null,policyVersionId:record.policyVersionId})]);
    await connection.commit();return ok(res,null,decision==='APPROVE'?'Grade approved and published.':'Grade returned to draft.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
router.post('/:enrollmentId/reopen',authorize('ADMIN'),async(req,res,next)=>{
  const enrollmentId=id(req.params.enrollmentId),reason=req.body?.reason;
  if(!enrollmentId||typeof reason!=='string'||!reason.trim()||reason.length>500)return fail(res,'Provide a correction reason.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[record]]=await connection.execute("SELECT id,status FROM grade_records WHERE enrollment_id=? FOR UPDATE",[enrollmentId]);
    if(!record){await connection.rollback();return fail(res,'Grade not found.',404);}
    if(record.status!=='PUBLISHED'){await connection.rollback();return fail(res,'Only published grades can be reopened.',409);}
    await connection.execute("UPDATE grade_records SET status='DRAFT',approved_at=NULL,approved_by=NULL,published_at=NULL,version=version+1 WHERE id=?",[record.id]);
    await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,'GRADE_REOPENED','enrollments',?,?)",[req.user.sub,enrollmentId,JSON.stringify({reason:reason.trim()})]);
    await connection.commit();return ok(res,null,'Published grade reopened for correction. It is hidden from students until reviewed again.');
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});
export default router;
