import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(here, 'client'),
  plugins: [vue()],
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
  server: { port: 4311, proxy: { '/api': 'http://127.0.0.1:4310' }, fs: { allow: [here] } }
});
