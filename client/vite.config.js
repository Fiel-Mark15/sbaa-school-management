import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ plugins: [vue()], publicDir: '../public', server: { port: 5173, strictPort: true } });
