import { pool } from '../database/pool.js';

const minute=60_000;
const weekdayNumbers={Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6,Sunday:7};
function manilaParts(now){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit',weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).filter(item=>item.type!=='literal').map(item=>[item.type,item.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,weekday:weekdayNumbers[parts.weekday]};
}
function occurrenceStart(date,time){const [year,month,day]=date.split('-').map(Number),[hour,minutes]=time.split(':').map(Number);return new Date(Date.UTC(year,month-1,day,hour-8,minutes));}
let running=false;
export async function runClassReminders(now=new Date()){
  if(running)return 0;running=true;
  try{
    const {date,weekday}=manilaParts(now);
    const [meetings]=await pool.execute(`SELECT m.id,m.offering_id offeringId,TIME_FORMAT(m.start_time,'%H:%i') startTime,r.code roomCode,s.code subjectCode,s.name subjectName,f.user_id facultyUserId
      FROM schedule_meetings m JOIN subject_offerings o ON o.id=m.offering_id JOIN academic_terms t ON t.id=o.term_id
      JOIN subjects s ON s.id=o.subject_id JOIN rooms r ON r.id=m.room_id LEFT JOIN faculty f ON f.id=o.faculty_id
      WHERE m.status='ACTIVE' AND o.status='ACTIVE' AND m.weekday=? AND ? BETWEEN COALESCE(m.effective_start,t.start_date) AND COALESCE(m.effective_end,t.end_date)
      AND NOT EXISTS(SELECT 1 FROM schedule_exceptions x WHERE x.meeting_id=m.id AND x.occurrence_date=?)`,[weekday,date,date]);
    let sent=0;
    for(const meeting of meetings){
      const start=occurrenceStart(date,meeting.startTime),remaining=start.getTime()-now.getTime();
      if(remaining<=0||remaining>15*minute)continue;
      const [recipients]=await pool.execute(`SELECT DISTINCT u.id FROM users u JOIN students st ON st.user_id=u.id JOIN enrollments e ON e.student_id=st.id
        WHERE e.offering_id=? AND e.status='ENROLLED' AND u.status='ACTIVE'
        UNION SELECT u.id FROM users u WHERE u.id=? AND u.status='ACTIVE'`,[meeting.offeringId,meeting.facultyUserId||0]);
      const startsAt=start.toLocaleTimeString('en-US',{timeZone:'Asia/Manila',hour:'numeric',minute:'2-digit'});
      for(const recipient of recipients){
        const connection=await pool.getConnection();try{await connection.beginTransaction();
          const [[current]]=await connection.execute(`SELECT m.id FROM schedule_meetings m JOIN subject_offerings o ON o.id=m.offering_id JOIN academic_terms t ON t.id=o.term_id
            WHERE m.id=? AND m.status='ACTIVE' AND o.status='ACTIVE' AND ? BETWEEN COALESCE(m.effective_start,t.start_date) AND COALESCE(m.effective_end,t.end_date)
            AND NOT EXISTS(SELECT 1 FROM schedule_exceptions x WHERE x.meeting_id=m.id AND x.occurrence_date=?)
            AND (EXISTS(SELECT 1 FROM enrollments e JOIN students st ON st.id=e.student_id JOIN users u ON u.id=st.user_id WHERE e.offering_id=o.id AND e.status='ENROLLED' AND u.id=? AND u.status='ACTIVE')
              OR EXISTS(SELECT 1 FROM faculty f JOIN users u ON u.id=f.user_id WHERE f.id=o.faculty_id AND u.id=? AND u.status='ACTIVE')) FOR UPDATE`,[meeting.id,date,date,recipient.id,recipient.id]);
          if(!current){await connection.rollback();continue;}
          const [delivery]=await connection.execute('INSERT IGNORE INTO class_reminder_deliveries(meeting_id,occurrence_date,user_id) VALUES (?,?,?)',[meeting.id,date,recipient.id]);
          if(!delivery.affectedRows){await connection.rollback();continue;}
          const remainingMinutes=Math.ceil((start.getTime()-now.getTime())/minute);
          const [notice]=await connection.execute("INSERT INTO notifications(type,title,body,resource_type,resource_id) VALUES ('SCHEDULE','Class begins soon',?,'schedule',?)",[`${meeting.subjectCode} — ${meeting.subjectName} starts at ${startsAt} in Room ${meeting.roomCode}. Your class begins in ${remainingMinutes} minute${remainingMinutes===1?'':'s'}.`,meeting.id]);
          await connection.execute('INSERT INTO notification_recipients(notification_id,user_id) VALUES (?,?)',[notice.insertId,recipient.id]);
          await connection.execute('UPDATE class_reminder_deliveries SET notification_id=? WHERE meeting_id=? AND occurrence_date=? AND user_id=?',[notice.insertId,meeting.id,date,recipient.id]);
          await connection.commit();sent++;
        }catch(error){await connection.rollback();throw error;}finally{connection.release();}
      }
    }
    return sent;
  }finally{running=false;}
}
export function startClassReminderScheduler({keepAlive=false}={}){
  const tick=()=>runClassReminders().catch(error=>console.error('Class reminder scheduler failed:',error.code||'UNKNOWN'));
  tick();const timer=setInterval(tick,minute);if(!keepAlive)timer.unref?.();return ()=>clearInterval(timer);
}
