<script setup>
import { ref } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../services/api';
import { mailRequestConfig } from '../services/api';
import SchoolMark from '../components/SchoolMark.vue';
const email=ref(''),loading=ref(false),error=ref(''),success=ref('');
async function submit(){if(loading.value)return;loading.value=true;error.value='';success.value='';try{success.value=(await api.post('/auth/forgot-password',{email:email.value},mailRequestConfig)).data.message;}catch(e){error.value=e.response?.data?.message||'Password reset is unavailable right now. Please try again shortly.';}finally{loading.value=false;}}
</script>
<template><div class="login-page"><section class="login-brand"><div class="logo-watermark" aria-hidden="true"></div><SchoolMark/><div class="brand-copy"><p class="eyebrow">ACCOUNT RECOVERY</p><h1>Get back to your portal.</h1><p>Reset links expire after 30 minutes and can be used once.</p></div></section><section class="login-form-wrap"><form class="login-form" @submit.prevent="submit"><p class="eyebrow">PASSWORD RESET</p><h1>Forgot your password?</h1><p class="subtle">Enter the email address on your account.</p><p v-if="error" class="form-error" role="alert">{{error}}</p><p v-if="success" class="success-message" role="status">{{success}}</p><label>Email address<input v-model="email" type="email" autocomplete="email" required/></label><button class="primary" :disabled="loading">{{loading?'Sending…':'Send reset link'}}</button><p class="account-link"><RouterLink to="/login">Back to sign in</RouterLink></p></form></section></div></template>
