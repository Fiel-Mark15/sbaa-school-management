import { Router } from 'express';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';
import { scheduleSelection, calendarSnapshot, excelSnapshot, imageSnapshot, imagePages } from '../utils/schedule-export.js';

const router=Router();router.use(authenticate);
const validId=(v)=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const validTime=(v)=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const validDate=(value)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(new Date(`${value}T00:00:00Z`).getTime())&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;

router.get('/rooms',async(req,res,next)=>{try{const [rows]=await pool.query("SELECT id,code,name,capacity FROM rooms WHERE status='ACTIVE' ORDER BY code");return ok(res,rows);}catch(e){next(e);}});
router.post('/rooms',authorize('ADMIN'),async(req,res,next)=>{try{
  const {code,name,capacity}=req.body||{};
  if(typeof code!=='string'||!/^[A-Za-z0-9-]{2,40}$/.test(code)||typeof name!=='string'||!name.trim()||name.length>120||(capacity!=null&&(!Number.isInteger(Number(capacity))||Number(capacity)<1)))return fail(res,'Enter a valid room code, name, and capacity.',422);
  const [result]=await pool.execute('INSERT INTO rooms (code,name,capacity) VALUES (?,?,?)',[code.toUpperCase(),name.trim(),capacity==null?null:Number(capacity)]);
  return ok(res,{id:result.insertId},'Room created.',201);
}catch(e){if(e.code==='ER_DUP_ENTRY')return fail(res,'Room code already exists.',409);next(e);}});

router.get('/meetings',async(req,res,next)=>{
  try{
    const termId=validId(req.query.termId),params=[termId,termId];let scope='';
    if(req.user.role==='FACULTY'){scope=' AND f.user_id=?';params.push(req.user.sub);}
    if(req.user.role==='STUDENT'){scope=" AND EXISTS (SELECT 1 FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.offering_id=o.id AND e.status='ENROLLED' AND st.user_id=?)";params.push(req.user.sub);}
    const [rows]=await pool.query(`SELECT m.id,m.offering_id offeringId,m.room_id roomId,m.weekday,TIME_FORMAT(m.start_time,'%H:%i') startTime,TIME_FORMAT(m.end_time,'%H:%i') endTime,DATE_FORMAT(m.effective_start,'%Y-%m-%d') effectiveStart,DATE_FORMAT(m.effective_end,'%Y-%m-%d') effectiveEnd,
      r.code room,sub.id subjectId,sub.code subjectCode,sub.name subject,sec.id sectionId,sec.name section,f.id facultyId,o.term_id termId,t.academic_year academicYear,
      CONCAT(u.first_name,' ',u.last_name) faculty
      FROM schedule_meetings m JOIN subject_offerings o ON o.id=m.offering_id JOIN academic_terms t ON t.id=o.term_id
      JOIN subjects sub ON sub.id=o.subject_id JOIN sections sec ON sec.id=o.section_id JOIN rooms r ON r.id=m.room_id
      LEFT JOIN faculty f ON f.id=o.faculty_id LEFT JOIN users u ON u.id=f.user_id
      WHERE m.status='ACTIVE' AND o.status='ACTIVE' AND (? IS NULL OR o.term_id=?) ${scope}
      ORDER BY m.weekday,m.start_time LIMIT 500`,params);
    return ok(res,rows);
  }catch(e){next(e);}
});

