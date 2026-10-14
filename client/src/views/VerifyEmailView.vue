<script setup>
import { onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import api from '../services/api';
import SchoolMark from '../components/SchoolMark.vue';
import { useAuthStore } from '../stores/auth';
const route=useRoute(),auth=useAuthStore(),token=typeof route.query.token==='string'?route.query.token:'',email=ref(''),error=ref(''),success=ref(''),loading=ref(true),submitting=ref(false);
onMounted(async()=>{try{email.value=(await api.get('/auth/email-change/validate',{params:{token}})).data.data.pendingEmail;}catch(e){error.value=e.response?.data?.message||'This verification link is invalid or expired.';}finally{loading.value=false;}});
async function confirm(){if(submitting.value||!email.value)return;submitting.value=true;error.value='';try{success.value=(await api.post('/auth/email-change/confirm',{token})).data.message;auth.clearLocal();email.value='';window.history.replaceState(null,'','/verify-email');}catch(e){error.value=e.response?.data?.message||'Could not verify your new email.';}finally{submitting.value=false;}}
</script>
<template><div class="login-page"><section class="login-brand"><div class="logo-watermark" aria-hidden="true"></div><SchoolMark/><div class="brand-copy"><p class="eyebrow">ACCOUNT SECURITY</p><h1>Verify your new email.</h1><p>Your previous email stays active until verification finishes.</p></div></section><section class="login-form-wrap"><div class="login-form"><p class="eyebrow">EMAIL VERIFICATION</p><h1>Confirm your address</h1><p v-if="loading" class="subtle">Checking verification link…</p><p v-if="error" class="form-error" role="alert">{{error}}</p><p v-if="success" class="success-message" role="status">{{success}}</p><template v-else-if="email"><p class="subtle">New address: {{email}}</p><button class="primary" :disabled="submitting" @click="confirm">{{submitting?'Verifying…':'Verify email'}}</button></template><p class="account-link"><RouterLink to="/login">Sign in</RouterLink></p></div></section></div></template>
