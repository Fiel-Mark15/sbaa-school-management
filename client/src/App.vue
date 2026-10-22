<script setup>
import { computed } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import PortalFooter from './components/PortalFooter.vue';
import { connectingToPortal } from './services/portal-connection';
import { useAuthStore } from './stores/auth';
const route=useRoute();
const auth=useAuthStore();
const publicPage=computed(()=>['/login','/create-account','/forgot-password','/reset-password','/verify-email'].includes(route.path));
</script>
<template><div :class="{'public-app':publicPage}"><div v-if="connectingToPortal || auth.restoring" class="portal-connection-status" role="status" aria-live="polite">Connecting to school portal…</div><div v-else-if="auth.restoreUnavailable && route.path==='/login'" class="portal-connection-status" role="alert">The portal did not respond. Your session was not cleared; refresh the page shortly to try again.</div><RouterView/><PortalFooter v-if="publicPage"/></div></template>
