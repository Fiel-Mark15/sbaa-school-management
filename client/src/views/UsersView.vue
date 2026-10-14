<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import PortalLayout from '../layouts/PortalLayout.vue';
import api from '../services/api';
import { mailRequestConfig } from '../services/api';

const users=ref([]),details=ref(null),page=ref(1),total=ref(0),search=ref(''),status=ref(''),role=ref(''),emailVerification=ref('');
const loading=ref(true),detailsLoading=ref(false),saving=ref(false),error=ref(''),notice=ref('');
const now=ref(Date.now());let cooldownTimer;
const retrySeconds=user=>user?.verificationNextAllowedAt?Math.max(0,Math.ceil((new Date(user.verificationNextAllowedAt).getTime()-now.value)/1000)):0;
const testOnlyEmail=user=>user?.email?.toLowerCase().endsWith('.test');
let detailsRequest=0;
const avatarUrls=ref({});
let avatarLoad=0;
function clearAvatars(){for(const url of Object.values(avatarUrls.value))URL.revokeObjectURL(url);avatarUrls.value={};}
async function loadAvatars(rows,replace=true){
  const current=replace?++avatarLoad:avatarLoad;
  if(replace)clearAvatars();
  await Promise.all(rows.filter(row=>row.hasPhoto).map(async row=>{
    try{const response=await api.get(`/account/users/${row.id}/photo`,{responseType:'blob'});const url=URL.createObjectURL(response.data);
      if(current!==avatarLoad){URL.revokeObjectURL(url);return;}
      avatarUrls.value={...avatarUrls.value,[row.id]:url};
    }catch{ /* A missing or replaced photo falls back to initials. */ }
  }));
}
const deletion=ref(null),deletionReason=ref(''),deletionPassword=ref('');
const deleteDialog=ref(null);let deleteTrigger=null;
function closeDelete(){if(saving.value)return;deletion.value=null;deletionPassword.value='';nextTick(()=>deleteTrigger?.focus());}
function onDeleteKey(event){if(event.key==='Escape'){event.preventDefault();closeDelete();return;}if(event.key!=='Tab')return;const controls=[...deleteDialog.value?.querySelectorAll('input,button:not(:disabled)')||[]];if(!controls.length)return;const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
const staff=ref({firstName:'',lastName:'',email:'',externalId:'',role:'FACULTY',position:''});
async function load(){loading.value=true;error.value='';try{const {data}=await api.get('/account/users',{params:{page:page.value,search:search.value,status:status.value,role:role.value,emailVerification:emailVerification.value}});users.value=data.data.rows;total.value=data.data.total;loadAvatars(users.value);}catch(e){error.value=e.response?.data?.message||'Could not load accounts.';}finally{loading.value=false;}}
async function sendVerification(user){if(saving.value||retrySeconds(user)||testOnlyEmail(user))return;saving.value=true;error.value='';notice.value='';try{const response=(await api.post(`/account/users/${user.id}/email-verification`,{},mailRequestConfig)).data;notice.value=response.message;user.verificationNextAllowedAt=response.data.nextAllowedAt;user.verificationOutcome=response.data.outcome;await load();if(details.value?.id===user.id)await viewDetails(user);}catch(e){const response=e.response?.data;if(response?.nextAllowedAt)user.verificationNextAllowedAt=response.nextAllowedAt;if(e.response?.status===429)notice.value=response?.message||'Please wait before resending.';else error.value=response?.message||'Could not send the verification invitation.';}finally{saving.value=false;}}
async function viewDetails(user){
  const request=++detailsRequest;detailsLoading.value=true;error.value='';
  try{
    const selected=(await api.get(`/account/users/${user.id}`)).data.data;
    if(selected.status==='ACTIVE'&&!selected.emailVerifiedAt){const verification=(await api.get(`/account/users/${user.id}/email-verification`)).data.data;selected.verificationNextAllowedAt=verification.nextAllowedAt;selected.verificationOutcome=verification.deliveryOutcome;}
    if(request!==detailsRequest)return;
    details.value=selected;
    if(selected.hasPhoto&&!avatarUrls.value[selected.id])loadAvatars([selected],false);
    await nextTick();
    const section=document.querySelector('[aria-label="Account details"]');
    section?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
    const heading=section?.querySelector('h2');
    if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
  }catch(e){if(request===detailsRequest)error.value=e.response?.data?.message||'Could not load account.';}
  finally{if(request===detailsRequest)detailsLoading.value=false;}
}
async function changeStatus(user,next){
  const verb=next==='ACTIVE'?'reactivate':next==='ARCHIVED'?'archive':'disable';
  const reason=window.prompt(`${verb} ${user.firstName} ${user.lastName}?\nReason for the audit record:`);
  if(reason===null)return;if(!reason.trim()){error.value='An audit reason is required.';return;}
  saving.value=true;try{await api.patch(`/account/users/${user.id}/status`,{status:next,reason});notice.value='Account status updated.';details.value=null;await load();}catch(e){error.value=e.response?.data?.message||'Could not update account.';}finally{saving.value=false;}
}
async function reviewIdentity(user,verified){
  const reason=window.prompt(`${verified?'Mark identity verified':'Return identity to unverified'} for ${user.firstName} ${user.lastName}? Enter the school-record check or reason:`);
  if(reason===null)return;if(!reason.trim()){error.value='An audit reason is required.';return;}
  saving.value=true;try{await api.patch(`/account/users/${user.id}/identity`,{verified,reason});notice.value='Identity status updated. Academic records remain separate until linked against trusted school records.';await load();if(details.value?.id===user.id)await viewDetails(user);}catch(e){error.value=e.response?.data?.message||'Could not save identity review.';}finally{saving.value=false;}
}
function requestDelete(user){deleteTrigger=document.activeElement;deletion.value=user;deletionReason.value='';deletionPassword.value='';error.value='';nextTick(()=>deleteDialog.value?.querySelector('input')?.focus());}
async function deleteAccount(){if(saving.value||!deletion.value)return;saving.value=true;error.value='';const user=deletion.value;try{
  await api.delete(`/account/users/${user.id}`,{data:{reason:deletionReason.value.trim(),currentPassword:deletionPassword.value}});
  notice.value=`${user.email} was permanently deleted.`;deletion.value=null;deletionPassword.value='';details.value=null;
  await load();if(page.value>1&&!users.value.length){page.value--;await load();}
}catch(e){error.value=e.response?.data?.message||'Could not delete this account. Archive it instead.';if(e.response?.status===404){deletion.value=null;await load();}}finally{saving.value=false;}}
async function createStaff(){saving.value=true;error.value='';try{await api.post('/account/users',staff.value,mailRequestConfig);staff.value={firstName:'',lastName:'',email:'',externalId:'',role:'FACULTY',position:''};notice.value='Staff invitation sent.';await load();}catch(e){error.value=e.response?.data?.message||'Could not create staff account.';}finally{saving.value=false;}}
function refreshWhenVisible(){if(document.visibilityState==='visible'){now.value=Date.now();load();}}
onMounted(()=>{cooldownTimer=setInterval(()=>{now.value=Date.now();},1000);document.addEventListener('visibilitychange',refreshWhenVisible);load();});
onBeforeUnmount(()=>{clearInterval(cooldownTimer);document.removeEventListener('visibilitychange',refreshWhenVisible);avatarLoad++;clearAvatars();});
</script>
<template>
  <PortalLayout title="User accounts"><div class="dashboard content-page">
    <div class="page-heading"><div><p class="eyebrow">ADMINISTRATION</p><h2>User accounts</h2><p>Student accounts activate immediately. Verify identity separately before linking academic records.</p></div></div>
    <p v-if="error" class="form-error" role="alert">{{error}}</p><p v-if="notice" class="success-message" role="status">{{notice}}</p>
    <section class="panel"><form class="toolbar" @submit.prevent="page=1;load()"><label>Search<input v-model="search" placeholder="Name, email, or school ID"/></label><label>Role<select v-model="role"><option value="">All roles</option><option>ADMIN</option><option>FACULTY</option><option>STUDENT</option></select></label><label>Status<select v-model="status"><option value="">All statuses</option><option>ACTIVE</option><option>PENDING</option><option>DISABLED</option><option>ARCHIVED</option></select></label><label>Email verification<select v-model="emailVerification"><option value="">All emails</option><option value="verified">Verified</option><option value="unverified">Unverified</option></select></label><button class="secondary-button">Search</button></form>
      <p v-if="loading" class="empty">Loading accounts…</p><div v-else-if="users.length" class="record-list"><article v-for="user in users" :key="user.id" class="record-row account-card"><div><img v-if="avatarUrls[user.id]" class="account-avatar" :src="avatarUrls[user.id]" :alt="`${user.firstName} ${user.lastName} profile photo`"/><strong>{{user.firstName}} {{user.middleName||''}} {{user.lastName}}</strong><span>{{user.email}} · {{user.externalId||'No school ID'}}</span><small><span class="role-badge">{{user.role}}</span> <span class="status-badge">{{user.status}}</span> <span class="status-badge">Email {{user.emailVerifiedAt?'verified':'unverified'}}</span> <span v-if="user.role==='STUDENT'" class="status-badge">Identity {{user.identityStatus||'UNVERIFIED'}}</span> · Registered {{new Date(user.createdAt).toLocaleDateString('en-PH',{timeZone:'Asia/Manila'})}}</small><small v-if="testOnlyEmail(user)">Test-only address · cannot receive real email</small><small v-else-if="user.verificationOutcome==='PROVIDER_ACCEPTED'&&!user.emailVerifiedAt">Mail provider accepted a verification link; inbox receipt is unconfirmed.</small></div><div class="inline-actions"><button class="text-button" @click="viewDetails(user)">View details</button><button v-if="user.status==='ACTIVE'&&!user.emailVerifiedAt" class="secondary-button" :disabled="saving||retrySeconds(user)>0||testOnlyEmail(user)" @click="sendVerification(user)">{{testOnlyEmail(user)?'Test address':retrySeconds(user)?`Resend in ${retrySeconds(user)}s`:'Send verification'}}</button><button v-if="user.status==='ACTIVE'" class="text-button" :disabled="saving" @click="changeStatus(user,'DISABLED')">Disable</button><button v-if="['PENDING','DISABLED','ARCHIVED'].includes(user.status)" class="text-button" :disabled="saving" @click="changeStatus(user,'ACTIVE')">Reactivate</button><button v-if="user.status!=='ARCHIVED'" class="text-button" :disabled="saving" @click="changeStatus(user,'ARCHIVED')">Archive</button><button v-if="user.status==='ARCHIVED'" class="text-button destructive" :disabled="saving" @click="requestDelete(user)">Delete account</button></div></article></div><p v-else class="empty">No accounts found.</p><div class="pagination"><button :disabled="page===1" @click="page--;load()">Previous</button><span>Page {{page}} · {{total}} accounts</span><button :disabled="page*20>=total" @click="page++;load()">Next</button></div>
    </section>
    <p v-if="detailsLoading" role="status">Loading account details…</p>
    <section v-if="details" class="panel narrow-panel"><h2>Email ownership</h2><p>{{details.emailVerifiedAt?'Verified':'Not verified'}}<template v-if="details.emailVerifiedAt"> · {{new Date(details.emailVerifiedAt).toLocaleString('en-PH',{timeZone:'Asia/Manila'})}} (Asia/Manila)</template></p><p class="field-help">Email ownership is separate from student school-record identity.</p><p v-if="testOnlyEmail(details)" class="field-help">This is a non-deliverable test address.</p><button v-if="details.status==='ACTIVE'&&!details.emailVerifiedAt" type="button" class="secondary-button" :disabled="saving||retrySeconds(details)>0||testOnlyEmail(details)" @click="sendVerification(details)">{{testOnlyEmail(details)?'Test address':retrySeconds(details)?`Resend in ${retrySeconds(details)}s`:'Send verification invitation'}}</button></section>
    <section v-if="details" class="panel narrow-panel" aria-label="Account details"><div class="panel-title"><div class="account-detail-heading"><img v-if="avatarUrls[details.id]" class="account-avatar" :src="avatarUrls[details.id]" :alt="`${details.firstName} ${details.lastName} profile photo`"/><h2>{{details.firstName}} {{details.middleName||''}} {{details.lastName}}</h2></div><button class="text-button" @click="details=null">Close</button></div><dl class="detail-list"><div><dt>Status</dt><dd>{{details.status}}</dd></div><div><dt>Role</dt><dd>{{details.role}}</dd></div><div><dt>Registered</dt><dd>{{new Date(details.createdAt).toLocaleString('en-PH',{timeZone:'Asia/Manila'})}} (Asia/Manila)</dd></div><div><dt>School email</dt><dd>{{details.email}}</dd></div><div><dt>School ID</dt><dd>{{details.externalId||'—'}}</dd></div><div v-if="details.role==='STUDENT'"><dt>Identity</dt><dd>{{details.identityStatus||'UNVERIFIED'}}</dd></div><div v-if="details.program"><dt>Program</dt><dd>{{details.program}}</dd></div><div v-if="details.section"><dt>Section</dt><dd>{{details.section}}</dd></div><div v-if="details.yearLevel"><dt>Year</dt><dd>{{details.yearLevel}}</dd></div><div v-if="details.position"><dt>Position</dt><dd>{{details.position}}</dd></div></dl><div v-if="details.role==='STUDENT'" class="inline-actions"><button class="secondary-button" :disabled="saving||details.identityStatus==='VERIFIED'" @click="reviewIdentity(details,true)">Mark identity verified</button><button class="secondary-button" :disabled="saving||details.identityStatus!=='VERIFIED'" @click="reviewIdentity(details,false)">Revoke verification</button></div><p class="field-help">This review never assigns enrollments or grades by itself.</p></section>
    <section class="panel narrow-panel"><h2>Create staff account</h2><p>An invitation link lets the new faculty member or administrator set a password.</p><form class="stack-form" @submit.prevent="createStaff"><div class="two-fields"><label>First name<input v-model="staff.firstName" required maxlength="100"/></label><label>Last name<input v-model="staff.lastName" required maxlength="100"/></label></div><label>School email<input v-model="staff.email" type="email" required maxlength="190"/></label><label>Staff ID<input v-model="staff.externalId" required maxlength="40"/></label><label>Role<select v-model="staff.role"><option value="FACULTY">Faculty</option><option value="ADMIN">Administrator</option></select></label><label v-if="staff.role==='FACULTY'">Position<input v-model="staff.position" maxlength="100"/></label><button class="primary" :disabled="saving">{{saving?'Creating…':'Create and send invitation'}}</button></form></section>
    <div v-if="deletion" class="dialog-backdrop" @click.self="closeDelete"><section ref="deleteDialog" class="confirm-dialog" @keydown="onDeleteKey" role="dialog" aria-modal="true" aria-labelledby="delete-account-title"><h2 id="delete-account-title">Permanently delete account?</h2><p><strong>{{deletion.firstName}} {{deletion.lastName}}</strong> ({{deletion.email}}) will lose portal access. This cannot be undone. Accounts with protected academic records cannot be deleted; keep those archived.</p><form class="stack-form" @submit.prevent="deleteAccount"><label>Reason for deletion<input v-model="deletionReason" required maxlength="500" autocomplete="off"/></label><label>Your current password<input v-model="deletionPassword" type="password" required autocomplete="current-password"/></label><div class="dialog-actions"><button type="button" class="secondary-button" :disabled="saving" @click="closeDelete">Cancel</button><button class="primary destructive" :disabled="saving||!deletionReason.trim()||!deletionPassword">{{saving?'Deleting…':'Delete permanently'}}</button></div></form></section></div>
  </div></PortalLayout>
</template>
