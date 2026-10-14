// This module is imported by both Express and Vue. Existing hashes remain valid.
export const PASSWORD_MIN_LENGTH=8;
export const PASSWORD_MAX_BYTES=1024;
const common=new Set(['password','password123','password123456','123456789012345','qwerty123456789','letmein123456789','admin1234567890','iloveyou1234567','sbaaschoolportal','portalpass2026!']);
export function passwordChecks(value=''){
  const text=typeof value==='string'?value:'';
  return {
    length:[...text].length>=PASSWORD_MIN_LENGTH,
    uppercase:/\p{Lu}/u.test(text),
    special:/[\p{P}\p{S}]/u.test(text),
    size:new TextEncoder().encode(text).length<=PASSWORD_MAX_BYTES,
    uncommon:!common.has(text.trim().toLocaleLowerCase()) && !/^(.)\1{7,}$/u.test(text),
  };
}
export function passwordValid(value){
  const checks=passwordChecks(value);
  return typeof value==='string'&&Object.values(checks).every(Boolean);
}
