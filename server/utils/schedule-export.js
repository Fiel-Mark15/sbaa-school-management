import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from '../database/pool.js';

const weekdays=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const safeText=value=>String(value??'').replace(/^[=+\-@\t\r]/,"' $&").replace(/[\u0000-\u001f]/g,' ').trim();
const xml=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]));

export async function scheduleSelection(user,query){
  const termId=Number(query.termId),subjectId=query.subjectId?Number(query.subjectId):null;
  const sectionId=query.sectionId?Number(query.sectionId):null,facultyId=query.facultyId?Number(query.facultyId):null;
  if(!Number.isSafeInteger(termId)||termId<1||[subjectId,sectionId,facultyId].some(value=>value!==null&&(!Number.isSafeInteger(value)||value<1)))return null;
  if(user.role!=='ADMIN'&&(sectionId||facultyId))return null;
  const [[term]]=await pool.execute('SELECT id,academic_year academicYear,semester,DATE_FORMAT(start_date,\'%Y-%m-%d\') startDate,DATE_FORMAT(end_date,\'%Y-%m-%d\') endDate FROM academic_terms WHERE id=?',[termId]);
  if(!term)return {term:null,rows:[]};
  const params=[termId,subjectId,subjectId,sectionId,sectionId,facultyId,facultyId];
  let scope='';
  if(user.role==='FACULTY'){scope=' AND f.user_id=?';params.push(user.sub);}
  if(user.role==='STUDENT'){scope=" AND EXISTS (SELECT 1 FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.offering_id=o.id AND e.status='ENROLLED' AND st.user_id=?)";params.push(user.sub);}
  const [rows]=await pool.query(`SELECT m.id,m.weekday,TIME_FORMAT(m.start_time,'%H:%i:%s') startTime,TIME_FORMAT(m.end_time,'%H:%i:%s') endTime,
    sub.code subjectCode,sub.name subject,sub.id subjectId,sec.name section,sec.id sectionId,r.code room,
    f.id facultyId,CONCAT_WS(' ',u.first_name,u.last_name) faculty
    FROM schedule_meetings m JOIN subject_offerings o ON o.id=m.offering_id
    JOIN subjects sub ON sub.id=o.subject_id JOIN sections sec ON sec.id=o.section_id JOIN rooms r ON r.id=m.room_id
    LEFT JOIN faculty f ON f.id=o.faculty_id LEFT JOIN users u ON u.id=f.user_id
    WHERE m.status='ACTIVE' AND o.status='ACTIVE' AND o.term_id=? AND (? IS NULL OR sub.id=?)
      AND (? IS NULL OR sec.id=?) AND (? IS NULL OR f.id=?) ${scope}
    ORDER BY m.weekday,m.start_time,m.id LIMIT 500`,params);
  return {term,rows,filters:{subjectId,sectionId,facultyId}};
}

export function calendarSnapshot({term,rows}){
  const escape=value=>String(value??'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SBAA School Portal//Class Schedule Snapshot//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:SBAA class schedule snapshot','X-WR-TIMEZONE:Asia/Manila'];
  for(const row of rows){
    // Noon UTC preserves the calendar date when finding the local Manila weekday.
    const first=new Date(`${term.startDate}T12:00:00Z`),last=new Date(`${term.endDate}T12:00:00Z`);
    const firstDay=(first.getUTCDay()+6)%7+1;
    first.setUTCDate(first.getUTCDate()+(row.weekday-firstDay+7)%7);
    if(first>last)continue;
    const count=Math.floor((last-first)/604800000)+1;
    const localDate=first.toISOString().slice(0,10).replace(/-/g,'');
    lines.push('BEGIN:VEVENT',`UID:meeting-${row.id}-term-${term.id}@sbaa-school-portal`,`DTSTAMP:${stamp}`,`DTSTART;TZID=Asia/Manila:${localDate}T${row.startTime.replace(/:/g,'')}`,`DTEND;TZID=Asia/Manila:${localDate}T${row.endTime.replace(/:/g,'')}`,`RRULE:FREQ=WEEKLY;COUNT=${count}`,`SUMMARY:${escape(`${row.subjectCode} — ${row.subject}`)}`,`LOCATION:${escape(`Room ${row.room}`)}`,`DESCRIPTION:${escape(`Section ${row.section}. Exported snapshot; check the portal for changes.`)}`,'END:VEVENT');
  }
  return [...lines,'END:VCALENDAR'].join('\r\n')+'\r\n';
}

