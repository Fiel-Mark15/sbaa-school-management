<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { AlertCircle, ArrowRight, CheckCircle2 } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import { passwordValid } from '../../../shared/password-policy.js';
import PasswordRequirements from '../components/PasswordRequirements.vue';
import SchoolMark from '../components/SchoolMark.vue';

const form=ref({firstName:'',middleName:'',lastName:'',studentId:'',email:'',password:'',confirmPassword:''});
const error=ref(''),success=ref(''),submitting=ref(false),retrySeconds=ref(0),auth=useAuthStore();
let timer;
const retryLabel=computed(()=>{const m=Math.floor(retrySeconds.value/60),s=retrySeconds.value%60;return `${m}:${String(s).padStart(2,'0')}`;});
function startRetry(seconds){retrySeconds.value=Math.max(1,Math.ceil(Number(seconds)||60));clearInterval(timer);timer=setInterval(()=>{retrySeconds.value=Math.max(0,retrySeconds.value-1);if(!retrySeconds.value)clearInterval(timer);},1000);}
onBeforeUnmount(()=>clearInterval(timer));
async function submit(){
  if(submitting.value||retrySeconds.value)return;
  error.value='';
  if(!passwordValid(form.value.password)||form.value.password!==form.value.confirmPassword){error.value='Complete the password checklist before submitting.';return;}
  submitting.value=true;
  try{const {confirmPassword,...details}=form.value;success.value=await auth.register(details);form.value.password='';form.value.confirmPassword='';}
  catch(e){if(e.response?.status===429)startRetry(e.response.headers?.['retry-after']||e.response.data?.retryAfter);error.value=e.response?.data?.message||'The account service is unavailable. Please try again later.';}
  finally{submitting.value=false;}
}
</script>
<template><div class="login-page"><section class="login-brand"><div class="logo-watermark" aria-hidden="true"></div><SchoolMark/><div class="brand-copy"><p class="eyebrow">SBAA STUDENT ACCESS</p><h1>Begin your portal journey.</h1><p>Create a student account and sign in immediately. Academic records appear only after your school identity is verified and linked.</p></div></section><section class="login-form-wrap register-wrap"><form class="login-form" @submit.prevent="submit"><p class="eyebrow">CREATE ACCOUNT</p><h1>Student registration</h1><p class="subtle">Enter the details shown on your school records.</p><p v-if="error" class="form-error" role="alert"><AlertCircle :size="17"/>{{error}}</p><p v-if="retrySeconds" class="password-hint" role="status">You can try again in {{retryLabel}}. Your entries are saved here.</p><div v-if="success" class="success-message registration-success" role="status"><CheckCircle2 :size="22"/><div><strong>Account created</strong><p>{{success}}</p><RouterLink to="/login">Continue to sign in <ArrowRight :size="17"/></RouterLink></div></div><template v-else><div class="two-fields"><label>First name<input v-model="form.firstName" autocomplete="given-name" required maxlength="100"/></label><label>Middle name (optional)<input v-model="form.middleName" autocomplete="additional-name" maxlength="100"/></label></div><label>Last name<input v-model="form.lastName" autocomplete="family-name" required maxlength="100"/></label><label>Student ID<input v-model="form.studentId" name="school-student-number" autocomplete="off" inputmode="text" required maxlength="40" aria-describedby="student-number-help"/><small id="student-number-help" class="field-help">Enter the student number on your school ID. Leading zeros are kept.</small></label><label>School email<input v-model="form.email" type="email" name="school-email" autocomplete="email" required maxlength="190"/></label><PasswordRequirements v-model="form.password" v-model:confirm="form.confirmPassword" id-prefix="register"/><button class="primary" :disabled="submitting||retrySeconds>0">{{submitting?'Creating account…':retrySeconds?`Try again in ${retryLabel}`:'Create student account'}}<ArrowRight v-if="!submitting&&!retrySeconds" :size="18"/></button><p class="account-link">Already have an account? <RouterLink to="/login">Sign in</RouterLink></p></template></form><footer>© {{new Date().getFullYear()}} SBAA School Portal · School of Business Administration and Accountancy</footer></section></div></template>
