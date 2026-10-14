<script setup>
import { RouterLink } from 'vue-router';
</script>
<template><footer class="portal-footer"><p>© {{new Date().getFullYear()}} SBAA School Portal</p><p>School of Business Administration and Accountancy</p><nav aria-label="Legal information"><RouterLink to="/privacy">Privacy Notice</RouterLink><RouterLink to="/terms">Terms of Use</RouterLink></nav></footer></template>
