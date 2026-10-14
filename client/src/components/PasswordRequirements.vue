<script setup>
import { computed, ref } from 'vue';
import { Check, Eye, EyeOff, Circle } from 'lucide-vue-next';
import { passwordChecks, PASSWORD_MIN_LENGTH } from '../../../shared/password-policy.js';
const props=defineProps({modelValue:{type:String,default:''},confirm:{type:String,default:''},idPrefix:{type:String,required:true},label:{type:String,default:'New password'},confirmLabel:{type:String,default:'Confirm password'}});
const emit=defineEmits(['update:modelValue','update:confirm']);
const visible=ref(false);
const checks=computed(()=>passwordChecks(props.modelValue));
const rules=computed(()=>[
  {label:`At least ${PASSWORD_MIN_LENGTH} characters`,valid:checks.value.length},
  {label:'One uppercase letter',valid:checks.value.uppercase},
  {label:'One special character',valid:checks.value.special},
  {label:'Not a common password',valid:checks.value.uncommon},
]);
</script>
<template>
  <div class="password-checklist">
    <label :for="`${idPrefix}-password`">{{label}}</label>
    <div class="password-field"><input :id="`${idPrefix}-password`" :value="modelValue" :type="visible?'text':'password'" autocomplete="new-password" required :minlength="PASSWORD_MIN_LENGTH" @input="emit('update:modelValue',$event.target.value)"/><button type="button" :aria-label="visible?'Hide password':'Show password'" :aria-pressed="visible" @click="visible=!visible"><EyeOff v-if="visible" :size="18"/><Eye v-else :size="18"/></button></div>
    <ul class="password-rules" aria-label="Password requirements"><li v-for="rule in rules" :key="rule.label" :class="{valid:rule.valid&&modelValue}"><Check v-if="rule.valid&&modelValue" :size="16" aria-hidden="true"/><Circle v-else :size="14" aria-hidden="true"/>{{rule.label}}</li></ul>
    <label :for="`${idPrefix}-confirm`">{{confirmLabel}}</label>
    <input :id="`${idPrefix}-confirm`" :value="confirm" :type="visible?'text':'password'" autocomplete="new-password" required @input="emit('update:confirm',$event.target.value)"/>
    <p class="password-match" :class="{valid:confirm&&modelValue===confirm}" role="status"><Check v-if="confirm&&modelValue===confirm" :size="16" aria-hidden="true"/><Circle v-else :size="14" aria-hidden="true"/>{{confirm&&modelValue===confirm?'Passwords match':'Passwords must match'}}</p>
    <p class="password-hint">Longer passwords are welcome. You can paste from a password manager.</p>
  </div>
</template>
