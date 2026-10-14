const key=userId=>`sbaa.academicTerm.${userId}`;
export function savedAcademicTerm(userId){if(!userId)return '';try{return localStorage.getItem(key(userId))||'';}catch{return '';}}
export function saveAcademicTerm(userId,termId){if(!userId)return;try{if(termId)localStorage.setItem(key(userId),String(termId));else localStorage.removeItem(key(userId));}catch{}}
export const semesterLabel=value=>({FIRST:'First Semester',SECOND:'Second Semester',SUMMER:'Summer Term'})[value]||value;
export const academicTermLabel=term=>`AY ${term.academicYear} — ${semesterLabel(term.semester)}`;
