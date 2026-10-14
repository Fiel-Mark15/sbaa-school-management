import { ref } from 'vue';
import api from './api';

const key='sbaa-theme';
const allowed=['light','dark','system'];
const initial=()=>{try{return localStorage.getItem(key)||'system';}catch{return 'system';}};
export const theme=ref(allowed.includes(initial())?initial():'system');
const query=window.matchMedia('(prefers-color-scheme: dark)');
function apply(){
  document.documentElement.dataset.theme=theme.value;
  document.documentElement.dataset.resolvedTheme=theme.value==='system'?(query.matches?'dark':'light'):theme.value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',document.documentElement.dataset.resolvedTheme==='dark'?'#142b23':'#087f5b');
}
query.addEventListener('change',()=>{if(theme.value==='system')apply();});
apply();
export function setTheme(value){
  if(!allowed.includes(value))return;
  theme.value=value;
  try{localStorage.setItem(key,value);}catch{}
  apply();
}
export function useServerTheme(value){if(allowed.includes(value))setTheme(value);}
export async function saveTheme(value){
  const previous=theme.value;
  setTheme(value);
  try{await api.patch('/account/theme',{theme:value});}
  catch(error){setTheme(previous);throw error;}
}
