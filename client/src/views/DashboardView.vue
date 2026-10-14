<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { BookOpen, CalendarClock, GraduationCap, Users, Megaphone, ArrowRight } from 'lucide-vue-next';
import api from '../services/api';
import PortalLayout from '../layouts/PortalLayout.vue';
import { useAuthStore } from '../stores/auth';
const auth=useAuthStore(),data=ref(null),context=ref(null),meetings=ref([]),error=ref('');
const clock=ref(Date.now()),serverOffset=ref(0);let clockTimer;
const schoolNow=computed(()=>new Date(clock.value+serverOffset.value));
const schoolHour=computed(()=>Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Manila',hour:'2-digit',hourCycle:'h23'}).format(schoolNow.value)));
const greeting=computed(()=>schoolHour.value>=5&&schoolHour.value<12?'Good morning':schoolHour.value>=12&&schoolHour.value<18?'Good afternoon':'Good evening');
const schoolDate=computed(()=>new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(schoolNow.value));
const icons={BookOpen,CalendarClock,GraduationCap,Users};
const action=auth.user?.role==='ADMIN'?{label:'Review accounts',to:'/admin/users'}:auth.user?.role==='FACULTY'?{label:'View assigned subjects',to:'/faculty/subjects'}:{label:'View my subjects',to:'/student/subjects'};
const weekdayNames=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
function nextMeeting(){
  const local=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(schoolNow.value);
  const day=weekdayNames.indexOf(local.find(p=>p.type==='weekday')?.value)+1;
  const time=`${local.find(p=>p.type==='hour')?.value}:${local.find(p=>p.type==='minute')?.value}`;
  return [...meetings.value].filter(m=>m.weekday>day||(m.weekday===day&&m.endTime>time)).sort((a,b)=>a.weekday-b.weekday||a.startTime.localeCompare(b.startTime))[0]
    || [...meetings.value].sort((a,b)=>a.weekday-b.weekday||a.startTime.localeCompare(b.startTime))[0];
}
async function syncClock(){try{const started=Date.now(),response=await api.get('/dashboard/summary');const received=Date.now();data.value=response.data.data;serverOffset.value=new Date(data.value.serverNow).getTime()-(started+received)/2;clock.value=received;}catch(e){error.value=e.response?.data?.message||'Dashboard information could not be loaded.';}}
function tick(){clock.value=Date.now();clockTimer=setTimeout(tick,60000-((clock.value+serverOffset.value)%60000)+30);}
function onFocus(){syncClock().then(()=>{clearTimeout(clockTimer);tick();});}
onMounted(async()=>{await syncClock();try{const requests=[api.get('/dashboard/context')];if(auth.user?.role!=='ADMIN')requests.push(api.get('/schedule/meetings'));const results=await Promise.all(requests);context.value=results[0].data.data;if(results[1])meetings.value=results[1].data.data;}catch(e){error.value=e.response?.data?.message||'Dashboard information could not be loaded.';}tick();window.addEventListener('focus',onFocus);});
onBeforeUnmount(()=>{clearTimeout(clockTimer);window.removeEventListener('focus',onFocus);});
</script>
<template>
  <PortalLayout title="Dashboard"><div class="dashboard">
    <section class="welcome compact-welcome"><div><p class="eyebrow">{{auth.user?.role}} · {{data?.term?`${data.term.academicYear} ${data.term.semester.toLowerCase()} semester`:'No current term'}}</p><h2>{{greeting}}, {{[auth.user?.firstName,auth.user?.middleName,auth.user?.lastName].filter(Boolean).join(' ')}}.</h2><p>{{schoolDate}} · Asia/Manila</p><RouterLink class="welcome-action" :to="action.to">{{action.label}} <ArrowRight :size="16"/></RouterLink></div><img src="/assets/sbaa-logo.png" alt="SBAA seal"/></section>
    <p v-if="error" class="form-error" role="alert">{{error}}</p><p v-else-if="!data" class="empty">Loading dashboard…</p>
    <p v-if="auth.user?.role==='STUDENT'&&data&&!data.academicRecordsLinked" class="panel" role="status">Your account is active. Academic records have not been linked yet; subjects, schedules, and grades will appear after school staff verify the records that belong to you.</p>
    <section v-if="data" class="metrics" aria-label="Current figures"><article v-for="metric in data.metrics" :key="metric.label" class="metric"><component :is="icons[metric.icon]" :size="22"/><div><span>{{metric.label}}</span><strong>{{metric.value}}</strong></div></article></section>
    <section class="dashboard-grid"><article class="panel"><div class="panel-title"><div><p class="eyebrow">LATEST</p><h2>Announcements</h2></div><Megaphone :size="21"/></div><div v-if="data?.announcements?.length" class="announcements"><div v-for="item in data.announcements" :key="item.id"><span class="priority" :class="item.priority.toLowerCase()">{{item.priority}}</span><h3>{{item.title}}</h3><p>{{new Date(item.published_at).toLocaleDateString('en-PH',{timeZone:'Asia/Manila'})}}</p></div></div><p v-else class="empty">No announcements available.</p></article>
    <article class="panel quick"><p class="eyebrow">ACADEMIC WORKSPACE</p><h2>{{auth.user?.role==='ADMIN'?'Class timetable':'Next class'}}</h2><p v-if="auth.user?.role==='ADMIN'">Manage rooms and class meetings for the academic term.</p><p v-else-if="nextMeeting()">{{nextMeeting().subjectCode}} · {{weekdayNames[nextMeeting().weekday-1]}} {{nextMeeting().startTime}}–{{nextMeeting().endTime}} · Room {{nextMeeting().room}}</p><p v-else>No classes are scheduled for your account.</p><RouterLink class="secondary-link" :to="`/${auth.user?.role.toLowerCase()}/schedule`">Open schedule <ArrowRight :size="16"/></RouterLink></article></section>
    <section v-if="context" class="dashboard-context"><article class="panel"><h2>Quick actions</h2><div class="dashboard-action-links"><RouterLink :to="`/${auth.user?.role.toLowerCase()}/subjects`">{{auth.user?.role==='ADMIN'?'Manage enrollment':'Open subjects'}}</RouterLink><RouterLink :to="`/${auth.user?.role.toLowerCase()}/appointments`">Appointments</RouterLink><RouterLink :to="`/${auth.user?.role.toLowerCase()}/notifications`">{{auth.user?.role==='ADMIN'?'Write announcement':'Notifications'}}</RouterLink><RouterLink v-if="auth.user?.role==='ADMIN'" to="/admin/grades">Grade reviews{{context.pendingGradeReviews?` (${context.pendingGradeReviews})`:''}}</RouterLink><RouterLink v-if="auth.user?.role==='ADMIN'" to="/admin/acquisitions">Review acquisitions{{context.pendingAcquisitions?` (${context.pendingAcquisitions})`:''}}</RouterLink></div><h3>Upcoming appointments</h3><ul v-if="context.appointments.length"><li v-for="item in context.appointments" :key="item.id">{{new Date(item.startsAt).toLocaleString('en-PH',{timeZone:'Asia/Manila'})}} · {{item.status}} · {{item.teacher}}<template v-if="item.student"> with {{item.student}}</template></li></ul><p v-else class="empty">No upcoming appointments for your account.</p></article><article class="panel"><h2>{{auth.user?.role==='ADMIN'?'Recent system activity':'Your recent activity'}}</h2><ul v-if="context.activity.length"><li v-for="(item,index) in context.activity" :key="index">{{item.action.replaceAll('_',' ').toLowerCase()}} · {{item.entityType}}<template v-if="auth.user?.role==='ADMIN'&&item.actor"> · {{item.actor}}</template><small>{{new Date(item.createdAt).toLocaleString('en-PH',{timeZone:'Asia/Manila'})}}</small></li></ul><p v-else class="empty">No recent activity recorded.</p></article></section>
  </div></PortalLayout>
</template>
