import { defineStore } from 'pinia'; import api, { cookieSession, setCsrfToken } from '../services/api';
export const useAuthStore = defineStore('auth', {
  state: () => ({ token: cookieSession ? null : localStorage.getItem('sbaa_token'), user: null, loading: false, restored: false }),
  getters: { isAuthenticated: (state) => Boolean(state.user || (!cookieSession && state.token)), dashboardPath: (state) => `/${state.user?.role?.toLowerCase() || 'student'}/dashboard` },
  actions: {
    async login(credentials) { this.loading = true; try { const { data } = await api.post('/auth/login', credentials); this.user = data.data.user; this.restored = true; if (cookieSession) { setCsrfToken(data.data.csrfToken); localStorage.removeItem('sbaa_token'); } else { this.token = data.data.token; localStorage.setItem('sbaa_token', this.token); } return this.dashboardPath; } finally { this.loading = false; } },
    async register(details) { this.loading = true; try { const { data } = await api.post('/auth/register', details, { timeout: 60000 }); return data.message; } finally { this.loading = false; } },
    async restore() { if (this.restored || (!cookieSession && !this.token)) return; this.restored = true; try { const { data } = await api.get('/auth/me'); this.user = data.data; if (cookieSession) { const csrf = await api.get('/auth/csrf'); setCsrfToken(csrf.data.data.csrfToken); } } catch { this.clearLocal(); } },
    clearLocal() { this.token = null; this.user = null; this.restored = true; setCsrfToken(null); localStorage.removeItem('sbaa_token'); },
    async logout() { try { if (this.isAuthenticated) await api.post('/auth/logout'); } finally { this.clearLocal(); } }
  }
});
