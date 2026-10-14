import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';
import { passwordValid } from '../../shared/password-policy.js';

const scrypt=promisify(scryptCallback);
const N=32768,r=8,p=1,keyLength=64,maxmem=64*1024*1024;
export { passwordValid };
export async function hashPassword(password){
  if(!passwordValid(password))throw new Error('Password does not meet policy.');
  const salt=randomBytes(24);
  const key=await scrypt(password,salt,keyLength,{N,r,p,maxmem});
  return `$scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(password,stored){
  if(typeof password!=='string'||typeof stored!=='string')return false;
  if(stored.startsWith('$2'))return bcrypt.compare(password,stored);
  const parts=stored.split('$');
  if(parts.length!==7||parts[1]!=='scrypt')return false;
  const [, ,nValue,rValue,pValue,saltValue,keyValue]=parts;
  if(Number(nValue)!==N||Number(rValue)!==r||Number(pValue)!==p)return false;
  const saved=Buffer.from(keyValue,'base64url');
  if(saved.length!==keyLength)return false;
  const actual=await scrypt(password,Buffer.from(saltValue,'base64url'),keyLength,{N,r,p,maxmem});
  return timingSafeEqual(saved,actual);
}