// Every download uses the same role-scoped selection and requires an explicit term.
const exportCalendar=async(req,res,next)=>{try{
  const format=req.params.format;
  if(!['ics','xlsx','jpg'].includes(format))return fail(res,'Unsupported schedule format.',404);
  const selection=await scheduleSelection(req.user,req.query);
  if(!selection)return fail(res,'Choose a valid academic term and permitted filters.',422);
  if(!selection.term)return fail(res,'Academic term not found.',404);
  if(!selection.rows.length)return fail(res,'No scheduled classes match this selection.',404);
  if(format==='ics'&&(!selection.term.startDate||!selection.term.endDate))return fail(res,'Set the academic term dates before exporting a calendar. Timetable image and workbook snapshots remain available.',422);
  const filename=`sbaa-schedule-${selection.term.academicYear.replace(/[^A-Za-z0-9-]/g,'-')}-${selection.term.semester.toLowerCase()}-snapshot`;
  res.set('Cache-Control','private, no-store');
  if(format==='ics'){res.set('Content-Type','text/calendar; charset=utf-8');res.set('Content-Disposition',`attachment; filename="${filename}.ics"`);return res.send(calendarSnapshot(selection));}
  if(format==='xlsx'){res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.set('Content-Disposition',`attachment; filename="${filename}.xlsx"`);return res.send(Buffer.from(await excelSnapshot(selection)));}
  const page=Number(req.query.page||1),total=imagePages(selection.rows);
  if(!Number.isSafeInteger(page)||page<1||page>total)return fail(res,'Image page not found.',404);
  res.set('Content-Type','image/jpeg');res.set('Content-Disposition',`attachment; filename="${filename}-${page}-of-${total}.jpg"`);res.set('X-Schedule-Pages',String(total));res.set('Access-Control-Expose-Headers','X-Schedule-Pages');
  return res.send(await imageSnapshot(selection,page));
}catch(e){next(e);}};
// Keep the existing calendar URL working; it now shares the same export path.
router.get('/calendar.ics',(req,res,next)=>{req.params.format='ics';return exportCalendar(req,res,next);});
router.get('/export/:format',exportCalendar);

