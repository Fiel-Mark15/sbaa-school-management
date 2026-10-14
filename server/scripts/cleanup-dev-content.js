import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../database/pool.js';

if(process.env.NODE_ENV==='production'||process.env.MAIL_MODE!=='development')throw new Error('Development cleanup is unavailable outside local development mode.');
const knownTitles=['Tangina arte ninyo','Welcome to the SBAA School Portal'];
const [candidates]=await pool.query("SELECT id,title,content,status FROM announcements WHERE title IN (?,?) AND status<>'ARCHIVED' ORDER BY id",knownTitles);
console.log('Eligible development announcements:',candidates.map(({id,title,status})=>({id,title,status})));
const apply=process.argv.includes('--apply');
if(!apply){console.log('Preview only. Apply exact IDs with: npm run cleanup:dev -- --apply --ids=1,2');await pool.end();process.exit(0);}
const idsArg=process.argv.find(arg=>arg.startsWith('--ids='));
const ids=idsArg?.slice(6).split(',').map(Number)||[];
if(!ids.length||ids.some(value=>!Number.isSafeInteger(value)||value<1)||ids.some(value=>!candidates.some(row=>row.id===value)))throw new Error('Specify only exact eligible IDs shown in preview.');
const connection=await pool.getConnection();
try{
  await connection.beginTransaction();
  const placeholders=ids.map(()=>'?').join(',');
  const [announcements]=await connection.query(`SELECT * FROM announcements WHERE id IN (${placeholders}) FOR UPDATE`,ids);
  if(announcements.length!==ids.length||announcements.some(row=>!knownTitles.includes(row.title)))throw new Error('Eligible records changed; run preview again.');
  const [notifications]=await connection.query(`SELECT * FROM notifications WHERE resource_type='announcement' AND resource_id IN (${placeholders})`,ids);
  const noticeIds=notifications.map(row=>row.id);
  const [recipients]=noticeIds.length?await connection.query(`SELECT * FROM notification_recipients WHERE notification_id IN (${noticeIds.map(()=>'?').join(',')})`,noticeIds):[[]];
  const backupDir=fileURLToPath(new URL('../backups/dev-cleanup/',import.meta.url));
  await mkdir(backupDir,{recursive:true,mode:0o700});
  const backupPath=path.join(backupDir,`announcements-${Date.now()}.json`);
  await writeFile(backupPath,JSON.stringify({announcements,notifications,recipients},null,2),{flag:'wx',mode:0o600});
  await connection.query(`UPDATE announcements SET status='ARCHIVED' WHERE id IN (${placeholders})`,ids);
  if(noticeIds.length)await connection.query(`UPDATE notification_recipients SET archived_at=COALESCE(archived_at,UTC_TIMESTAMP()) WHERE notification_id IN (${noticeIds.map(()=>'?').join(',')})`,noticeIds);
  await connection.commit();
  console.log(`Archived ${announcements.length} exact development announcements and ${noticeIds.length} associated notifications. Backup: ${backupPath}`);
}catch(error){await connection.rollback();throw error;}finally{connection.release();await pool.end();}
