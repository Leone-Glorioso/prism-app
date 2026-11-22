import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

// Optional accounts: cloud.config.json = { "url": "https://<project>.supabase.co", "anonKey": "<public key>" }.
// Without the file the app is built without accounts and its security policy allows only api.github.com.
// With it, the policy gets exactly that one extra address - nothing else changes.
const cloudFile = process.env.LEOTEX_CLOUD_CONFIG ?? fileURLToPath(new URL('./cloud.config.json', import.meta.url));
interface CloudConfig { url: string; anonKey: string }
function readCloudConfig(): CloudConfig | null {
  if (!existsSync(cloudFile)) return null;
  const raw = JSON.parse(readFileSync(cloudFile, 'utf8')) as Partial<CloudConfig>;
  const url = String(raw.url ?? '').replace(/\/+$/, '');
  const anonKey = String(raw.anonKey ?? '');
  const u = new URL(url); // throws on a malformed address
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('cloud.config.json: url must start with https://');
  if (u.pathname !== '/' || u.search || u.hash || u.username) throw new Error('cloud.config.json: url must be only the service address');
  if (!/^[A-Za-z0-9._-]{20,}$/.test(anonKey)) throw new Error('cloud.config.json: anonKey looks wrong (use the public "anon" or "publishable" key, never the service key)');
  const payload = anonKey.split('.')[1];
  if (payload && /service_role/i.test(Buffer.from(payload, 'base64').toString('utf8'))) {
    throw new Error('cloud.config.json: that is the secret service key. Use the public anon key.');
  }
  return { url: u.origin, anonKey };
}
const cloud = readCloudConfig();

const policy = (): Plugin => ({
  name: 'leotex-policy',
  transformIndexHtml: (html) => (cloud ? html.replace('connect-src https://api.github.com', `connect-src https://api.github.com ${cloud.url}`) : html),
});

export default defineConfig({
  base: './', // works at https://<user>.github.io/<repo>/
  build: { target: 'es2022' }, // pdf.js uses ES2022 syntax
  define: { __APP_VERSION__: JSON.stringify(version), __CLOUD_CONFIG__: JSON.stringify(cloud) },
  plugins: [policy()],
});
