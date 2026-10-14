import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { assertEnvironment, env } from '../config/env.js';
import { handbookAbout } from './about-handbook.js';

assertEnvironment();
const connection = await mysql.createConnection({ ...env.db, multipleStatements: true });
try {
  const [columns] = await connection.query("SHOW COLUMNS FROM users LIKE 'status'");
  if (!columns[0]?.Type.includes('ARCHIVED')) {
    await connection.query("ALTER TABLE users MODIFY status ENUM('ACTIVE','DISABLED','PENDING','ARCHIVED') NOT NULL DEFAULT 'ACTIVE'");
  }
  const sql = await readFile(new URL('./migrations/001_portal_modules.sql', import.meta.url), 'utf8');
  await connection.query(sql);
  const ensureColumn=async(table,column,definition)=>{
    const [rows]=await connection.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`,[column]);
    if(!rows.length)await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  };
  await ensureColumn('auth_sessions','last_seen_at','DATETIME NULL');
  await ensureColumn('auth_sessions','user_agent','VARCHAR(180) NULL');
  await ensureColumn('users','middle_name','VARCHAR(100) NULL AFTER first_name');
  await ensureColumn('users','last_login_at','DATETIME NULL');
  await ensureColumn('notification_recipients','archived_at','DATETIME NULL');
  const [termDates]=await connection.query("SHOW COLUMNS FROM academic_terms LIKE 'start_date'");
  if(termDates[0]?.Null==='NO'){
    await connection.query('ALTER TABLE academic_terms MODIFY start_date DATE NULL, MODIFY end_date DATE NULL');
  }
  // The existing (academic_year, semester) unique key makes this repeatable.
  await connection.query("INSERT IGNORE INTO academic_terms (academic_year,semester,is_current,start_date,end_date) VALUES ('2026–2027','SECOND',FALSE,NULL,NULL)");
  await ensureColumn('profile_contacts','position','VARCHAR(100) NULL');
  const additions=await readFile(new URL('./migrations/002_repair.sql',import.meta.url),'utf8');
  await connection.query(additions);
  const profileAndGrades=await readFile(new URL('./migrations/003_profile_grades_mail.sql',import.meta.url),'utf8');
  await connection.query(profileAndGrades);
  const [mailPurpose]=await connection.query("SHOW COLUMNS FROM mail_delivery_events LIKE 'purpose'");
  if(!mailPurpose[0]?.Type.includes('CURRENT_EMAIL_VERIFICATION'))await connection.query("ALTER TABLE mail_delivery_events MODIFY purpose ENUM('RESET','EMAIL_CHANGE','EMAIL_CHANGED','INVITE','CURRENT_EMAIL_VERIFICATION') NOT NULL");
  const [mailOutcome]=await connection.query("SHOW COLUMNS FROM mail_delivery_events LIKE 'outcome'");
  if(!mailOutcome[0]?.Type.includes('PROVIDER_UNKNOWN'))await connection.query("ALTER TABLE mail_delivery_events MODIFY outcome ENUM('DEVELOPMENT_LOG','PROVIDER_ACCEPTED','PROVIDER_REJECTED','PROVIDER_UNKNOWN','UNCONFIGURED') NOT NULL");
  await connection.query(`CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    email VARCHAR(190) NOT NULL,
    token_digest CHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX idx_current_email_user (user_id,used_at,expires_at)
  )`);
  const [identityColumn]=await connection.query("SHOW COLUMNS FROM students LIKE 'identity_status'");
  if(!identityColumn.length){
    const selfRegistration=await readFile(new URL('./migrations/004_self_registration.sql',import.meta.url),'utf8');
    await connection.query(selfRegistration);
  }
  const [themeColumn]=await connection.query("SHOW COLUMNS FROM profile_contacts LIKE 'theme_preference'");
  if(!themeColumn.length){
    const themeSql=await readFile(new URL('./migrations/005_theme_preferences.sql',import.meta.url),'utf8');
    await connection.query(themeSql);
  }
  const appointmentsAndFirms=await readFile(new URL('./migrations/006_appointments_firms.sql',import.meta.url),'utf8');
  await connection.query(appointmentsAndFirms);
  await ensureColumn('appointments','meeting_details','VARCHAR(500) NULL');
  await ensureColumn('appointments','response_reason','VARCHAR(500) NULL');
  await ensureColumn('appointments','proposed_starts_at','DATETIME NULL');
  await ensureColumn('appointments','proposed_ends_at','DATETIME NULL');
  await ensureColumn('appointments','proposed_by','BIGINT UNSIGNED NULL');
  await ensureColumn('appointments','updated_at','TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  const [appointmentStatus]=await connection.query("SHOW COLUMNS FROM appointments LIKE 'status'");
  if(!appointmentStatus[0]?.Type.includes('NO_SHOW'))await connection.query("ALTER TABLE appointments MODIFY status ENUM('PENDING','APPROVED','REJECTED','RESCHEDULED','COMPLETED','CANCELLED','NO_SHOW') NOT NULL DEFAULT 'PENDING'");
  const [verifiedColumn]=await connection.query("SHOW COLUMNS FROM users LIKE 'email_verified_at'");
  if(!verifiedColumn.length){const verifiedSql=await readFile(new URL('./migrations/007_email_verified_state.sql',import.meta.url),'utf8');await connection.query(verifiedSql);}
  const aboutSql=await readFile(new URL('./migrations/008_about_sbaa.sql',import.meta.url),'utf8');await connection.query(aboutSql);
  for(const [column,definition] of [['goals','TEXT NOT NULL'],['objectives','TEXT NOT NULL'],['retention_policy','TEXT NOT NULL'],['source_attribution','TEXT NOT NULL']])await ensureColumn('about_sbaa',column,definition);
  await connection.query(`CREATE TABLE IF NOT EXISTS about_sbaa_revisions (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    about_id TINYINT UNSIGNED NOT NULL,
    revision_number INT UNSIGNED NOT NULL,
    content_snapshot JSON NOT NULL,
    status ENUM('DRAFT','PUBLISHED') NOT NULL,
    changed_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_about_revision (about_id,revision_number)
  )`);
  const [[aboutCurrent]]=await connection.query('SELECT * FROM about_sbaa WHERE id=1');
  if(aboutCurrent?.status==='DRAFT'&&Object.keys(handbookAbout).every(name=>!aboutCurrent[name.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`)])){
    const names=Object.keys(handbookAbout),columns=names.map(name=>name.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`));
    await connection.beginTransaction();
    try{
      await connection.execute(`UPDATE about_sbaa SET ${columns.map(name=>`\`${name}\`=?`).join(',')}, status='PUBLISHED' WHERE id=1 AND status='DRAFT'`,Object.values(handbookAbout));
      await connection.execute("INSERT INTO about_sbaa_revisions(about_id,revision_number,content_snapshot,status,changed_by) VALUES (1,1,?,'PUBLISHED',NULL)",[JSON.stringify({...handbookAbout,status:'PUBLISHED'})]);
      await connection.commit();
    }catch(error){await connection.rollback();throw error;}
  }
  await ensureColumn('announcements','audience_roles','JSON NULL');
  await ensureColumn('announcements','client_request_id','CHAR(36) NULL UNIQUE');
  await ensureColumn('announcements','recipient_user_ids','JSON NULL');
  const mediaSql=await readFile(new URL('./migrations/009_announcement_media.sql',import.meta.url),'utf8');await connection.query(mediaSql);
  const acquisitionSql=await readFile(new URL('./migrations/010_acquisitions.sql',import.meta.url),'utf8');await connection.query(acquisitionSql);
  const [studentUserColumn]=await connection.query("SHOW COLUMNS FROM students LIKE 'user_id'");
  if(studentUserColumn[0]?.Null==='NO')await connection.query('ALTER TABLE students MODIFY user_id BIGINT UNSIGNED NULL UNIQUE');
  await ensureColumn('students','manual_first_name','VARCHAR(100) NULL');
  await ensureColumn('students','manual_middle_name','VARCHAR(100) NULL');
  await ensureColumn('students','manual_last_name','VARCHAR(100) NULL');
  await ensureColumn('students','manual_email','VARCHAR(190) NULL UNIQUE');
  await ensureColumn('students','contact_number','VARCHAR(30) NULL');
  await ensureColumn('students','birth_date','DATE NULL');
  await ensureColumn('schedule_meetings','effective_start','DATE NULL');
  await ensureColumn('schedule_meetings','effective_end','DATE NULL');
  const reminderSql=await readFile(new URL('./migrations/011_class_reminders.sql',import.meta.url),'utf8');await connection.query(reminderSql);
  const gradesSql=await readFile(new URL('./migrations/012_grade_workflow.sql',import.meta.url),'utf8');await connection.query(gradesSql);
  await ensureColumn('grading_policy','passing_value','DECIMAL(6,2) NULL');
  await ensureColumn('grading_policy','pass_direction',"ENUM('AT_LEAST','AT_MOST') NULL");
  await ensureColumn('grading_policy','current_version_id','BIGINT UNSIGNED NULL');
  const [[currentPolicy]]=await connection.query('SELECT id,label,minimum,maximum,updated_by,current_version_id currentVersionId FROM grading_policy WHERE id=1');
  if(currentPolicy&&!currentPolicy.currentVersionId){
    const [version]=await connection.execute('INSERT INTO grading_policy_versions(label,minimum,maximum,created_by) VALUES (?,?,?,?)',[currentPolicy.label,currentPolicy.minimum,currentPolicy.maximum,currentPolicy.updated_by]);
    await connection.execute('UPDATE grading_policy SET current_version_id=? WHERE id=1',[version.insertId]);
  }
  const [gradeStatus]=await connection.query("SHOW COLUMNS FROM grade_records LIKE 'status'");
  if(!gradeStatus[0]?.Type.includes('SUBMITTED'))await connection.query("ALTER TABLE grade_records MODIFY status ENUM('DRAFT','SUBMITTED','PUBLISHED') NOT NULL DEFAULT 'DRAFT'");
  await ensureColumn('grade_records','policy_version_id','BIGINT UNSIGNED NULL');
  await ensureColumn('grade_records','version','INT UNSIGNED NOT NULL DEFAULT 1');
  await ensureColumn('grade_records','submitted_at','DATETIME NULL');
  await ensureColumn('grade_records','submitted_by','BIGINT UNSIGNED NULL');
  await ensureColumn('grade_records','approved_at','DATETIME NULL');
  await ensureColumn('grade_records','approved_by','BIGINT UNSIGNED NULL');
  await connection.query('UPDATE grade_records g JOIN grading_policy p ON p.id=1 SET g.policy_version_id=p.current_version_id WHERE g.policy_version_id IS NULL');
  await connection.beginTransaction();
  try{
    const [eligible]=await connection.query(`SELECT u.id FROM users u JOIN students st ON st.user_id=u.id
      WHERE u.role='STUDENT' AND u.status='PENDING' AND st.program_id IS NULL AND st.section_id IS NULL
      AND EXISTS (SELECT 1 FROM audit_logs a WHERE a.user_id=u.id AND a.action='ACCOUNT_REGISTERED')
      AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.user_id=u.id AND a.action IN ('ACCOUNT_APPROVED','ACCOUNT_DISABLED','ACCOUNT_ARCHIVED','ACCOUNT_REACTIVATED'))
      AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id=st.id)
      ORDER BY u.id FOR UPDATE`);
    console.log('Legacy self-registrations eligible for activation:',eligible.map(row=>row.id));
    for(const {id} of eligible){
      await connection.execute("UPDATE users SET status='ACTIVE' WHERE id=? AND role='STUDENT' AND status='PENDING'",[id]);
      await connection.execute("INSERT INTO audit_logs(user_id,action,entity_type,entity_id) VALUES (?,'SELF_REGISTRATION_ACTIVATED','users',?)",[id,id]);
    }
    await connection.commit();
  }catch(error){await connection.rollback();throw error;}
  console.log('Portal migrations applied. Existing data preserved.');
} finally { await connection.end(); }
