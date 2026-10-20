import { defineConfig } from 'vite';

// GitHub Pages のサブパス配信でも動くよう相対パスで出力する
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