export async function excelSnapshot({term,rows}){
  const book=new ExcelJS.Workbook();book.creator='SBAA School Portal';book.subject='Class schedule snapshot';
  const sheet=book.addWorksheet('Meeting rows',{views:[{state:'frozen',ySplit:4}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0}});
  sheet.columns=[{width:18},{width:38},{width:22},{width:18},{width:25},{width:16},{width:14},{width:14},{width:16},{width:18}];
  sheet.mergeCells('A1:J1');sheet.getCell('A1').value='SBAA • Class schedule snapshot';sheet.getCell('A1').font={name:'Arial',size:15,bold:true,color:{argb:'FF0B644C'}};
  sheet.mergeCells('A2:J2');sheet.getCell('A2').value=`${safeText(term.academicYear)} ${safeText(term.semester)} semester · Asia/Manila · Generated ${new Date().toISOString().slice(0,10)}`;
  const headers=['Subject code','Subject title','Academic term','Section','Faculty','Weekday','Start time','End time','Room','Timezone'];sheet.getRow(4).values=headers;
  sheet.getRow(4).eachCell(cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF075E49'}};cell.font={name:'Arial',bold:true,color:{argb:'FFFFFFFF'}};cell.alignment={vertical:'middle',horizontal:'center'};});sheet.getRow(4).height=26;
  for(const item of rows){const values=[item.subjectCode,item.subject,`${term.academicYear} ${term.semester}`,item.section,item.faculty||'Unassigned',weekdays[item.weekday-1],item.startTime.slice(0,5),item.endTime.slice(0,5),item.room,'Asia/Manila'];const row=sheet.addRow(values.map(safeText));row.height=22;row.eachCell(cell=>{cell.font={name:'Arial',size:10};cell.alignment={vertical:'middle'};});}
  sheet.autoFilter={from:'A4',to:`J${Math.max(4,rows.length+4)}`};sheet.headerFooter.oddFooter='&CSBAA schedule snapshot · Check portal for changes';
  const timetable=book.addWorksheet('Weekly timetable',{views:[{state:'frozen',ySplit:4}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0}});
  timetable.columns=weekdays.map(()=>({width:34}));timetable.mergeCells('A1:G1');timetable.getCell('A1').value='SBAA • Weekly timetable snapshot';timetable.getCell('A1').font={name:'Arial',size:15,bold:true,color:{argb:'FF0B644C'}};
  timetable.mergeCells('A2:G2');timetable.getCell('A2').value=`${safeText(term.academicYear)} ${safeText(term.semester)} semester · Asia/Manila`;
  timetable.getRow(4).values=weekdays;timetable.getRow(4).eachCell(cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF075E49'}};cell.font={name:'Arial',bold:true,color:{argb:'FFFFFFFF'}};cell.alignment={horizontal:'center'};});
  const groups=weekdays.map((_,index)=>rows.filter(row=>row.weekday===index+1));
  for(let index=0;index<Math.max(1,...groups.map(group=>group.length));index++){
    const row=timetable.getRow(index+5);
    for(let day=0;day<7;day++){
      const item=groups[day][index],cell=row.getCell(day+1);
      cell.value=item?`${safeText(item.startTime.slice(0,5))}–${safeText(item.endTime.slice(0,5))}\n${safeText(item.subjectCode)} · ${safeText(item.subject)}\n${safeText(item.section)} · ${safeText(item.faculty||'Unassigned')}\nRoom ${safeText(item.room)}`:'—';
      cell.alignment={wrapText:true,vertical:'top'};
      cell.font={name:'Arial',size:10};
      cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:index%2?'FFF3F8F5':'FFFFFFFF'}};
      const estimatedLines=String(cell.value).split('\n').reduce((total,line)=>total+Math.max(1,Math.ceil(line.length/30)),0);
      row.height=Math.max(row.height||0,estimatedLines*15+14,75);
    }
  }
  return book.xlsx.writeBuffer();
}

