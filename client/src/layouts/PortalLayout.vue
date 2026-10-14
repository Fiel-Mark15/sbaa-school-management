<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { LayoutDashboard, BookOpen, CalendarDays, Bell, LogOut, Menu, X, UserRound, Users, GraduationCap, BriefcaseBusiness, CalendarCheck2, Info, PackagePlus, Archive } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import api from '../services/api';
import SchoolMark from '../components/SchoolMark.vue';
import { useServerTheme } from '../services/theme';
import PortalFooter from '../components/PortalFooter.vue';

const props=defineProps({ title: { type:String, default:'Dashboard' } });
const auth=useAuthStore(),route=useRoute(),router=useRouter();
const open=ref(false),menuButton=ref(null),drawer=ref(null),unread=ref(0),busy=ref(false);
const bellOpen=ref(false),bellButton=ref(null),bellPanel=ref(null),bellItems=ref([]),bellLoading=ref(false),bellError=ref('');
const avatarOpen=ref(false),avatarButton=ref(null),avatarPanel=ref(null),confirmLogout=ref(false),logoutDialog=ref(null),logoutError=ref('');
const avatarPhoto=ref('');
let logoutTrigger=null;
const base=computed(()=>`/${auth.user?.role?.toLowerCase()||'student'}`);
const dashboardLink=computed(()=>({label:'Dashboard',icon:LayoutDashboard,to:`${base.value}/dashboard`}));
const navigationGroups=computed(()=>[
  {label:'Academic & Services',links:[
    {label:'Subjects',icon:BookOpen,to:`${base.value}/subjects`},
    {label:'Grades',icon:GraduationCap,to:`${base.value}/grades`},
    {label:'Acquisitions',icon:PackagePlus,to:`${base.value}/acquisitions`},
    {label:'Schedules',icon:CalendarDays,to:`${base.value}/schedule`},
    {label:'Appointments',icon:CalendarCheck2,to:`${base.value}/appointments`},
    {label:'Firms',icon:BriefcaseBusiness,to:`${base.value}/firms`}
  ]},
  {label:'Administration & Preferences',links:[
    ...(auth.user?.role==='ADMIN'?[{label:'User Accounts',icon:Users,to:'/admin/users'}]:[]),
    {label:'Notifications',icon:Bell,to:`${base.value}/notifications`},
    {label:'Profile',icon:UserRound,to:`${base.value}/profile`}
  ]},
  {label:'Information & Records',links:[{label:'About SBAA',icon:Info,to:`${base.value}/about`},...(auth.user?.role==='ADMIN'?[{label:'Archive',icon:Archive,to:'/admin/archive'}]:[])]}
]);
let previousOverflow='',poll=null;
async function refreshUnread(){if(!auth.isAuthenticated||document.hidden)return;try{unread.value=(await api.get('/notifications/unread-count')).data.data.count;}catch{}}
async function refreshAvatar(){if(avatarPhoto.value)URL.revokeObjectURL(avatarPhoto.value);avatarPhoto.value='';if(!auth.isAuthenticated)return;try{const profile=(await api.get('/account/profile')).data.data;useServerTheme(profile.themePreference||'system');if(!profile?.photoVersion)return;const photo=await api.get('/account/photo',{responseType:'blob'});avatarPhoto.value=URL.createObjectURL(photo.data);}catch{}}
function closeDrawer(){open.value=false;nextTick(()=>menuButton.value?.focus());}
function closeBell(){bellOpen.value=false;nextTick(()=>bellButton.value?.focus());}
async function loadBell(){bellLoading.value=true;bellError.value='';try{bellItems.value=(await api.get('/notifications',{params:{page:1}})).data.data.rows.slice(0,5);}catch(e){bellError.value=e.response?.data?.message||'Could not load notifications.';}finally{bellLoading.value=false;}}
async function toggleBell(){if(bellOpen.value){closeBell();return;}avatarOpen.value=false;bellOpen.value=true;await loadBell();}
function syncNotifications(){refreshUnread();if(bellOpen.value)loadBell();}
function onOutside(event){if(bellOpen.value&&!bellPanel.value?.contains(event.target)&&!bellButton.value?.contains(event.target))bellOpen.value=false;if(avatarOpen.value&&!avatarPanel.value?.contains(event.target)&&!avatarButton.value?.contains(event.target))avatarOpen.value=false;}
async function openNotice(item){try{if(!item.readAt)await api.patch(`/notifications/${item.id}/read`);}catch(e){bellError.value=e.response?.data?.message||'Could not update this notification. Please try again.';return;}bellOpen.value=false;refreshUnread();const section={schedule:'schedule',subject:'subjects',profile:'profile',grades:'grades',acquisition:'acquisitions',announcement:'notifications'}[item.resourceType]||'notifications';router.push(`${base.value}/${section}`);}
async function bellMarkAll(){try{await api.patch('/notifications/read-all');await refreshUnread();bellItems.value=bellItems.value.map(item=>({...item,readAt:item.readAt||new Date().toISOString()}));window.dispatchEvent(new Event('sbaa:notifications'));}catch(e){bellError.value=e.response?.data?.message||'Could not mark notifications read.';}}
function requestLogout(event){logoutTrigger=event.currentTarget;avatarOpen.value=false;confirmLogout.value=true;logoutError.value='';nextTick(()=>logoutDialog.value?.querySelector('button')?.focus());}
function cancelLogout(){if(busy.value)return;confirmLogout.value=false;nextTick(()=>logoutTrigger?.focus());}
function onKey(event){
  if(confirmLogout.value){if(event.key==='Escape'){event.preventDefault();cancelLogout();return;}if(event.key==='Tab'){const buttons=[...logoutDialog.value?.querySelectorAll('button:not(:disabled)')||[]];if(!buttons.length)return;const first=buttons[0],last=buttons.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}return;}
  if(event.key==='Escape'&&avatarOpen.value){avatarOpen.value=false;avatarButton.value?.focus();return;}
  if(event.key==='Escape'&&bellOpen.value){closeBell();return;}if(event.key==='Escape'&&open.value)closeDrawer();if(event.key==='Tab'&&open.value){const items=drawer.value?.querySelectorAll('a,button');if(!items?.length)return;const first=items[0],last=items[items.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
}
watch(open,async(value)=>{if(value){previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';await nextTick();drawer.value?.querySelector('a')?.focus();}else{document.body.style.overflow=previousOverflow;}});
watch(()=>route.fullPath,()=>{open.value=false;bellOpen.value=false;avatarOpen.value=false;refreshUnread();});
document.addEventListener('keydown',onKey);document.addEventListener('pointerdown',onOutside);document.addEventListener('visibilitychange',syncNotifications);window.addEventListener('sbaa:notifications',syncNotifications);window.addEventListener('sbaa:profile',refreshAvatar);refreshUnread();refreshAvatar();poll=setInterval(()=>{if(!document.hidden)syncNotifications();},60000);
onBeforeUnmount(()=>{document.removeEventListener('keydown',onKey);document.removeEventListener('pointerdown',onOutside);document.removeEventListener('visibilitychange',syncNotifications);window.removeEventListener('sbaa:notifications',syncNotifications);window.removeEventListener('sbaa:profile',refreshAvatar);if(avatarPhoto.value)URL.revokeObjectURL(avatarPhoto.value);clearInterval(poll);document.body.style.overflow=previousOverflow;});
async function logout(){if(busy.value)return;busy.value=true;logoutError.value='';try{await auth.logout();confirmLogout.value=false;router.push('/login');}catch(e){logoutError.value=e.response?.data?.message||'Could not contact the server. You are still signed in; please try again.';}finally{busy.value=false;}}
</script>
<template>
  <div class="portal">
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <button v-if="open" class="drawer-backdrop" aria-label="Close navigation" @click="closeDrawer"></button>
    <aside ref="drawer" :class="{open}" aria-label="Main navigation">
      <SchoolMark />
      <nav aria-label="Portal sections">
        <RouterLink :to="dashboardLink.to" :aria-current="route.path===dashboardLink.to?'page':undefined" @click="open=false"><component :is="dashboardLink.icon" :size="19" />{{dashboardLink.label}}</RouterLink>
        <div v-for="group in navigationGroups" :key="group.label" class="nav-group"><p class="eyebrow">{{group.label}}</p><RouterLink v-for="link in group.links" :key="link.to" :to="link.to" :aria-current="route.path===link.to?'page':undefined" @click="open=false"><component :is="link.icon" :size="19" />{{link.label}}<span v-if="link.label==='Notifications'&&unread" class="nav-count">{{unread}}</span></RouterLink></div>
      </nav>
      <div class="account-nav"><p class="eyebrow">Account</p><button class="logout" :disabled="busy" @click="requestLogout"><LogOut :size="19" />Sign out</button></div>
    </aside>
    <div class="portal-body">
      <header class="portal-header"><button ref="menuButton" class="menu" :aria-expanded="open" aria-label="Open navigation" @click="open=!open"><X v-if="open"/><Menu v-else/></button><div><p class="eyebrow">SBAA SCHOOL PORTAL</p><h1>{{props.title}}</h1></div><div class="bell-anchor"><button ref="bellButton" class="header-bell" type="button" :aria-expanded="bellOpen" aria-controls="notification-panel" :aria-label="`${unread} unread notifications`" @click="toggleBell"><Bell :size="21"/><span v-if="unread">{{unread}}</span></button><section v-if="bellOpen" id="notification-panel" ref="bellPanel" class="bell-panel" aria-label="Recent notifications"><div class="bell-panel-head"><strong>Notifications <span v-if="unread">({{unread}})</span></strong><button class="text-button" type="button" @click="bellMarkAll">Mark all read</button></div><p v-if="bellLoading" class="empty">Loading…</p><p v-else-if="bellError" class="form-error" role="alert">{{bellError}}</p><p v-else-if="!bellItems.length" class="empty">You're all caught up.</p><div v-else class="bell-list"><button v-for="item in bellItems" :key="item.id" class="bell-item" :class="{unread:!item.readAt}" type="button" @click="openNotice(item)"><span class="bell-item-icon"><Bell :size="17"/></span><span><strong>{{item.title}}</strong><small>{{item.body}}</small><small>{{new Date(item.createdAt).toLocaleString('en-PH',{timeZone:'Asia/Manila'})}} (Asia/Manila)</small></span></button></div><RouterLink :to="`${base}/notifications`" class="bell-view-all" @click="bellOpen=false">View all notifications</RouterLink></section></div><div class="avatar-anchor"><button ref="avatarButton" class="user-dot" type="button" :aria-label="`Account menu for ${auth.user?.firstName}`" :aria-expanded="avatarOpen" @click="avatarOpen=!avatarOpen;bellOpen=false"><img v-if="avatarPhoto" :src="avatarPhoto" alt=""/><template v-else>{{auth.user?.firstName?.[0]}}{{auth.user?.lastName?.[0]}}</template></button><div v-if="avatarOpen" ref="avatarPanel" class="avatar-menu"><RouterLink :to="`${base}/profile`" @click="avatarOpen=false">Profile</RouterLink><button type="button" @click="requestLogout"><LogOut :size="17"/>Log out</button></div></div></header>
      <main id="main-content"><slot/></main>
      <PortalFooter />
    </div>
    <div v-if="confirmLogout" class="dialog-backdrop" @click.self="cancelLogout"><section ref="logoutDialog" class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="logout-heading" aria-describedby="logout-description"><h2 id="logout-heading">Sign out of School Portal?</h2><p id="logout-description">This session will end on this device.</p><p v-if="logoutError" class="form-error" role="alert">{{logoutError}}</p><div class="dialog-actions"><button class="secondary-button" :disabled="busy" @click="cancelLogout">Cancel</button><button class="primary" :disabled="busy" @click="logout">{{busy?'Signing out…':'Sign out'}}</button></div></section></div>
  </div>
</template>