async function saveMeeting(req,res,next){
  const meetingId=req.params.id?validId(req.params.id):null;
  const offeringId=validId(req.body?.offeringId),roomId=validId(req.body?.roomId),weekday=Number(req.body?.weekday),start=req.body?.startTime,end=req.body?.endTime;
  const effectiveStart=req.body?.effectiveStart||null,effectiveEnd=req.body?.effectiveEnd||null;
  if((req.params.id&&!meetingId)||!offeringId||!roomId||!Number.isInteger(weekday)||weekday<1||weekday>7||!validTime(start)||!validTime(end)||start>=end||(effectiveStart&&!validDate(effectiveStart))||(effectiveEnd&&!validDate(effectiveEnd))||(effectiveStart&&effectiveEnd&&effectiveStart>effectiveEnd))return fail(res,'Choose a valid class assignment, room, weekday, time range, and effective dates.',422);
  const connection=await pool.getConnection();let lockName=null;
  try{
    const [[offering]]=await connection.execute("SELECT o.id,o.term_id,o.section_id,o.faculty_id,DATE_FORMAT(t.start_date,'%Y-%m-%d') termStart,DATE_FORMAT(t.end_date,'%Y-%m-%d') termEnd FROM subject_offerings o JOIN academic_terms t ON t.id=o.term_id WHERE o.id=? AND o.status='ACTIVE'",[offeringId]);
    if(!offering)return fail(res,'Class assignment not found.',404);
    if((effectiveStart&&(effectiveStart<offering.termStart||effectiveStart>offering.termEnd))||(effectiveEnd&&(effectiveEnd<offering.termStart||effectiveEnd>offering.termEnd)))return fail(res,'Effective dates must fall within the academic term.',422);
    const [[room]]=await connection.execute("SELECT id FROM rooms WHERE id=? AND status='ACTIVE'",[roomId]);
    if(!room)return fail(res,'Room not found.',404);
    lockName='sbaa:schedule:write';
    const [[locked]]=await connection.execute('SELECT GET_LOCK(?,10) acquired',[lockName]);
    if(locked.acquired!==1)return fail(res,'Schedule is busy. Please try again.',409);
    await connection.beginTransaction();
    if(meetingId){const [[existing]]=await connection.execute('SELECT id FROM schedule_meetings WHERE id=? FOR UPDATE',[meetingId]);if(!existing){await connection.rollback();return fail(res,'Meeting not found.',404);}}
    const [conflicts]=await connection.execute(`SELECT m.id,sub.code,TIME_FORMAT(m.start_time,'%H:%i') startTime,TIME_FORMAT(m.end_time,'%H:%i') endTime,
      CASE WHEN m.room_id=? THEN 'room' WHEN other.faculty_id=? AND ? IS NOT NULL THEN 'faculty'
        WHEN other.section_id=? THEN 'section' ELSE 'student' END conflictType
      FROM schedule_meetings m JOIN subject_offerings other ON other.id=m.offering_id JOIN subjects sub ON sub.id=other.subject_id
      WHERE m.status='ACTIVE' AND other.status='ACTIVE' AND other.term_id=? AND m.weekday=?
        AND m.start_time<? AND m.end_time>? AND (? IS NULL OR m.id<>?)
        AND (m.room_id=? OR (other.faculty_id=? AND ? IS NOT NULL) OR other.section_id=?
          OR EXISTS (SELECT 1 FROM enrollments e1 JOIN enrollments e2 ON e2.student_id=e1.student_id
            WHERE e1.offering_id=? AND e2.offering_id=other.id AND e1.status='ENROLLED' AND e2.status='ENROLLED')) LIMIT 1`,
      [roomId,offering.faculty_id,offering.faculty_id,offering.section_id,offering.term_id,weekday,end,start,meetingId,meetingId,roomId,offering.faculty_id,offering.faculty_id,offering.section_id,offeringId]);
    if(conflicts.length){await connection.rollback();const c=conflicts[0];return fail(res,`Conflicts with ${c.code} (${c.startTime}–${c.endTime}) for the ${c.conflictType}.`,409);}
    let savedId=meetingId;
    if(meetingId)await connection.execute('UPDATE schedule_meetings SET offering_id=?,room_id=?,weekday=?,start_time=?,end_time=?,effective_start=?,effective_end=?,status=\'ACTIVE\' WHERE id=?',[offeringId,roomId,weekday,start,end,effectiveStart,effectiveEnd,meetingId]);
    else{const [result]=await connection.execute('INSERT INTO schedule_meetings (offering_id,room_id,weekday,start_time,end_time,effective_start,effective_end) VALUES (?,?,?,?,?,?,?)',[offeringId,roomId,weekday,start,end,effectiveStart,effectiveEnd]);savedId=result.insertId;}
    const dayName=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][weekday-1];
    const [notice]=await connection.execute("INSERT INTO notifications (type,title,body,resource_type,resource_id) VALUES ('SCHEDULE','Class schedule updated',?,'schedule',?)",[`A class meeting is scheduled for ${dayName}, ${start}–${end} (Asia/Manila).`,savedId]);
    await connection.execute(`INSERT IGNORE INTO notification_recipients (notification_id,user_id)
      SELECT ?,u.id FROM users u JOIN faculty f ON f.user_id=u.id WHERE f.id=? AND u.status='ACTIVE'
      UNION SELECT ?,u.id FROM users u JOIN students st ON st.user_id=u.id JOIN enrollments e ON e.student_id=st.id
      WHERE e.offering_id=? AND e.status='ENROLLED' AND u.status='ACTIVE'`,[notice.insertId,offering.faculty_id,notice.insertId,offeringId]);
    await connection.execute('INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,?,?,?)',[req.user.sub,meetingId?'SCHEDULE_UPDATED':'SCHEDULE_CREATED','schedule_meetings',savedId]);
    await connection.commit();return ok(res,{id:savedId},'Schedule saved.',meetingId?200:201);
  }catch(e){try{await connection.rollback();}catch{}next(e);}finally{if(lockName)try{await connection.execute('SELECT RELEASE_LOCK(?)',[lockName]);}catch{}connection.release();}
}
router.post('/meetings',authorize('ADMIN'),saveMeeting);
router.put('/meetings/:id',authorize('ADMIN'),saveMeeting);
router.get('/meetings/:id/exceptions',async(req,res,next)=>{try{
  const meetingId=validId(req.params.id);if(!meetingId)return fail(res,'Invalid meeting.',422);
  const [[meeting]]=await pool.execute(`SELECT m.id FROM schedule_meetings m JOIN subject_offerings o ON o.id=m.offering_id LEFT JOIN faculty f ON f.id=o.faculty_id WHERE m.id=? AND (?='ADMIN' OR (?='FACULTY' AND f.user_id=?) OR (?='STUDENT' AND EXISTS(SELECT 1 FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.offering_id=o.id AND e.status='ENROLLED' AND st.user_id=?)))`,[meetingId,req.user.role,req.user.role,req.user.sub,req.user.role,req.user.sub]);
  if(!meeting)return fail(res,'Meeting not found.',404);
  const [rows]=await pool.execute("SELECT DATE_FORMAT(occurrence_date,'%Y-%m-%d') occurrenceDate,reason FROM schedule_exceptions WHERE meeting_id=? ORDER BY occurrence_date",[meetingId]);return ok(res,rows);
}catch(error){next(error);}});
router.post('/meetings/:id/exceptions',authorize('ADMIN'),async(req,res,next)=>{
  const meetingId=validId(req.params.id),date=req.body?.occurrenceDate,reason=req.body?.reason;
  if(!meetingId||!validDate(date)||typeof reason!=='string'||!reason.trim()||reason.length>500)return fail(res,'Enter a valid cancellation date and reason.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[meeting]]=await connection.execute(`SELECT m.id,m.weekday,m.offering_id,o.faculty_id,DATE_FORMAT(COALESCE(m.effective_start,t.start_date),'%Y-%m-%d') begins,DATE_FORMAT(COALESCE(m.effective_end,t.end_date),'%Y-%m-%d') ends FROM schedule_meetings m JOIN subject_offerings o ON o.id=m.offering_id JOIN academic_terms t ON t.id=o.term_id WHERE m.id=? AND m.status='ACTIVE' FOR UPDATE`,[meetingId]);
    const localDay=new Date(`${date}T00:00:00Z`).getUTCDay()||7;
    if(!meeting||date<meeting.begins||date>meeting.ends||localDay!==meeting.weekday){await connection.rollback();return fail(res,'The cancellation must match an active class occurrence within its term.',422);}
    await connection.execute('INSERT INTO schedule_exceptions(meeting_id,occurrence_date,reason,created_by) VALUES (?,?,?,?)',[meetingId,date,reason.trim(),req.user.sub]);
    const [notice]=await connection.execute("INSERT INTO notifications(type,title,body,resource_type,resource_id) VALUES ('SCHEDULE','Class occurrence cancelled',?,'schedule',?)",[`The class meeting on ${date} (Asia/Manila) was cancelled. Check your schedule for details.`,meetingId]);
    await connection.execute(`INSERT IGNORE INTO notification_recipients(notification_id,user_id) SELECT ?,u.id FROM users u JOIN faculty f ON f.user_id=u.id WHERE f.id=? AND u.status='ACTIVE' UNION SELECT ?,u.id FROM users u JOIN students st ON st.user_id=u.id JOIN enrollments e ON e.student_id=st.id WHERE e.offering_id=? AND e.status='ENROLLED' AND u.status='ACTIVE'`,[notice.insertId,meeting.faculty_id,notice.insertId,meeting.offering_id]);
    await connection.execute('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?)',[req.user.sub,'CLASS_OCCURRENCE_CANCELLED','schedule_meetings',meetingId,JSON.stringify({date,reason:reason.trim()})]);
    await connection.commit();return ok(res,null,'Class occurrence cancelled.');
  }catch(error){await connection.rollback();if(error.code==='ER_DUP_ENTRY')return fail(res,'This occurrence is already cancelled.',409);next(error);}finally{connection.release();}
});
router.patch('/meetings/:id/archive',authorize('ADMIN'),async(req,res,next)=>{
  const meetingId=validId(req.params.id);if(!meetingId)return fail(res,'Invalid meeting.',422);
  const connection=await pool.getConnection();try{await connection.beginTransaction();
    const [[meeting]]=await connection.execute(`SELECT m.id,m.offering_id,o.faculty_id FROM schedule_meetings m JOIN subject_offerings o ON o.id=m.offering_id WHERE m.id=? AND m.status='ACTIVE' FOR UPDATE`,[meetingId]);
    if(!meeting){await connection.rollback();return fail(res,'Meeting not found.',404);}
    await connection.execute("UPDATE schedule_meetings SET status='ARCHIVED' WHERE id=?",[meetingId]);
    const [notice]=await connection.execute("INSERT INTO notifications (type,title,body,resource_type,resource_id) VALUES ('SCHEDULE','Class schedule changed','A class meeting was removed from the schedule.','schedule',?)",[meetingId]);
    await connection.execute(`INSERT IGNORE INTO notification_recipients (notification_id,user_id)
      SELECT ?,u.id FROM users u JOIN faculty f ON f.user_id=u.id WHERE f.id=? AND u.status='ACTIVE'
      UNION SELECT ?,u.id FROM users u JOIN students st ON st.user_id=u.id JOIN enrollments e ON e.student_id=st.id
      WHERE e.offering_id=? AND e.status='ENROLLED' AND u.status='ACTIVE'`,[notice.insertId,meeting.faculty_id,notice.insertId,meeting.offering_id]);
    await connection.execute("INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES (?,'SCHEDULE_ARCHIVED','schedule_meetings',?)",[req.user.sub,meetingId]);
    await connection.commit();return ok(res,null,'Meeting archived.');
  }catch(e){await connection.rollback();next(e);}finally{connection.release();}
});
export default router;
