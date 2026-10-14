import { Router } from 'express';
import { pool } from '../database/pool.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { fail, ok } from '../utils/response.js';

const router=Router();router.use(authenticate);
const id=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const dateValid=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const parsed=Date.parse(`${value}T00:00:00+08:00`);return Number.isFinite(parsed)&&new Date(parsed+8*3600000).toISOString().slice(0,10)===value;};
const timeValid=value=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const minutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3,5));
const formatTime=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
const instant=(date,time)=>new Date(`${date}T${time}:00+08:00`);
const sqlDate=value=>value.toISOString().slice(0,19).replace('T',' ');
const weekday=date=>(new Date(`${date}T12:00:00+08:00`).getUTCDay()+6)%7+1;
const interval=(date,start,end)=>[instant(date,start),instant(date,end)];
async function notify(connection,recipient,title,body,appointmentId){
  const [notice]=await connection.execute("INSERT INTO notifications(type,title,body,resource_type,resource_id) VALUES ('APPOINTMENT',?,?, 'appointment',?)",[title,body,appointmentId]);
  await connection.execute('INSERT INTO notification_recipients(notification_id,user_id) VALUES (?,?)',[notice.insertId,recipient]);
}
async function settings(connection=pool){const [[row]]=await connection.query('SELECT advance_days advanceDays,cancellation_hours cancellationHours FROM appointment_settings WHERE id=1');return row;}
async function availability(connection,facultyId,date){
  const [rules]=await connection.execute('SELECT id,start_time startTime,end_time endTime,slot_minutes slotMinutes,buffer_minutes bufferMinutes FROM appointment_availability WHERE faculty_id=? AND weekday=? AND active=TRUE',[facultyId,weekday(date)]);
  const [[exception]]=await connection.execute('SELECT id FROM appointment_exceptions WHERE faculty_id=? AND unavailable_date=?',[facultyId,date]);
  return exception?[]:rules;
}
async function slotCheck(connection,{facultyId,studentId,date,startTime,endTime,excludeId=null}){
  const start=minutes(startTime),end=minutes(endTime),rules=await availability(connection,facultyId,date);
  const rule=rules.find(row=>start>=minutes(row.startTime)&&end<=minutes(row.endTime)&&end-start===row.slotMinutes&&((start-minutes(row.startTime))%(row.slotMinutes+row.bufferMinutes)===0));
  if(!rule)return 'This slot is outside the teacher’s available consultation hours.';
  const [begin,finish]=interval(date,startTime,endTime);
  if(begin.getTime()<=Date.now())return 'Choose a future time.';
  const policy=await settings(connection);
  if(begin.getTime()>Date.now()+policy.advanceDays*86400000)return `Choose a date within ${policy.advanceDays} days.`;
  const [occupied]=await connection.execute("SELECT id FROM appointments WHERE faculty_id=? AND id<>? AND status IN ('PENDING','APPROVED') AND starts_at<? AND ends_at>? LIMIT 1",[facultyId,excludeId||0,sqlDate(finish),sqlDate(begin)]);
  if(occupied.length)return 'That consultation slot is already held. Pending requests hold a slot until decided or cancelled.';
  const [facultyClass]=await connection.execute(`SELECT m.id FROM schedule_meetings m JOIN subject_offerings o ON o.id=m.offering_id WHERE o.faculty_id=? AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.weekday=? AND m.start_time<? AND m.end_time>? LIMIT 1`,[facultyId,weekday(date),endTime,startTime]);
  if(facultyClass.length)return 'The teacher has a class at that time.';
  if(studentId){
    const [studentClass]=await connection.execute(`SELECT m.id FROM schedule_meetings m JOIN enrollments e ON e.offering_id=m.offering_id AND e.status='ENROLLED' WHERE e.student_id=? AND m.status='ACTIVE' AND m.weekday=? AND m.start_time<? AND m.end_time>? LIMIT 1`,[studentId,weekday(date),endTime,startTime]);
    if(studentClass.length)return 'You have a class at that time.';
    const [studentAppointment]=await connection.execute("SELECT id FROM appointments WHERE student_id=? AND id<>? AND status IN ('PENDING','APPROVED') AND starts_at<? AND ends_at>? LIMIT 1",[studentId,excludeId||0,sqlDate(finish),sqlDate(begin)]);
    if(studentAppointment.length)return 'You already have an appointment at that time.';
  }
  return null;
}
async function withSlotLock(facultyId,date,work){
  const connection=await pool.getConnection(),name=`sbaa:appt:${facultyId}:${date}`;
  try{
    const [[lock]]=await connection.execute('SELECT GET_LOCK(?,5) acquired',[name]);
    if(lock.acquired!==1)return {busy:true};
    await connection.beginTransaction();
    const result=await work(connection);
    if(result?.error)await connection.rollback();else await connection.commit();
    return result;
  }catch(error){await connection.rollback();throw error;}
  finally{try{await connection.execute('SELECT RELEASE_LOCK(?)',[name]);}catch{}connection.release();}
}
router.get('/settings',async(req,res,next)=>{try{return ok(res,await settings());}catch(error){next(error);}});
router.put('/settings',authorize('ADMIN'),async(req,res,next)=>{try{
  const advance=Number(req.body?.advanceDays),cancel=Number(req.body?.cancellationHours);
  if(!Number.isSafeInteger(advance)||advance<1||advance>180||!Number.isSafeInteger(cancel)||cancel<0||cancel>168)return fail(res,'Choose 1–180 advance days and 0–168 cancellation hours.',422);
  await pool.execute('UPDATE appointment_settings SET advance_days=?,cancellation_hours=? WHERE id=1',[advance,cancel]);
  await pool.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'APPOINTMENT_SETTINGS_UPDATED','appointment_settings',1)",[req.user.sub]);return ok(res,null,'Appointment policy saved.');
}catch(error){next(error);}});
router.get('/faculty',async(req,res,next)=>{try{const [rows]=await pool.query("SELECT f.id,f.user_id userId,CONCAT_WS(' ',u.first_name,u.middle_name,u.last_name) name,f.position FROM faculty f JOIN users u ON u.id=f.user_id WHERE u.status='ACTIVE' ORDER BY u.last_name,u.first_name");return ok(res,rows);}catch(error){next(error);}});
router.get('/availability',async(req,res,next)=>{try{
  const facultyId=id(req.query.facultyId);if(!facultyId)return fail(res,'Choose a teacher.',422);
  const [rows]=await pool.execute('SELECT id,weekday,start_time startTime,end_time endTime,slot_minutes slotMinutes,buffer_minutes bufferMinutes FROM appointment_availability WHERE faculty_id=? AND active=TRUE ORDER BY weekday,start_time',[facultyId]);
  return ok(res,rows);
}catch(error){next(error);}});
router.post('/availability',authorize('FACULTY'),async(req,res,next)=>{try{
  const day=Number(req.body?.weekday),start=req.body?.startTime,end=req.body?.endTime,duration=Number(req.body?.slotMinutes),buffer=Number(req.body?.bufferMinutes);
  if(!Number.isInteger(day)||day<1||day>7||!timeValid(start)||!timeValid(end)||minutes(end)<=minutes(start)||!Number.isInteger(duration)||duration<15||duration>120||!Number.isInteger(buffer)||buffer<0||buffer>60||minutes(end)-minutes(start)<duration)return fail(res,'Enter a valid weekday, time range, slot duration, and buffer.',422);
  const [[faculty]]=await pool.execute('SELECT id FROM faculty WHERE user_id=?',[req.user.sub]);
  const [result]=await pool.execute('INSERT INTO appointment_availability(faculty_id,weekday,start_time,end_time,slot_minutes,buffer_minutes) VALUES (?,?,?,?,?,?)',[faculty.id,day,start,end,duration,buffer]);
  return ok(res,{id:result.insertId},'Availability added.',201);
}catch(error){next(error);}});
router.delete('/availability/:id',authorize('FACULTY'),async(req,res,next)=>{try{
  const item=id(req.params.id);if(!item)return fail(res,'Invalid availability.',422);
  const [result]=await pool.execute('UPDATE appointment_availability a JOIN faculty f ON f.id=a.faculty_id SET a.active=FALSE WHERE a.id=? AND f.user_id=?',[item,req.user.sub]);
  return result.affectedRows?ok(res,null,'Availability removed.'):fail(res,'Availability not found.',404);
}catch(error){next(error);}});
router.get('/exceptions',authorize('FACULTY'),async(req,res,next)=>{try{const [rows]=await pool.execute('SELECT ex.id,ex.unavailable_date date,ex.reason FROM appointment_exceptions ex JOIN faculty f ON f.id=ex.faculty_id WHERE f.user_id=? ORDER BY ex.unavailable_date DESC LIMIT 100',[req.user.sub]);return ok(res,rows);}catch(error){next(error);}});
router.post('/exceptions',authorize('FACULTY'),async(req,res,next)=>{try{
  const date=req.body?.date,reason=req.body?.reason;
  if(!dateValid(date)||reason!=null&&(typeof reason!=='string'||reason.length>200))return fail(res,'Enter a valid date and optional reason.',422);
  const [[faculty]]=await pool.execute('SELECT id FROM faculty WHERE user_id=?',[req.user.sub]);
  await pool.execute('INSERT INTO appointment_exceptions(faculty_id,unavailable_date,reason) VALUES (?,?,?) ON DUPLICATE KEY UPDATE reason=VALUES(reason)',[faculty.id,date,reason?.trim()||null]);return ok(res,null,'Unavailable date saved.');
}catch(error){next(error);}});
router.get('/slots',authorize('STUDENT'),async(req,res,next)=>{try{
  const facultyId=id(req.query.facultyId),date=req.query.date;if(!facultyId||!dateValid(date))return fail(res,'Choose a teacher and date.',422);
  const [[student]]=await pool.execute('SELECT id FROM students WHERE user_id=?',[req.user.sub]);
  const rules=await availability(pool,facultyId,date),slots=[];
  for(const row of rules)for(let start=minutes(row.startTime);start+row.slotMinutes<=minutes(row.endTime);start+=row.slotMinutes+row.bufferMinutes){
    const startTime=formatTime(start),endTime=formatTime(start+row.slotMinutes),unavailable=await slotCheck(pool,{facultyId,studentId:student.id,date,startTime,endTime});
    slots.push({startTime,endTime,available:!unavailable,reason:unavailable||null});
  }
  return ok(res,slots);
}catch(error){next(error);}});
router.get('/',async(req,res,next)=>{try{
  const params=[],conditions=[];
  if(req.user.role==='STUDENT'){conditions.push('st.user_id=?');params.push(req.user.sub);}
  else if(req.user.role==='FACULTY'){conditions.push('f.user_id=?');params.push(req.user.sub);}
  else{
    if(req.query.facultyId){const facultyId=id(req.query.facultyId);if(!facultyId)return fail(res,'Choose a valid teacher.',422);conditions.push('f.id=?');params.push(facultyId);}
    if(req.query.date){if(!dateValid(req.query.date))return fail(res,'Choose a valid date.',422);conditions.push('DATE(DATE_ADD(a.starts_at,INTERVAL 8 HOUR))=?');params.push(req.query.date);}
    if(req.query.status){if(!['PENDING','APPROVED','REJECTED','COMPLETED','CANCELLED','NO_SHOW'].includes(req.query.status))return fail(res,'Choose a valid status.',422);conditions.push('a.status=?');params.push(req.query.status);}
  }
  const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
  const [rows]=await pool.execute(`SELECT a.id,a.faculty_id facultyId,a.student_id studentId,DATE_FORMAT(a.starts_at,'%Y-%m-%dT%H:%i:%sZ') startsAt,DATE_FORMAT(a.ends_at,'%Y-%m-%dT%H:%i:%sZ') endsAt,a.status,a.meeting_details meetingDetails,a.response_reason responseReason,DATE_FORMAT(a.proposed_starts_at,'%Y-%m-%dT%H:%i:%sZ') proposedStartsAt,DATE_FORMAT(a.proposed_ends_at,'%Y-%m-%dT%H:%i:%sZ') proposedEndsAt,a.proposed_by proposedBy,CONCAT_WS(' ',fu.first_name,fu.last_name) facultyName,CONCAT_WS(' ',su.first_name,su.last_name) studentName,${req.user.role==='ADMIN'?'NULL':'a.purpose'} purpose FROM appointments a JOIN students st ON st.id=a.student_id JOIN users su ON su.id=st.user_id JOIN faculty f ON f.id=a.faculty_id JOIN users fu ON fu.id=f.user_id ${where} ORDER BY a.starts_at DESC LIMIT 200`,params);
  return ok(res,rows);
}catch(error){next(error);}});
router.post('/',authorize('STUDENT'),async(req,res,next)=>{
  const facultyId=id(req.body?.facultyId),date=req.body?.date,startTime=req.body?.startTime,endTime=req.body?.endTime,purpose=req.body?.purpose,details=req.body?.meetingDetails;
  if(!facultyId||!dateValid(date)||!timeValid(startTime)||!timeValid(endTime)||typeof purpose!=='string'||!purpose.trim()||purpose.length>500||details!=null&&(typeof details!=='string'||details.length>500))return fail(res,'Enter a valid consultation request.',422);
  try{
    const result=await withSlotLock(facultyId,date,async connection=>{
      const [[faculty]]=await connection.execute("SELECT f.id,f.user_id userId FROM faculty f JOIN users u ON u.id=f.user_id WHERE f.id=? AND u.status='ACTIVE'",[facultyId]);
      const [[student]]=await connection.execute('SELECT id FROM students WHERE user_id=?',[req.user.sub]);
      if(!faculty||!student)return {error:'Teacher or student account unavailable.',status:404};
      const problem=await slotCheck(connection,{facultyId,studentId:student.id,date,startTime,endTime});if(problem)return {error:problem,status:409};
      const [begin,finish]=interval(date,startTime,endTime);
      const [created]=await connection.execute("INSERT INTO appointments(student_id,faculty_id,starts_at,ends_at,status,purpose,meeting_details) VALUES (?,?,?,?, 'PENDING',?,?)",[student.id,facultyId,sqlDate(begin),sqlDate(finish),purpose.trim(),details?.trim()||null]);
      await notify(connection,faculty.userId,'New consultation request','A student requested a consultation. Open Appointments to respond.',created.insertId);
      await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'APPOINTMENT_REQUESTED','appointments',?)",[req.user.sub,created.insertId]);
      return {id:created.insertId};
    });
    return result.busy?fail(res,'Booking is busy. Try again.',409):result.error?fail(res,result.error,result.status):ok(res,{id:result.id},'Consultation requested. This pending request holds the slot until a decision or cancellation.',201);
  }catch(error){next(error);}
});
router.patch('/:id/status',async(req,res,next)=>{
  const appointmentId=id(req.params.id),status=req.body?.status,reason=req.body?.reason;
  if(!appointmentId||!['APPROVED','REJECTED','COMPLETED','CANCELLED','NO_SHOW'].includes(status)||reason!=null&&(typeof reason!=='string'||reason.length>500))return fail(res,'Enter a valid appointment action and reason.',422);
  try{
    const [[existing]]=await pool.execute('SELECT a.faculty_id facultyId,DATE_FORMAT(DATE_ADD(a.starts_at,INTERVAL 8 HOUR),\'%Y-%m-%d\') localDate FROM appointments a WHERE a.id=?',[appointmentId]);
    if(!existing)return fail(res,'Appointment not found.',404);
    const result=await withSlotLock(existing.facultyId,existing.localDate,async connection=>{
      const [[row]]=await connection.execute('SELECT a.*,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),a.starts_at) secondsUntilStart,st.user_id studentUserId,f.user_id facultyUserId FROM appointments a JOIN students st ON st.id=a.student_id JOIN faculty f ON f.id=a.faculty_id WHERE a.id=? FOR UPDATE',[appointmentId]);
      const owner=req.user.sub===row.studentUserId,teacher=req.user.sub===row.facultyUserId;
      if(!owner&&!teacher)return {error:'Not your appointment.',status:403};
      if(owner&&!teacher&&status!=='CANCELLED')return {error:'Only the assigned teacher can decide this request.',status:403};
      const allowed=teacher?(row.status==='PENDING'?['APPROVED','REJECTED']:row.status==='APPROVED'?['COMPLETED','CANCELLED','NO_SHOW']:[]):owner?(row.status==='PENDING'||row.status==='APPROVED'?['CANCELLED']:[]):[];
      if(!allowed.includes(status))return {error:'This status transition is not allowed.',status:409};
      if(status==='APPROVED'&&row.secondsUntilStart<=0)return {error:'This appointment has already started.',status:409};
      if(['COMPLETED','NO_SHOW'].includes(status)&&row.secondsUntilStart>0)return {error:'You can mark completion or no-show only after the appointment begins.',status:409};
      if(status==='REJECTED'&&!reason?.trim())return {error:'Give the student a reason for rejection.',status:422};
      if(owner&&status==='CANCELLED'){
        const policy=await settings(connection);if(row.secondsUntilStart<=0||row.secondsUntilStart<policy.cancellationHours*3600)return {error:`Cancellation requires ${policy.cancellationHours} hours notice. Contact the teacher.`,status:409};
      }
      await connection.execute('UPDATE appointments SET status=?,response_reason=?,proposed_starts_at=NULL,proposed_ends_at=NULL,proposed_by=NULL WHERE id=?',[status,reason?.trim()||null,appointmentId]);
      await notify(connection,owner?row.facultyUserId:row.studentUserId,'Consultation '+status.toLowerCase(),`Appointment #${appointmentId} is now ${status.toLowerCase()}.`,appointmentId);
      await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata) VALUES (?,'APPOINTMENT_STATUS_CHANGED','appointments',?,?)",[req.user.sub,appointmentId,JSON.stringify({from:row.status,to:status})]);
      return {};
    });
    return result.busy?fail(res,'Appointment update is busy.',409):result.error?fail(res,result.error,result.status):ok(res,null,'Appointment updated.');
  }catch(error){next(error);}
});
router.post('/:id/proposal',async(req,res,next)=>{
  const appointmentId=id(req.params.id),date=req.body?.date,startTime=req.body?.startTime,endTime=req.body?.endTime;
  if(!appointmentId||!dateValid(date)||!timeValid(startTime)||!timeValid(endTime))return fail(res,'Choose a valid proposed date and time.',422);
  try{
    const [[target]]=await pool.execute('SELECT faculty_id facultyId FROM appointments WHERE id=?',[appointmentId]);if(!target)return fail(res,'Appointment not found.',404);
    const result=await withSlotLock(target.facultyId,date,async connection=>{
      const [[row]]=await connection.execute('SELECT a.id,a.status,a.student_id studentId,st.user_id studentUserId,f.user_id facultyUserId FROM appointments a JOIN students st ON st.id=a.student_id JOIN faculty f ON f.id=a.faculty_id WHERE a.id=? FOR UPDATE',[appointmentId]);
      if(req.user.sub!==row.studentUserId&&req.user.sub!==row.facultyUserId)return {error:'Not your appointment.',status:403};
      if(!['PENDING','APPROVED'].includes(row.status))return {error:'Only active requests can be rescheduled.',status:409};
      const problem=await slotCheck(connection,{facultyId:target.facultyId,studentId:row.studentId,date,startTime,endTime,excludeId:appointmentId});if(problem)return {error:problem,status:409};
      const [begin,finish]=interval(date,startTime,endTime);
      await connection.execute('UPDATE appointments SET proposed_starts_at=?,proposed_ends_at=?,proposed_by=? WHERE id=?',[sqlDate(begin),sqlDate(finish),req.user.sub,appointmentId]);
      await notify(connection,req.user.sub===row.studentUserId?row.facultyUserId:row.studentUserId,'Consultation reschedule proposed','Review the new time in Appointments. The original time remains booked until accepted.',appointmentId);
      await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'APPOINTMENT_RESCHEDULE_PROPOSED','appointments',?)",[req.user.sub,appointmentId]);return {};
    });
    return result.busy?fail(res,'Appointment update is busy.',409):result.error?fail(res,result.error,result.status):ok(res,null,'Proposal sent. The original time remains booked until the other person accepts.');
  }catch(error){next(error);}
});
router.post('/:id/accept-proposal',async(req,res,next)=>{
  const appointmentId=id(req.params.id);if(!appointmentId)return fail(res,'Invalid appointment.',422);
  try{
    const [[target]]=await pool.execute("SELECT faculty_id facultyId,DATE_FORMAT(DATE_ADD(proposed_starts_at,INTERVAL 8 HOUR),'%Y-%m-%d') localDate FROM appointments WHERE id=?",[appointmentId]);
    if(!target?.localDate)return fail(res,'No proposal is pending.',409);
    const result=await withSlotLock(target.facultyId,target.localDate,async connection=>{
      const [[row]]=await connection.execute("SELECT a.id,a.status,a.student_id studentId,a.proposed_by proposedBy,DATE_FORMAT(DATE_ADD(a.proposed_starts_at,INTERVAL 8 HOUR),'%H:%i') startTime,DATE_FORMAT(DATE_ADD(a.proposed_ends_at,INTERVAL 8 HOUR),'%H:%i') endTime,st.user_id studentUserId,f.user_id facultyUserId FROM appointments a JOIN students st ON st.id=a.student_id JOIN faculty f ON f.id=a.faculty_id WHERE a.id=? FOR UPDATE",[appointmentId]);
      if(!row?.proposedBy||!['PENDING','APPROVED'].includes(row.status))return {error:'The proposal is no longer available.',status:409};
      if(req.user.sub===row.proposedBy||![row.studentUserId,row.facultyUserId].includes(req.user.sub))return {error:'Only the other participant may accept this proposal.',status:403};
      const problem=await slotCheck(connection,{facultyId:target.facultyId,studentId:row.studentId,date:target.localDate,startTime:row.startTime,endTime:row.endTime,excludeId:appointmentId});if(problem)return {error:problem,status:409};
      const [begin,finish]=interval(target.localDate,row.startTime,row.endTime);
      await connection.execute('UPDATE appointments SET starts_at=?,ends_at=?,proposed_starts_at=NULL,proposed_ends_at=NULL,proposed_by=NULL WHERE id=?',[sqlDate(begin),sqlDate(finish),appointmentId]);
      await notify(connection,row.proposedBy,'Consultation rescheduled','The new consultation time was accepted. Open Appointments for details.',appointmentId);
      await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'APPOINTMENT_RESCHEDULE_ACCEPTED','appointments',?)",[req.user.sub,appointmentId]);return {};
    });
    return result.busy?fail(res,'Appointment update is busy.',409):result.error?fail(res,result.error,result.status):ok(res,null,'New consultation time accepted.');
  }catch(error){next(error);}
});
export default router;
