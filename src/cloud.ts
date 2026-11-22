// Optional account service (Supabase): sign up and sign in with email and password, Google or GitHub, and a small
// per-user record (profile, preferences, shortcuts and the sealed GitHub connection).
// Plain fetch calls only - no third-party script runs in this page. OAuth uses the PKCE redirect flow:
// the providers' secrets stay at the account service, the browser only ever holds short-lived tokens.

export interface CloudConfig { url: string; anonKey: string }

export interface CloudUser {
  id: string;
  email?: string;
  providers: string[];
  name?: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms since epoch
  user: CloudUser;
}

export class CloudError extends Error {
  constructor(message: string, public status = 0, public code = '') {
    super(message);
    this.name = 'CloudError';
  }
}

export type Provider = 'google' | 'github';
export type CallbackKind = 'signed-in' | 'recovery' | 'confirmed-elsewhere';

interface Deps {
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now?: () => number;
  random?: (n: number) => Uint8Array;
}

const SESSION_KEY = 'prism.auth';
const PKCE_KEY = 'prism.auth.pkce';
const REFRESH_MARGIN_MS = 60_000;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Accepts https addresses and plain http only for a local test server. */
export function validCloudUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

const FRIENDLY: Record<string, string> = {
  invalid_credentials: 'Wrong email or password.',
  email_not_confirmed: 'Confirm your email address first: open the link in the message we sent you.',
  user_already_exists: 'An account with this email already exists. Sign in instead.',
  weak_password: 'This password is too weak. Use at least 8 characters.',
  over_request_rate_limit: 'Too many attempts. Wait a few minutes and try again.',
  over_email_send_rate_limit: 'Too many emails were requested. Wait a few minutes and try again.',
  signup_disabled: 'New sign-ups are switched off for this service.',
  same_password: 'The new password must be different from the old one.',
};

function userOf(raw: Record<string, unknown>): CloudUser {
  const app = (raw.app_metadata ?? {}) as { providers?: string[]; provider?: string };
  const meta = (raw.user_metadata ?? {}) as { full_name?: string; name?: string };
  const providers = app.providers?.length ? app.providers : app.provider ? [app.provider] : [];
  return { id: String(raw.id), email: typeof raw.email === 'string' ? raw.email : undefined, providers, name: meta.full_name ?? meta.name };
}

export class Cloud {
  session: Session | null = null;
  private fetchFn: typeof fetch;
  private store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  private now: () => number;
  private random: (n: number) => Uint8Array;
  private refreshing: Promise<Session> | null = null;
  onSessionChange: (s: Session | null) => void = () => undefined;

  constructor(public cfg: CloudConfig, public redirectTo: string, deps: Deps = {}) {
    if (!validCloudUrl(cfg.url)) throw new Error('The account service address must start with https://');
    this.cfg = { url: cfg.url.replace(/\/+$/, ''), anonKey: cfg.anonKey };
    this.fetchFn = deps.fetch ?? ((...a) => fetch(...a));
    this.store = deps.storage ?? localStorage;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
    this.session = this.readSession();
  }

  // ----- session storage -----

  private readSession(): Session | null {
    try {
      const s = JSON.parse(this.store.getItem(SESSION_KEY) ?? 'null') as Session | null;
      if (s && typeof s.accessToken === 'string' && typeof s.refreshToken === 'string' && typeof s.expiresAt === 'number' && s.user?.id) return s;
    } catch { /* unreadable: treat as signed out */ }
    return null;
  }

  private setSession(s: Session | null) {
    this.session = s;
    try {
      if (s) this.store.setItem(SESSION_KEY, JSON.stringify(s));
      else this.store.removeItem(SESSION_KEY);
    } catch { /* storage blocked: the session lives only until the page closes */ }
    this.onSessionChange(s);
  }

