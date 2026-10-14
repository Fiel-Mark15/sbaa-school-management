<script setup>
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import PortalLayout from '../layouts/PortalLayout.vue';
import api from '../services/api';
import { useAuthStore } from '../stores/auth';

const auth=useAuthStore(),admin=computed(()=>auth.user?.role==='ADMIN');
const base=computed(()=>`/${auth.user?.role?.toLowerCase()||'student'}`);
const fields=[['overview','Department overview'],['history','History summary'],['vision','Vision'],['mission','Mission'],['goals','Goals summary'],['objectives','Objectives summary'],['departmentValues','Core values'],['programs','Programs offered'],['retentionPolicy','BS Accountancy retention summary'],['sourceAttribution','Source attribution'],['services','Additional services'],['contact','Department contact']];
const blank=()=>Object.fromEntries(fields.map(([key])=>[key,'']));
const content=ref({...blank(),status:'UNAVAILABLE'}),loading=ref(true),saving=ref(false),editing=ref(false),confirmedSource=ref(false),error=ref(''),notice=ref(''),revisions=ref([]);
const lines=key=>String(content.value[key]||'').split('\n').map(line=>line.trim()).filter(Boolean);
const namedLines=key=>lines(key).map(line=>{const index=line.indexOf(':');return index<0?{title:'',body:line}:{title:line.slice(0,index),body:line.slice(index+1).trim()};});
async function load(){loading.value=true;try{content.value={...blank(),...(await api.get('/about')).data.data};if(admin.value)revisions.value=(await api.get('/about/revisions')).data.data;}catch(e){error.value=e.response?.data?.message||'Could not load department information.';}finally{loading.value=false;}}
async function save(status){if(saving.value)return;saving.value=true;error.value='';notice.value='';try{await api.put('/about',{...content.value,status,confirmedSource:confirmedSource.value});notice.value=status==='PUBLISHED'?'Handbook-attributed content published.':'Draft saved.';editing.value=false;confirmedSource.value=false;await load();}catch(e){error.value=e.response?.data?.message||'Could not save department content.';}finally{saving.value=false;}}
onMounted(load);
</script>

<template>
  <PortalLayout title="About SBAA"><div class="dashboard content-page about-page">
    <p v-if="error" class="form-error" role="alert">{{error}}</p><p v-if="notice" class="success-message" role="status">{{notice}}</p><p v-if="loading" class="empty">Loading department information…</p>
    <template v-else>
      <section class="about-hero"><div class="about-hero-copy"><p class="eyebrow">SCHOOL OF BUSINESS ADMINISTRATION AND ACCOUNTANCY</p><h2>Learning to lead with purpose.</h2><p>{{content.overview||'Department information is being prepared.'}}</p><span class="about-hero-year">Established in 2001</span></div><div class="about-hero-seal"><img src="/assets/sbaa-logo.png" alt="SBAA Student Council seal"/><small>Student Council seal</small></div></section>
      <p v-if="content.status!=='PUBLISHED'" class="legal-notice">This content is not published yet.</p>
      <template v-if="content.status==='PUBLISHED'||admin">
        <section class="about-history panel"><p class="eyebrow">OUR STORY · SUMMARY</p><h2>Rooted in Concepcion since 2001</h2><p>{{content.history}}</p></section>
        <div class="about-card-grid"><section v-for="key in ['vision','mission']" :key="key" class="panel about-statement"><p class="eyebrow">{{key.toUpperCase()}} · HANDBOOK WORDING</p><h2>{{key==='vision'?'Our vision':'Our mission'}}</h2><p>{{content[key]}}</p></section></div>
        <section class="about-section"><p class="eyebrow">I · C · I · P</p><h2>Core values</h2><div class="about-value-grid"><article v-for="item in namedLines('departmentValues')" :key="item.title" class="panel"><span class="about-initial">{{item.title[0]}}</span><h3>{{item.title}}</h3><p>{{item.body}}</p></article></div></section>
        <div class="about-card-grid"><section class="panel"><p class="eyebrow">DEVELOPMENT · SUMMARY</p><h2>Our goals</h2><ol class="about-list"><li v-for="item in namedLines('goals')" :key="item.body"><strong v-if="item.title">{{item.title}} · </strong>{{item.body}}</li></ol></section><section class="panel"><p class="eyebrow">LEARNING · SUMMARY</p><h2>Our objectives</h2><ol class="about-list"><li v-for="item in namedLines('objectives')" :key="item.body">{{item.body}}</li></ol></section></div>
        <section class="about-section"><p class="eyebrow">ACADEMIC PATHWAYS</p><h2>Programs offered</h2><div class="about-card-grid"><article v-for="program in lines('programs')" :key="program" class="panel about-program"><span aria-hidden="true">↗</span><h3>{{program}}</h3></article></div></section>
        <details v-if="content.retentionPolicy" class="panel about-policy"><summary>BS Accountancy retention policy · handbook summary</summary><p>{{content.retentionPolicy}}</p><p class="field-help">This overview does not automate transfer, retention, or grading decisions. Refer to the complete handbook for detailed conditions.</p></details>
        <section v-if="content.services||content.contact" class="panel"><h2>More information</h2><p v-if="content.services">{{content.services}}</p><p v-if="content.contact">{{content.contact}}</p></section>
        <p class="about-source">{{content.sourceAttribution}}</p>
      </template>
      <section class="panel about-services"><h2>Explore the portal</h2><div class="inline-actions"><RouterLink :to="`${base}/schedule`" class="secondary-button">Class schedule</RouterLink><RouterLink :to="`${base}/subjects`" class="secondary-button">Subjects</RouterLink><RouterLink :to="`${base}/appointments`" class="secondary-button">Appointments</RouterLink></div></section>
      <section v-if="admin" class="panel about-editor"><div class="panel-title"><h2>Manage published content</h2><button type="button" class="secondary-button" @click="editing=!editing">{{editing?'Close editor':'Edit content'}}</button></div><p class="field-help">Changes are saved as revisions. Only administrators can edit or publish; this content is attributed to the supplied handbook, not presented as newly approved by the institution.</p><form v-if="editing" class="stack-form" @submit.prevent="save('DRAFT')"><label v-for="([key,label]) in fields" :key="key">{{label}}<textarea v-model="content[key]" rows="4" maxlength="8000"/></label><label class="check-label"><input v-model="confirmedSource" type="checkbox"/><span>I checked the wording and source attribution against the supplied handbook material.</span></label><div class="inline-actions"><button class="primary" :disabled="saving">Save draft</button><button type="button" class="secondary-button" :disabled="saving||!confirmedSource" @click="save('PUBLISHED')">Publish content</button></div></form><p v-if="revisions.length" class="field-help">{{revisions.length}} recorded revision{{revisions.length===1?'':'s'}} · Latest revision {{revisions[0].revisionNumber}}</p></section>
    </template>
  </div></PortalLayout>
</template>
