<script setup>
import { ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { Eye, EyeOff, ArrowRight, AlertCircle } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import SchoolMark from '../components/SchoolMark.vue';

const identifier=ref(''),password=ref(''),visible=ref(false),error=ref(''),auth=useAuthStore(),router=useRouter();
async function submit(){if(auth.loading)return;error.value='';try{await router.push(await auth.login({identifier:identifier.value,password:password.value}));}catch(e){error.value=e.response?.data?.message||'Unable to connect to the portal. Check that the API is running.';}}
</script>
<template><div class="login-page"><section class="login-brand"><div class="logo-watermark" aria-hidden="true"></div><SchoolMark/><div class="brand-copy"><p class="eyebrow">CONCEPCION HOLY CROSS COLLEGE INC.</p><h1>Welcome to your academic home.</h1><p>One secure portal for the SBAA community—students, faculty, and administrators.</p></div></section><section class="login-form-wrap"><form class="login-form" @submit.prevent="submit"><p class="eyebrow">SECURE SIGN IN</p><h1>Sign in to School Portal</h1><p class="subtle">Use your school email or student ID to continue.</p><p v-if="error" class="form-error" role="alert"><AlertCircle :size="17"/>{{error}}</p><label>Email or student ID<input v-model="identifier" placeholder="name@school.edu.ph or student ID" autocomplete="username" required/></label><label>Password<span class="password-field"><input v-model="password" :type="visible?'text':'password'" autocomplete="current-password" required/><button type="button" :aria-label="visible?'Hide password':'Show password'" @click="visible=!visible"><EyeOff v-if="visible" :size="18"/><Eye v-else :size="18"/></button></span></label><div class="login-options"><RouterLink to="/forgot-password">Forgot password?</RouterLink></div><button class="primary" :disabled="auth.loading">{{auth.loading?'Signing in…':'Sign in'}}<ArrowRight v-if="!auth.loading" :size="18"/></button><p class="account-link">New student? <RouterLink to="/create-account">Create student account</RouterLink></p></form></section></div></template>
