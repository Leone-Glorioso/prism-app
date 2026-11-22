import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // works at https://<user>.github.io/<repo>/
  build: { target: 'es2022' }, // pdf.js uses ES2022 syntax
});