  private sessionFrom(body: Record<string, unknown>): Session {
    const expiresIn = Number(body.expires_in) || 3600;
    return {
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token),
      expiresAt: this.now() + expiresIn * 1000,
      user: userOf((body.user ?? {}) as Record<string, unknown>),
    };
  }

  // ----- HTTP -----

  private async call(path: string, init: { method?: string; body?: unknown; bearer?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { apikey: this.cfg.anonKey, ...(init.headers ?? {}) };
    if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.url}${path}`, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new CloudError('The account service cannot be reached. Check your connection and try again.');
    }
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      const code = String(b.error_code ?? b.code ?? '');
      const raw = String(b.msg ?? b.message ?? b.error_description ?? b.error ?? `HTTP ${res.status}`);
      throw new CloudError(FRIENDLY[code] ?? raw, res.status, code);
    }
    return { status: res.status, body };
  }

  // ----- PKCE -----

  /** Starts a sign-in: remembers a secret in this browser and returns the matching public challenge. */
  private async pkceParams(flow: 'login' | 'recovery') {
    const verifier = b64url(this.random(48));
    try { this.store.setItem(PKCE_KEY, JSON.stringify({ verifier, flow, at: this.now() })); } catch { /* storage blocked */ }
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { code_challenge: b64url(new Uint8Array(hash)), code_challenge_method: 's256' };
  }

  // ----- sign up / in / out -----

  /** Creates an account. Resolves to true when the service sent a confirmation email first. */
  async signUp(email: string, password: string): Promise<boolean> {
    const { body } = await this.call(`/auth/v1/signup?redirect_to=${encodeURIComponent(this.redirectTo)}`, {
      body: { email, password, ...(await this.pkceParams('login')) },
    });
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.access_token === 'string') { this.setSession(this.sessionFrom(b)); return false; }
    return true;
  }

  async signIn(email: string, password: string): Promise<Session> {
    const { body } = await this.call('/auth/v1/token?grant_type=password', { body: { email, password } });
    const s = this.sessionFrom(body as Record<string, unknown>);
    this.dropPkce(); // a sign-up secret that was never used must not linger
    this.setSession(s);
    return s;
  }

  /** The address to send the browser to for Google or GitHub sign-in. */
  async oauthUrl(provider: Provider): Promise<string> {
    const p = await this.pkceParams('login');
    const q = new URLSearchParams({ provider, redirect_to: this.redirectTo, code_challenge: p.code_challenge, code_challenge_method: p.code_challenge_method });
    return `${this.cfg.url}/auth/v1/authorize?${q}`;
  }

  /** Address for linking another sign-in method (Google or GitHub) to the signed-in account. Needs "manual linking" switched on at the service. */
  async linkUrl(provider: Provider): Promise<string> {
    const p = await this.pkceParams('login');
    const q = new URLSearchParams({ provider, redirect_to: this.redirectTo, skip_http_redirect: 'true', code_challenge: p.code_challenge, code_challenge_method: p.code_challenge_method });
    const { body } = await this.call(`/auth/v1/user/identities/authorize?${q}`, { bearer: await this.accessToken() });
    const url = (body as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || !url.startsWith(this.cfg.url + '/')) throw new CloudError('The service did not return a valid link address.');
    return url;
  }

  async recover(email: string): Promise<void> {
    await this.call(`/auth/v1/recover?redirect_to=${encodeURIComponent(this.redirectTo)}`, { body: { email, ...(await this.pkceParams('recovery')) } });
  }

  /**
   * Call once at start: handles the address the service sends the browser back to (sign-in code, confirmation,
   * password recovery, or an error). Returns what happened, or null when the address has nothing for us.
   * The caller removes the query string afterwards.
   */
  async completeFromUrl(url: URL): Promise<CallbackKind | null> {
    const params = new URLSearchParams(url.search);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    const err = params.get('error_description') ?? hash.get('error_description') ?? params.get('error') ?? hash.get('error');
    if (err) {
      this.dropPkce();
      throw new CloudError(err.replace(/\+/g, ' '));
    }
    const code = params.get('code');
    if (!code) return null;
    let pending: { verifier: string; flow: 'login' | 'recovery'; at: number } | null = null;
    try { pending = JSON.parse(this.store.getItem(PKCE_KEY) ?? 'null'); } catch { /* none */ }
    this.dropPkce();
    // No matching sign-in started in this browser (a confirmation link opened on another device): the address is
    // confirmed at the service, the user only has to sign in.
    if (!pending || typeof pending.verifier !== 'string' || this.now() - pending.at > 3_600_000) return 'confirmed-elsewhere';
    const { body } = await this.call('/auth/v1/token?grant_type=pkce', { body: { auth_code: code, code_verifier: pending.verifier } });
    this.setSession(this.sessionFrom(body as Record<string, unknown>));
    return pending.flow === 'recovery' ? 'recovery' : 'signed-in';
  }

  private dropPkce() {
    try { this.store.removeItem(PKCE_KEY); } catch { /* ignore */ }
  }

  async signOut(): Promise<void> {
    const s = this.session;
    this.setSession(null);
    if (s) {
      try { await this.call('/auth/v1/logout', { method: 'POST', bearer: s.accessToken, body: {} }); } catch { /* already gone: nothing to revoke */ }
    }
  }

  /** A valid access token, refreshed shortly before it expires. Signs out when the refresh token is no longer accepted. */
  async accessToken(): Promise<string> {
    const s = this.session;
    if (!s) throw new CloudError('Not signed in.', 401);
    if (s.expiresAt - this.now() > REFRESH_MARGIN_MS) return s.accessToken;
    this.refreshing ??= (async () => {
      try {
        const { body } = await this.call('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refreshToken } });
        const next = this.sessionFrom(body as Record<string, unknown>);
        this.setSession(next);
        return next;
      } catch (e) {
        if (e instanceof CloudError && e.status >= 400 && e.status < 500) this.setSession(null); // revoked or expired for good
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return (await this.refreshing).accessToken;
  }

  async refreshUser(): Promise<CloudUser> {
    const { body } = await this.call('/auth/v1/user', { bearer: await this.accessToken() });
    const user = userOf(body as Record<string, unknown>);
    if (this.session) this.setSession({ ...this.session, user });
    return user;
  }

  async changePassword(password: string): Promise<void> {
    await this.call('/auth/v1/user', { method: 'PUT', bearer: await this.accessToken(), body: { password } });
  }

  // ----- the per-user record -----

  async loadRecord(): Promise<{ data: unknown; updatedAt: string } | null> {
    const { body } = await this.call('/rest/v1/profiles?select=data,updated_at&limit=1', { bearer: await this.accessToken(), headers: { Accept: 'application/json' } });
    const row = Array.isArray(body) ? (body[0] as { data: unknown; updated_at: string } | undefined) : undefined;
    return row ? { data: row.data, updatedAt: row.updated_at } : null;
  }

  async saveRecord(data: unknown, updatedAt: string): Promise<void> {
    const s = this.session;
    if (!s) throw new CloudError('Not signed in.', 401);
    await this.call('/rest/v1/profiles?on_conflict=user_id', {
      bearer: await this.accessToken(),
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { user_id: s.user.id, data, updated_at: updatedAt },
    });
  }

  /** Deletes the account and its record (needs the delete_my_account function from the setup script). */
  async deleteAccount(): Promise<void> {
    await this.call('/rest/v1/rpc/delete_my_account', { bearer: await this.accessToken(), body: {} });
    this.setSession(null);
  }
}
