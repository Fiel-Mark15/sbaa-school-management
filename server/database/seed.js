import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { env } from '../config/env.js';
import { assertDatabaseWriteTarget, assertWriteConfiguration } from './write-guard.js';

if (process.env.NODE_ENV === 'production') throw new Error('Development seed is forbidden in production.');
if (!process.env.DEV_SEED_PASSWORD || process.env.DEV_SEED_PASSWORD.length < 12) throw new Error('Set a private DEV_SEED_PASSWORD of at least 12 characters before running the development seed.');
assertWriteConfiguration();
const connection = await mysql.createConnection({ ...env.db, multipleStatements: true });
try {
  await assertDatabaseWriteTarget(connection);
  const passwordHash = await bcrypt.hash(process.env.DEV_SEED_PASSWORD, 12);
  await connection.query(`INSERT INTO users (external_id,email,password_hash,role,first_name,last_name,status) VALUES
    ('ADMIN-001','admin@schoolportal.test',?,'ADMIN','Portal','Administrator','ACTIVE'),
    ('FAC-001','faculty@schoolportal.test',?,'FACULTY','Maria','Santos','ACTIVE'),
    ('2026-0001','student@schoolportal.test',?,'STUDENT','Juan','Dela Cruz','ACTIVE')
    ON DUPLICATE KEY UPDATE id=id`, [passwordHash, passwordHash, passwordHash]);
  await connection.query("INSERT IGNORE INTO programs (code,name) VALUES ('BSBA','Bachelor of Science in Business Administration')");
  await connection.query("INSERT IGNORE INTO sections (program_id,name,year_level) SELECT id,'A',1 FROM programs WHERE code='BSBA'");
  await connection.query("INSERT IGNORE INTO faculty (user_id,faculty_no,position) SELECT id,'FAC-001','Instructor' FROM users WHERE email='faculty@schoolportal.test'");
  await connection.query("INSERT IGNORE INTO students (user_id,student_no,program_id,section_id) SELECT u.id,'2026-0001',p.id,s.id FROM users u JOIN programs p ON p.code='BSBA' JOIN sections s ON s.program_id=p.id WHERE u.email='student@schoolportal.test'");
  await connection.query("INSERT IGNORE INTO subjects (code,name,units) VALUES ('ACC101','Fundamentals of Accounting',3),('MGT101','Principles of Management',3),('MKT101','Marketing Management',3)");
  await connection.query("INSERT IGNORE INTO academic_terms (academic_year,semester,is_current,start_date,end_date) VALUES ('2026–2027','FIRST',TRUE,'2026-08-01','2026-12-20')");
  await connection.query("INSERT IGNORE INTO announcements (id,author_id,title,content,priority,status,published_at) SELECT 1,id,'Welcome to the SBAA School Portal','Your central space for academic information, services, and updates.','HIGH','PUBLISHED',NOW() FROM users WHERE email='admin@schoolportal.test'");
  await connection.query("INSERT IGNORE INTO rooms (code,name,capacity) VALUES ('B101','Business Lecture Room 101',40),('B102','Business Lecture Room 102',40)");
  await connection.query(`INSERT IGNORE INTO subject_offerings (subject_id,term_id,section_id,faculty_id)
    SELECT sub.id,t.id,sec.id,f.id FROM subjects sub JOIN academic_terms t ON t.is_current=TRUE
    JOIN sections sec ON sec.name='A' JOIN faculty f ON f.faculty_no='FAC-001' WHERE sub.code IN ('ACC101','MGT101','MKT101')`);
  await connection.query(`INSERT IGNORE INTO enrollments (student_id,offering_id)
    SELECT st.id,o.id FROM students st JOIN subject_offerings o ON o.status='ACTIVE' WHERE st.student_no='2026-0001'`);
  const [[existingMeetings]] = await connection.query('SELECT COUNT(*) count FROM schedule_meetings');
  if (!existingMeetings.count) {
    await connection.query(`INSERT INTO schedule_meetings (offering_id,room_id,weekday,start_time,end_time)
      SELECT o.id,r.id,2,'09:00','10:30' FROM subject_offerings o JOIN subjects s ON s.id=o.subject_id JOIN rooms r ON r.code='B101' WHERE s.code='ACC101' LIMIT 1`);
    await connection.query(`INSERT INTO schedule_meetings (offering_id,room_id,weekday,start_time,end_time)
      SELECT o.id,r.id,3,'10:30','12:00' FROM subject_offerings o JOIN subjects s ON s.id=o.subject_id JOIN rooms r ON r.code='B102' WHERE s.code='MGT101' LIMIT 1`);
  }
  console.log('Development seed complete.');
} finally { await connection.end(); }
