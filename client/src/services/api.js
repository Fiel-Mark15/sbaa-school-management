import axios from 'axios';
import { isTemporaryConnectionFailure, waitForPortal } from './portal-connection';
export const cookieSession = import.meta.env.PROD;
const api = axios.create({
  baseURL: cookieSession ? '/api' : (import.meta.env.VITE_API_URL || 'http://localhost:5050/api'),
  timeout: 10000,
  withCredentials: cookieSession,
});
// SMTP connection and recipient acceptance can exceed the ordinary API timeout.
export const mailRequestConfig = { timeout: 60000 };
let csrfToken = null;
export const setCsrfToken = (value) => { csrfToken = value || null; };
api.interceptors.request.use((config) => {
  if (cookieSession) {
    if (csrfToken && !['get', 'head', 'options'].includes((config.method || 'get').toLowerCase())) {
      config.headers['X-SBAA-CSRF'] = csrfToken;
    }
  } else {
    const token = localStorage.getItem('sbaa_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
api.interceptors.response.use((response)=>response,(error)=>{
  const config = error.config;
  if (config && (config.method || 'get').toLowerCase() === 'get' && config.url !== '/health'
    && !config.wakeRetried && !config.skipWakeRetry && isTemporaryConnectionFailure(error)) {
    config.wakeRetried = true;
    return waitForPortal(timeout => api.get('/health', { timeout, skipWakeRetry: true }))
      .then(() => api(config));
  }
  if(error.response?.status===401&&!['/health','/auth/login','/auth/me','/auth/csrf'].includes(error.config?.url)&&window.location.pathname!=='/login'){
    setCsrfToken(null);
    localStorage.removeItem('sbaa_token');
    window.location.assign('/login');
  }
  return Promise.reject(error);
});
export const connectToPortal = () => waitForPortal(timeout => api.get('/health', { timeout, skipWakeRetry: true }));
export default api;
