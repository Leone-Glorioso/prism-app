import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig({
  base: './', // works at https://<user>.github.io/<repo>/
  build: { target: 'es2022' }, // pdf.js uses ES2022 syntax
  define: { __APP_VERSION__: JSON.stringify(version) },
});