function wrap(value,max=27){const words=String(value??'').split(/\s+/).flatMap(word=>word.match(new RegExp(`.{1,${max}}`,'g'))||[]),lines=[];let line='';for(const word of words){if((line+' '+word).trim().length>max&&line){lines.push(line);line=word;}else line=(line+' '+word).trim();}if(line)lines.push(line);return lines;}
export function imagePages(rows){return Math.max(1,...weekdays.map((_,index)=>Math.ceil(rows.filter(item=>item.weekday===index+1).length/2)));}
export async function imageSnapshot({term,rows,filters},page){
  const total=imagePages(rows),width=2450,groups=weekdays.map((_,index)=>rows.filter(item=>item.weekday===index+1).slice((page-1)*2,page*2));
  const cardHeight=Math.max(370,...groups.flat().map(item=>130+wrap(`${item.subjectCode} ${item.subject}`).length*30+wrap(`Section ${item.section} · ${item.faculty||'Unassigned'}`).length*28));
  const usedRows=Math.max(1,...groups.map(group=>group.length)),height=340+usedRows*(cardHeight+20)+80;
  const elements=[`<rect width="${width}" height="${height}" fill="#fff"/>`,`<rect x="0" y="0" width="${width}" height="220" fill="#edf7f1"/>`,`<text x="220" y="75" font-size="45" font-weight="bold" fill="#0b4938">SBAA School Portal</text>`,`<text x="220" y="132" font-size="32" fill="#285b4b">Class schedule snapshot · ${xml(term.academicYear)} ${xml(term.semester)} semester</text>`,`<text x="220" y="185" font-size="25" fill="#43695b">Asia/Manila · Page ${page} of ${total} · Subject ${xml(filters.subjectId?rows[0]?.subjectCode:'All')} · Section ${xml(filters.sectionId?rows[0]?.section:'All')} · Faculty ${xml(filters.facultyId?rows[0]?.faculty:'All')}</text>`];
  for(let day=0;day<7;day++){const x=35+day*345;elements.push(`<rect x="${x}" y="250" width="330" height="70" rx="12" fill="#075e49"/>`,`<text x="${x+18}" y="298" font-size="30" font-weight="bold" fill="#fff">${weekdays[day]}</text>`);groups[day].forEach((item,index)=>{const y=340+index*(cardHeight+20);elements.push(`<rect x="${x}" y="${y}" width="330" height="${cardHeight}" rx="15" fill="#f2f8f4" stroke="#bfd8c8"/>`,`<text x="${x+17}" y="${y+40}" font-size="25" font-weight="bold" fill="#075e49">${xml(item.startTime.slice(0,5))}–${xml(item.endTime.slice(0,5))}</text>`);let lineY=y+82;for(const line of wrap(`${item.subjectCode} ${item.subject}`)){elements.push(`<text x="${x+17}" y="${lineY}" font-size="24" font-weight="bold" fill="#16382d">${xml(line)}</text>`);lineY+=30;}for(const line of wrap(`Section ${item.section} · ${item.faculty||'Unassigned'}`)){elements.push(`<text x="${x+17}" y="${lineY+8}" font-size="21" fill="#345b4a">${xml(line)}</text>`);lineY+=28;}elements.push(`<text x="${x+17}" y="${y+cardHeight-30}" font-size="22" fill="#345b4a">Room ${xml(item.room)}</text>`);});if(!groups[day].length)elements.push(`<text x="${x+20}" y="375" font-size="24" fill="#60766b">No class</text>`);}
  elements.push(`<text x="35" y="${height-35}" font-size="20" fill="#43695b">One-time snapshot · Check the portal for schedule changes</text>`);
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="Arial, sans-serif">${elements.join('')}</g></svg>`);
  const logo=await readFile(fileURLToPath(new URL('../../client/public/assets/sbaa-logo.png',import.meta.url)));
  return sharp(svg).composite([{input:await sharp(logo).resize(150,150).png().toBuffer(),left:35,top:30}]).jpeg({quality:92}).toBuffer();
}
