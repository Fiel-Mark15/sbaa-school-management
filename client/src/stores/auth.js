import { defineStore } from 'pinia'; import api, { connectToPortal, cookieSession, setCsrfToken } from '../services/api';
export const useAuthStore = defineStore('auth', {
  state: () => ({ token: cookieSession ? null : localStorage.getItem('sbaa_token'), user: null, loading: false, restoring: false, restored: false, restoreUnavailable: false }),
  getters: { isAuthenticated: (state) => Boolean(state.user || (!cookieSession && state.token)), dashboardPath: (state) => `/${state.user?.role?.toLowerCase() || 'student'}/dashboard` },
  actions: {
    async login(credentials) { this.loading = true; this.restoreUnavailable = false; try { await connectToPortal(); const { data } = await api.post('/auth/login', credentials, { timeout: 30000 }); this.user = data.data.user; this.restored = true; if (cookieSession) { setCsrfToken(data.data.csrfToken); localStorage.removeItem('sbaa_token'); } else { this.token = data.data.token; localStorage.setItem('sbaa_token', this.token); } return this.dashboardPath; } finally { this.loading = false; } },
    async register(details) { this.loading = true; try { const { data } = await api.post('/auth/register', details, { timeout: 60000 }); return data.message; } finally { this.loading = false; } },
    async restore() { if (this.restored || (!cookieSession && !this.token)) return; this.restored = true; this.restoring = true; try { const { data } = await api.get('/auth/me'); this.user = data.data; if (cookieSession) { const csrf = await api.get('/auth/csrf'); setCsrfToken(csrf.data.data.csrfToken); } } catch (error) { if (error.response?.status === 401) this.clearLocal(); else { this.user = null; setCsrfToken(null); this.restoreUnavailable = true; } } finally { this.restoring = false; } },
    clearLocal() { this.token = null; this.user = null; this.restored = true; this.restoreUnavailable = false; setCsrfToken(null); localStorage.removeItem('sbaa_token'); },
    async logout() { try { if (this.isAuthenticated) await api.post('/auth/logout'); } finally { this.clearLocal(); } }
  }
});
