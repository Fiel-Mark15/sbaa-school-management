<script setup>
import { computed } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import PortalFooter from './components/PortalFooter.vue';
const route=useRoute();
const publicPage=computed(()=>['/login','/create-account','/forgot-password','/reset-password','/verify-email'].includes(route.path));
</script>
<template><div :class="{'public-app':publicPage}"><RouterView/><PortalFooter v-if="publicPage"/></div></template>
