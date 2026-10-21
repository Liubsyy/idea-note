import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], build: { target: 'es2022', chunkSizeWarningLimit: 2000 }, server: { proxy: { '/api': 'http://localhost:8787' } } });
