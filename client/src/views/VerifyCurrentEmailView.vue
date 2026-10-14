<script setup>
import { onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import api from '../services/api';
import SchoolMark from '../components/SchoolMark.vue';
import { useAuthStore } from '../stores/auth';
const route=useRoute(),auth=useAuthStore(),token=typeof route.query.token==='string'?route.query.token:'',email=ref(''),error=ref(''),success=ref(''),loading=ref(true),submitting=ref(false);
onMounted(async()=>{try{email.value=(await api.get('/auth/verify-current-email/validate',{params:{token}})).data.data.email;}catch(e){error.value=e.response?.data?.message||'This verification link is invalid, expired, or already used.';}finally{loading.value=false;}});
async function confirm(){if(submitting.value||!email.value)return;submitting.value=true;error.value='';try{success.value=(await api.post('/auth/verify-current-email/confirm',{token})).data.message;email.value='';window.history.replaceState(null,'','/verify-current-email');}catch(e){error.value=e.response?.data?.message||'Could not verify this email.';}finally{submitting.value=false;}}
</script>
<template><div class="login-page"><section class="login-brand"><div class="logo-watermark" aria-hidden="true"></div><SchoolMark/><div class="brand-copy"><p class="eyebrow">ACCOUNT SECURITY</p><h1>Verify your email.</h1><p>Confirm ownership of your current portal address.</p></div></section><section class="login-form-wrap"><div class="login-form"><p class="eyebrow">EMAIL VERIFICATION</p><h1>Confirm your address</h1><p v-if="loading" class="subtle">Checking verification link…</p><p v-if="error" class="form-error" role="alert">{{error}}</p><p v-if="success" class="success-message" role="status">{{success}}</p><template v-else-if="email"><p class="subtle">Address: {{email}}</p><button class="primary" :disabled="submitting" @click="confirm">{{submitting?'Verifying…':'Verify email'}}</button></template><p class="account-link"><RouterLink :to="auth.user?auth.dashboardPath.replace('/dashboard','/profile'):'/login'">{{auth.user?'Return to profile':'Sign in'}}</RouterLink></p></div></section></div></template>
