import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const routes = [
  { path: '/', redirect: '/login' },
  { path: '/login', component: () => import('../views/LoginView.vue'), meta: { guest: true } },
  { path: '/create-account', component: () => import('../views/RegisterView.vue'), meta: { guest: true } },
  { path: '/forgot-password', component: () => import('../views/ForgotPasswordView.vue'), meta: { guest: true } },
  { path: '/reset-password', component: () => import('../views/ResetPasswordView.vue') },
  { path: '/verify-email', component: () => import('../views/VerifyEmailView.vue') },
  { path: '/verify-current-email', component: () => import('../views/VerifyCurrentEmailView.vue') },
  { path: '/privacy', component: () => import('../views/LegalView.vue'), props: { kind:'privacy' } },
  { path: '/terms', component: () => import('../views/LegalView.vue'), props: { kind:'terms' } },
  { path: '/:role(admin|faculty|student)/dashboard', component: () => import('../views/DashboardView.vue'), meta: { auth: true, title: 'Dashboard' } },
  { path: '/:role(admin|faculty|student)/subjects', component: () => import('../views/SubjectsView.vue'), meta: { auth: true, title: 'Subjects' } },
  { path: '/:role(admin|faculty|student)/grades', component: () => import('../views/GradesView.vue'), meta: { auth: true, title: 'Grades' } },
  { path: '/:role(admin|faculty|student)/acquisitions', component: () => import('../views/AcquisitionsView.vue'), meta: { auth: true, title: 'Acquisitions' } },
  { path: '/:role(admin|faculty|student)/schedule', component: () => import('../views/ScheduleView.vue'), meta: { auth: true, title: 'Schedule' } },
  { path: '/:role(admin|faculty|student)/appointments', component: () => import('../views/AppointmentsView.vue'), meta: { auth: true, title: 'Appointments' } },
  { path: '/:role(admin|faculty|student)/firms', component: () => import('../views/FirmsView.vue'), meta: { auth: true, title: 'Firms' } },
  { path: '/:role(admin|faculty|student)/notifications', component: () => import('../views/NotificationsView.vue'), meta: { auth: true, title: 'Notifications' } },
  { path: '/:role(admin|faculty|student)/profile', component: () => import('../views/ProfileView.vue'), meta: { auth: true, title: 'Profile' } },
  { path: '/:role(admin|faculty|student)/about', component: () => import('../views/AboutView.vue'), meta: { auth: true, title: 'About SBAA' } },
  { path: '/admin/users', component: () => import('../views/UsersView.vue'), meta: { auth: true, roles: ['ADMIN'], title: 'User accounts' } },
  { path: '/admin/archive', component: () => import('../views/ArchiveView.vue'), meta: { auth: true, roles: ['ADMIN'], title: 'Archive' } },
  { path: '/:pathMatch(.*)*', redirect: '/login' }
];
const router = createRouter({ history: createWebHistory(), routes, scrollBehavior(to, from, savedPosition) {
  if (savedPosition) return savedPosition;
  if (to.path !== from.path) return { top: 0, left: 0 };
  return undefined;
} });
router.beforeEach(async (to) => {
  const auth=useAuthStore();
  if(!auth.restored)await auth.restore();
  if(to.meta.auth&&!auth.user)return '/login';
  if(to.meta.guest&&auth.user)return auth.dashboardPath;
  if(to.meta.roles&&!to.meta.roles.includes(auth.user?.role))return auth.dashboardPath;
  if(to.meta.auth&&to.params.role&&to.params.role!==auth.user.role.toLowerCase())return auth.dashboardPath;
});
export default router;
