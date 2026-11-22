import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Cloud, CloudError, validCloudUrl } from './cloud';
import { AccountSync, openConnection, parseRecord, sanitizeProfile, sealConnection } from './account';
import { defaultPrefs } from './prefs';
import { defaultShortcuts } from './shortcuts';
import { WrongPassphrase } from './vault';

beforeAll(() => { if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto }); });

class MemStore {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

/** A tiny stand-in for the account service: password sign-in, PKCE exchange, refresh and the profiles table. */
function fakeService() {
  const calls: Call[] = [];
  const users = new Map<string, { id: string; password: string }>();
  let row: { data: unknown; updated_at: string } | null = null;
  let validRefresh = 'r1';
  let n = 0;
  const sessionBody = (email: string) => ({
    access_token: `a${++n}`, refresh_token: (validRefresh = `r${n}`), expires_in: 3600, token_type: 'bearer',
    user: { id: 'u1', email, app_metadata: { providers: ['email'] }, user_metadata: { full_name: 'Ada' } },
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    const path = new URL(url).pathname + new URL(url).search;
    if (headers.apikey !== 'anon') return json(401, { message: 'no key' });
    if (path.startsWith('/auth/v1/signup')) { users.set(body.email, { id: 'u1', password: body.password }); return json(200, { id: 'u1', email: body.email }); }
    if (path.startsWith('/auth/v1/token?grant_type=password')) {
      const u = users.get(body.email);
      return u && u.password === body.password ? json(200, sessionBody(body.email)) : json(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    }
    if (path.startsWith('/auth/v1/token?grant_type=pkce')) return body.code_verifier && body.auth_code === 'good' ? json(200, sessionBody('g@example.com')) : json(400, { msg: 'bad code' });
    if (path.startsWith('/auth/v1/token?grant_type=refresh_token')) return body.refresh_token === validRefresh ? json(200, sessionBody('a@example.com')) : json(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
    if (path.startsWith('/auth/v1/recover')) return json(200, {});
    if (path.startsWith('/auth/v1/logout')) return new Response(null, { status: 204 });
    if (path.startsWith('/rest/v1/profiles')) {
      if (!headers.Authorization?.startsWith('Bearer a')) return json(401, { message: 'JWT expired' });
      if (init?.method === 'POST') { row = { data: body.data, updated_at: body.updated_at }; return new Response(null, { status: 201 }); }
      return json(200, row ? [row] : []);
    }
    return json(404, { message: 'not found' });
  }) as typeof fetch;
  return { calls, users, fetchFn, get row() { return row; }, set row(v) { row = v; } };
}

const make = (svc = fakeService(), store = new MemStore(), now = () => 1_000_000) =>
  ({ svc, store, cloud: new Cloud({ url: 'https://x.supabase.co/', anonKey: 'anon' }, 'https://app.example/', { fetch: svc.fetchFn, storage: store, now }) });

describe('Cloud', () => {
  it('only accepts https (or a local test server)', () => {
    expect(validCloudUrl('https://x.supabase.co')).toBe(true);
    expect(validCloudUrl('http://localhost:54321')).toBe(true);
    expect(validCloudUrl('http://evil.example')).toBe(false);
    expect(validCloudUrl('javascript:alert(1)')).toBe(false);
    expect(() => new Cloud({ url: 'http://evil.example', anonKey: 'k' }, 'https://a/')).toThrow();
  });

  it('signs up, signs in, keeps the session and signs out', async () => {
    const { cloud, store, svc } = make();
    expect(await cloud.signUp('a@example.com', 'correct horse')).toBe(true); // confirmation first
    expect(svc.calls[0].body).toMatchObject({ email: 'a@example.com', code_challenge_method: 's256' });
    expect(String((svc.calls[0].body as { code_challenge: string }).code_challenge).length).toBeGreaterThan(30);
    const s = await cloud.signIn('a@example.com', 'correct horse');
    expect(s.user).toMatchObject({ id: 'u1', email: 'a@example.com', providers: ['email'], name: 'Ada' });
    expect(store.getItem('prism.auth')).toContain('a1');
    expect(new Cloud({ url: 'https://x.supabase.co', anonKey: 'anon' }, 'https://a/', { fetch: svc.fetchFn, storage: store }).session?.accessToken).toBe('a1');
    await cloud.signOut();
    expect(cloud.session).toBeNull();
    expect(store.getItem('prism.auth')).toBeNull();
  });

  it('explains a wrong password in plain words', async () => {
    const { cloud } = make();
    await expect(cloud.signIn('nobody@example.com', 'x')).rejects.toThrow('Wrong email or password.');
  });

  it('builds the Google/GitHub address with a PKCE challenge, never the secret', async () => {
    const { cloud, store } = make();
    const url = new URL(await cloud.oauthUrl('github'));
    expect(url.origin + url.pathname).toBe('https://x.supabase.co/auth/v1/authorize');
    expect(url.searchParams.get('provider')).toBe('github');
    expect(url.searchParams.get('redirect_to')).toBe('https://app.example/');
    const challenge = url.searchParams.get('code_challenge')!;
    const verifier = JSON.parse(store.getItem('prism.auth.pkce')!).verifier as string;
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('finishes a sign-in from the returned address, and reports errors and foreign confirmations', async () => {
    const { cloud, store } = make();
    await cloud.oauthUrl('google');
    expect(await cloud.completeFromUrl(new URL('https://app.example/?code=good'))).toBe('signed-in');
    expect(cloud.session?.user.email).toBe('g@example.com');
    expect(store.getItem('prism.auth.pkce')).toBeNull(); // the secret is used once
    expect(await cloud.completeFromUrl(new URL('https://app.example/?code=good'))).toBe('confirmed-elsewhere'); // no matching start
    await expect(cloud.completeFromUrl(new URL('https://app.example/?error=access_denied&error_description=User+cancelled'))).rejects.toThrow('User cancelled');
    expect(await cloud.completeFromUrl(new URL('https://app.example/'))).toBeNull();
    await cloud.recover('a@example.com');
    expect(await cloud.completeFromUrl(new URL('https://app.example/?code=good'))).toBe('recovery');
  });

  it('refreshes an expiring token once, even for parallel calls, and signs out when refusing', async () => {
    let t = 1_000_000;
    const { cloud, svc } = make(undefined, undefined, () => t);
    svc.users.set('a@example.com', { id: 'u1', password: 'pw' });
    await cloud.signIn('a@example.com', 'pw');
    expect(await cloud.accessToken()).toBe('a1'); // still fresh
    t += 3_600_000 - 30_000; // inside the refresh margin
    const [x, y] = await Promise.all([cloud.accessToken(), cloud.accessToken()]);
    expect(x).toBe(y);
    expect(svc.calls.filter((c) => c.url.includes('grant_type=refresh_token'))).toHaveLength(1);
    t += 3_600_000;
    cloud.session = { ...cloud.session!, refreshToken: 'revoked' };
    await expect(cloud.accessToken()).rejects.toBeInstanceOf(CloudError);
    expect(cloud.session).toBeNull();
  });

  it('reads and writes the per-user record with the user token', async () => {
    const { cloud, svc } = make();
    svc.users.set('a@example.com', { id: 'u1', password: 'pw' });
    await cloud.signIn('a@example.com', 'pw');
    expect(await cloud.loadRecord()).toBeNull();
    await cloud.saveRecord({ hello: 1 }, '2026-01-01T00:00:00.000Z');
    expect(await cloud.loadRecord()).toEqual({ data: { hello: 1 }, updatedAt: '2026-01-01T00:00:00.000Z' });
    const post = svc.calls.find((c) => c.method === 'POST' && c.url.includes('/rest/v1/profiles'))!;
    expect(post.headers.Authorization).toBe('Bearer a1');
    expect(post.body).toMatchObject({ user_id: 'u1' });
  });
});

describe('account record', () => {
  it('rejects hostile or malformed data from the service', () => {
    const rec = parseRecord({
      profile: { name: 'Eve\u0000<script>'.padEnd(200, 'x'), avatar: 'javascript:alert(1)' },
      prefs: { accent: 'neon', fontSize: 9999, theme: 'dark', lineWrap: 'yes' },
      shortcuts: { save: 'Mod-w', compile: 'x', bold: 'Mod-Shift-b', italic: 'Mod-Shift-b', evil: 'Mod-q' },
      vault: { v: 1, salt: 1 },
    }, 'garbage');
    expect(rec.profile.avatar).toBe('');
    expect(rec.profile.name.length).toBeLessThanOrEqual(60);
    expect(rec.profile.name).not.toContain('\u0000');
    expect(rec.prefs).toMatchObject({ accent: 'indigo', fontSize: 28, theme: 'dark', lineWrap: true });
    expect(rec.shortcuts).toEqual({ bold: 'Mod-Shift-b' }); // reserved, invalid and duplicate keys are dropped
    expect(rec.vault).toBeUndefined();
    expect(rec.updatedAt).toBe(new Date(0).toISOString());
    expect(sanitizeProfile({ name: 'Ada', avatar: 'data:image/png;base64,AAAA' })).toEqual({ name: 'Ada', avatar: 'data:image/png;base64,AAAA' });
    expect(sanitizeProfile({ avatar: 'data:image/svg+xml;base64,AAAA' }).avatar).toBe('');
  });

  it('seals the GitHub connection with a passphrase', async () => {
    const c = { owner: 'me', repo: 'prism-data', branch: 'main', token: 'github_pat_secret', expires: '2027-01-31' };
    const sealed = await sealConnection('a long passphrase', c);
    expect(JSON.stringify(sealed)).not.toContain('github_pat_secret');
    expect(await openConnection('a long passphrase', sealed)).toEqual(c);
    await expect(openConnection('wrong passphrase', sealed)).rejects.toBeInstanceOf(WrongPassphrase);
    expect(JSON.stringify(await sealConnection('a long passphrase', c))).not.toBe(JSON.stringify(sealed)); // fresh salt and IV
  });
});

describe('AccountSync', () => {
  const setup = () => {
    const f = make();
    f.svc.users.set('a@example.com', { id: 'u1', password: 'pw' });
    const local = { profile: { name: 'Local', avatar: '' }, prefs: { ...defaultPrefs }, shortcuts: defaultShortcuts() };
    let applied: unknown = null;
    let clock = Date.parse('2026-06-01T00:00:00Z');
    const sync = new AccountSync(f.cloud, () => local, (r) => { applied = r; Object.assign(local, r); }, new MemStore(), () => new Date(clock));
    return { ...f, local, sync, applied: () => applied, tick: (ms: number) => { clock += ms; } };
  };

  it('uploads this browser when the account is empty', async () => {
    const t = setup();
    await t.cloud.signIn('a@example.com', 'pw');
    expect(await t.sync.sync()).toBe('pushed');
    expect((t.svc.row!.data as { profile: { name: string } }).profile.name).toBe('Local');
  });

  it('applies the account on a new browser, keeps the newer side later, and never drops the vault', async () => {
    const t = setup();
    await t.cloud.signIn('a@example.com', 'pw');
    const vault = await sealConnection('a long passphrase', { owner: 'o', repo: 'r', branch: 'main', token: 't' });
    t.svc.row = { data: { profile: { name: 'From account' }, prefs: { theme: 'dark', accent: 'teal' }, shortcuts: { save: 'Mod-Shift-s' }, vault }, updated_at: '2026-05-01T00:00:00.000Z' };
    expect(await t.sync.sync()).toBe('applied');
    expect(t.local.profile.name).toBe('From account');
    expect(t.local.prefs.accent).toBe('teal');
    expect(t.local.shortcuts.save).toBe('Mod-Shift-s');
    expect(await t.sync.sync()).toBe('same');
    // a local change goes up, and the sealed connection stays in the record
    t.tick(60_000);
    t.local.profile.name = 'Renamed';
    t.sync.touch();
    expect(await t.sync.sync()).toBe('pushed');
    const stored = t.svc.row!.data as { profile: { name: string }; vault: unknown };
    expect(stored.profile.name).toBe('Renamed');
    expect(stored.vault).toEqual(vault);
  });
});
