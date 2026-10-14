import assert from 'node:assert/strict';
import { pool } from '../database/pool.js';
import { runClassReminders } from '../services/class-reminders.js';

const date='2026-10-12',near=new Date('2026-10-12T04:45:00Z');
const created=[];
try{
  const [[offering]]=await pool.execute("SELECT o.id FROM subject_offerings o JOIN enrollments e ON e.offering_id=o.id AND e.status='ENROLLED' JOIN students st ON st.id=e.student_id JOIN users u ON u.id=st.user_id AND u.status='ACTIVE' WHERE o.status='ACTIVE' AND o.faculty_id IS NOT NULL LIMIT 1");assert.ok(offering);
  const [[room]]=await pool.execute("SELECT id FROM rooms WHERE status='ACTIVE' LIMIT 1");assert.ok(room);
  for(const time of ['13:00','14:00','15:00']){const [row]=await pool.execute("INSERT INTO schedule_meetings(offering_id,room_id,weekday,start_time,end_time,effective_start,effective_end) VALUES (?,?,1,?,?,?,?)",[offering.id,room.id,time,`${Number(time.slice(0,2))+1}:00`,date,date]);created.push(row.insertId);}
  await pool.execute('INSERT INTO schedule_exceptions(meeting_id,occurrence_date,reason,created_by) SELECT ?,?,?,id FROM users WHERE role=\'ADMIN\' ORDER BY id LIMIT 1',[created[1],date,'Controlled cancellation']);
  const first=await runClassReminders(near);assert.ok(first>=2);
  const [[sent]]=await pool.execute('SELECT COUNT(*) total FROM class_reminder_deliveries WHERE meeting_id=?',[created[0]]);assert.ok(sent.total>=2);
  assert.equal((await pool.execute('SELECT COUNT(*) total FROM class_reminder_deliveries WHERE meeting_id=?',[created[1]]))[0][0].total,0);
  const repeat=await runClassReminders(near);assert.equal(repeat,0);
  await runClassReminders(new Date('2026-10-12T05:45:00Z'));
  assert.equal((await pool.execute('SELECT COUNT(*) total FROM class_reminder_deliveries WHERE meeting_id=?',[created[1]]))[0][0].total,0);
  await runClassReminders(new Date('2026-10-12T05:01:00Z'));
  assert.equal((await pool.execute('SELECT COUNT(*) total FROM class_reminder_deliveries WHERE meeting_id=?',[created[0]]))[0][0].total,sent.total);
  await runClassReminders(new Date('2026-10-12T07:01:00Z'));
  assert.equal((await pool.execute('SELECT COUNT(*) total FROM class_reminder_deliveries WHERE meeting_id=?',[created[2]]))[0][0].total,0);
  console.log('Class reminder checks passed: Manila timing, student/faculty recipients, cancellation, duplicate prevention, and no stale notice.');
}finally{
  for(const meetingId of created){
    const [rows]=await pool.execute('SELECT notification_id FROM class_reminder_deliveries WHERE meeting_id=?',[meetingId]);
    for(const row of rows){if(row.notification_id){await pool.execute('DELETE FROM notification_recipients WHERE notification_id=?',[row.notification_id]);await pool.execute('DELETE FROM class_reminder_deliveries WHERE meeting_id=? AND notification_id=?',[meetingId,row.notification_id]);await pool.execute('DELETE FROM notifications WHERE id=?',[row.notification_id]);}}
    await pool.execute('DELETE FROM schedule_exceptions WHERE meeting_id=?',[meetingId]);
    await pool.execute('DELETE FROM schedule_meetings WHERE id=?',[meetingId]);
  }
  await pool.end();
}
