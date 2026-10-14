import { pool } from '../database/pool.js';
import { ok } from '../utils/response.js';

export async function summary(req,res,next) {
  try {
    const [[term]] = await pool.query('SELECT id,academic_year academicYear,semester FROM academic_terms WHERE is_current=TRUE ORDER BY start_date DESC LIMIT 1');
    const termId=term?.id||null;
    const [[unread]]=await pool.execute('SELECT COUNT(*) count FROM notification_recipients WHERE user_id=? AND read_at IS NULL',[req.user.sub]);
    const [announcements]=await pool.query("SELECT id,title,priority,published_at FROM announcements WHERE status='PUBLISHED' ORDER BY published_at DESC LIMIT 3");
    let metrics=[];
    if(req.user.role==='ADMIN'){
      const [[students]]=await pool.query("SELECT COUNT(*) count FROM users WHERE role='STUDENT' AND status='ACTIVE'");
      const [[faculty]]=await pool.query("SELECT COUNT(*) count FROM users WHERE role='FACULTY' AND status='ACTIVE'");
      const [[offerings]]=await pool.execute("SELECT COUNT(*) count FROM subject_offerings WHERE term_id=? AND status='ACTIVE'",[termId]);
      const [[unverified]]=await pool.query("SELECT COUNT(*) count FROM students st JOIN users u ON u.id=st.user_id WHERE u.status='ACTIVE' AND st.identity_status='UNVERIFIED'");
      metrics=[{label:'Active students',value:students.count,icon:'GraduationCap'},{label:'Faculty members',value:faculty.count,icon:'Users'},{label:'Current classes',value:offerings.count,icon:'BookOpen'},{label:'School identities unverified',value:unverified.count,icon:'CalendarClock'}];
    }else if(req.user.role==='FACULTY'){
      const [[offerings]]=await pool.execute("SELECT COUNT(*) count FROM subject_offerings o JOIN faculty f ON f.id=o.faculty_id WHERE f.user_id=? AND o.term_id=? AND o.status='ACTIVE'",[req.user.sub,termId]);
      const [[students]]=await pool.execute("SELECT COUNT(DISTINCT e.student_id) count FROM enrollments e JOIN subject_offerings o ON o.id=e.offering_id JOIN faculty f ON f.id=o.faculty_id WHERE f.user_id=? AND o.term_id=? AND e.status='ENROLLED'",[req.user.sub,termId]);
      metrics=[{label:'Assigned offerings',value:offerings.count,icon:'BookOpen'},{label:'Students in classes',value:students.count,icon:'Users'},{label:'Unread notifications',value:unread.count,icon:'CalendarClock'}];
    }else{
      const [[subjects]]=await pool.execute("SELECT COUNT(*) count,COALESCE(SUM(sub.units),0) units FROM enrollments e JOIN students st ON st.id=e.student_id JOIN subject_offerings o ON o.id=e.offering_id JOIN subjects sub ON sub.id=o.subject_id WHERE st.user_id=? AND o.term_id=? AND e.status='ENROLLED' AND o.status='ACTIVE'",[req.user.sub,termId]);
      metrics=[{label:'Enrolled subjects',value:subjects.count,icon:'BookOpen'},{label:'Current units',value:Number(subjects.units),icon:'GraduationCap'},{label:'Unread notifications',value:unread.count,icon:'CalendarClock'}];
    }
    let academicRecordsLinked=null;
    if(req.user.role==='STUDENT'){
      const [[linked]]=await pool.execute('SELECT EXISTS(SELECT 1 FROM enrollments e JOIN students st ON st.id=e.student_id WHERE st.user_id=?) linked',[req.user.sub]);
      academicRecordsLinked=Boolean(linked.linked);
    }
    return ok(res,{term:term||null,metrics,announcements,academicRecordsLinked,serverNow:new Date().toISOString()});
  }catch(error){next(error);}
}

export async function context(req,res,next){
  try{
    const admin=req.user.role==='ADMIN',faculty=req.user.role==='FACULTY';
    const activityParams=admin?[]:[req.user.sub];
    const [activity]=await pool.execute(`SELECT l.action,l.entity_type entityType,l.created_at createdAt,CONCAT_WS(' ',u.first_name,u.last_name) actor FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id ${admin?'':'WHERE l.user_id=?'} ORDER BY l.id DESC LIMIT 5`,activityParams);
    const appointmentScope=admin?'':faculty?'AND f.user_id=?':'AND st.user_id=?';
    const appointmentParams=admin?[]:[req.user.sub];
    const [appointments]=await pool.execute(`SELECT a.id,a.status,DATE_FORMAT(a.starts_at,'%Y-%m-%dT%H:%i:%sZ') startsAt,CONCAT_WS(' ',fu.first_name,fu.last_name) teacher,CONCAT_WS(' ',su.first_name,su.last_name) student FROM appointments a JOIN faculty f ON f.id=a.faculty_id JOIN users fu ON fu.id=f.user_id JOIN students st ON st.id=a.student_id LEFT JOIN users su ON su.id=st.user_id WHERE a.starts_at>UTC_TIMESTAMP() AND a.status IN ('PENDING','APPROVED') ${appointmentScope} ORDER BY a.starts_at LIMIT 3`,appointmentParams);
    let pendingAcquisitions=null,pendingGradeReviews=null;
    if(admin){const [[count]]=await pool.query("SELECT COUNT(*) total FROM acquisitions WHERE status='SUBMITTED'");pendingAcquisitions=count.total;const [[grades]]=await pool.query("SELECT COUNT(*) total FROM grade_records WHERE status='SUBMITTED'");pendingGradeReviews=grades.total;}
    return ok(res,{activity,appointments,pendingAcquisitions,pendingGradeReviews});
  }catch(error){next(error);}
}
