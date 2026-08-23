import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' is required: the site is served from https://sysdevrun.github.io/<repo>/
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: {
    format: 'es',
  },
});
