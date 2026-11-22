// What an account stores, and how it is kept in step with this browser.
// The record holds the profile, preferences, shortcuts and (only if you choose) your GitHub connection sealed with
// a passphrase that never leaves this browser (AES-256-GCM, PBKDF2 600,000 rounds): the account service stores
// ciphertext it cannot read. Data coming back from the service is validated like any other untrusted input.

import { defaultPrefs, sanitize as sanitizePrefs } from './prefs';
import type { Prefs } from './prefs';
import { sanitizeShortcuts, overrides } from './shortcuts';
import type { ShortcutMap } from './shortcuts';
import { deriveKey, isSealed, newSalt, seal, unlock, WrongPassphrase } from './vault';
import type { Sealed } from './vault';
import type { Cloud } from './cloud';

export interface Profile { name: string; avatar: string }
export const emptyProfile = (): Profile => ({ name: '', avatar: '' });

export interface Connection { owner: string; repo: string; branch: string; token: string; expires?: string }

export interface AccountRecord {
  v: 1;
  profile: Profile;
  prefs: Prefs;
  shortcuts: Partial<ShortcutMap>;
  vault?: Sealed;
  updatedAt: string;
}

const AVATAR_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const MAX_AVATAR_CHARS = 120_000;

export function sanitizeProfile(raw: unknown): Profile {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<Profile>;
  // eslint-disable-next-line no-control-regex
  const name = typeof p.name === 'string' ? p.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
  const avatar = typeof p.avatar === 'string' && p.avatar.length <= MAX_AVATAR_CHARS && AVATAR_RE.test(p.avatar) ? p.avatar : '';
  return { name, avatar };
}

/** Reads a record from the service; anything unexpected is replaced by safe defaults. */
export function parseRecord(raw: unknown, updatedAt: string): AccountRecord {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const stored = (r.shortcuts && typeof r.shortcuts === 'object' ? r.shortcuts : {}) as Record<string, unknown>;
  const clean = sanitizeShortcuts(stored);
  const prefsIn = (r.prefs && typeof r.prefs === 'object' ? r.prefs : {}) as Partial<Prefs>;
  return {
    v: 1,
    profile: sanitizeProfile(r.profile),
    prefs: sanitizePrefs({ ...defaultPrefs, ...prefsIn }),
    shortcuts: overrides(clean),
    vault: isSealed(r.vault) ? r.vault : undefined,
    updatedAt: Number.isNaN(Date.parse(updatedAt)) ? new Date(0).toISOString() : updatedAt,
  };
}

export const shortcutMapOf = (r: Pick<AccountRecord, 'shortcuts'>): ShortcutMap => sanitizeShortcuts(r.shortcuts);

// ----- the sealed connection -----

export async function sealConnection(passphrase: string, c: Connection): Promise<Sealed> {
  const salt = newSalt();
  return seal(await deriveKey(passphrase, salt), salt, c);
}

export async function openConnection(passphrase: string, sealed: Sealed): Promise<Connection> {
  const { data } = await unlock(passphrase, sealed);
  const c = data as Partial<Connection> | null;
  const ok = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 300;
  if (!c || !ok(c.owner) || !ok(c.repo) || !ok(c.branch) || !ok(c.token) || !/^[A-Za-z0-9-]+$/.test(c.owner!) || !/^[A-Za-z0-9._-]+$/.test(c.repo!)) throw new WrongPassphrase();
  return { owner: c.owner!, repo: c.repo!, branch: c.branch!, token: c.token!, expires: typeof c.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.expires) ? c.expires : undefined };
}

// ----- keeping this browser and the account in step -----

const SYNC_KEY = 'prism.sync';

interface SyncMarks { syncedAt: string; localAt: string }
type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface LocalState {
  profile: Profile;
  prefs: Prefs;
  shortcuts: ShortcutMap;
}

export class AccountSync {
  /** The sealed connection last seen at the service (kept so a preferences change never drops it). */
  vault: Sealed | undefined;
  /** Set when the last attempt failed, for the settings page. */
  lastError = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private cloud: Cloud,
    private local: () => LocalState,
    private apply: (r: { profile: Profile; prefs: Prefs; shortcuts: ShortcutMap }) => void,
    private store: KV = localStorage,
    private now: () => Date = () => new Date(),
  ) {}

  private marks(): SyncMarks {
    try {
      const m = JSON.parse(this.store.getItem(SYNC_KEY) ?? 'null') as Partial<SyncMarks> | null;
      return { syncedAt: m?.syncedAt ?? '', localAt: m?.localAt ?? '' };
    } catch {
      return { syncedAt: '', localAt: '' };
    }
  }
  private setMarks(m: SyncMarks) {
    try { this.store.setItem(SYNC_KEY, JSON.stringify(m)); } catch { /* storage blocked */ }
  }

  /** Remember that something changed in this browser; pushes shortly afterwards when signed in. */
  touch(): void {
    this.setMarks({ ...this.marks(), localAt: this.now().toISOString() });
    if (!this.cloud.session) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.push().catch(() => undefined), 1500);
  }

  private build(updatedAt: string): AccountRecord {
    const l = this.local();
    return { v: 1, profile: l.profile, prefs: l.prefs, shortcuts: overrides(l.shortcuts), vault: this.vault, updatedAt };
  }

  async push(): Promise<void> {
    clearTimeout(this.timer);
    const at = this.now().toISOString();
    try {
      await this.cloud.saveRecord(this.build(at), at);
      this.setMarks({ syncedAt: at, localAt: at });
      this.lastError = '';
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /**
   * Brings this browser and the account together after sign-in or on start: the newer side wins.
   * Returns 'applied' (account data replaced local settings), 'pushed' (local data went up) or 'same'.
   */
  async sync(): Promise<'applied' | 'pushed' | 'same'> {
    const remote = await this.cloud.loadRecord();
    if (!remote) { await this.push(); return 'pushed'; }
    const rec = parseRecord(remote.data, remote.updatedAt);
    this.vault = rec.vault;
    const m = this.marks();
    const remoteNewer = !m.localAt || Date.parse(rec.updatedAt) > Date.parse(m.localAt);
    if (rec.updatedAt === m.syncedAt && !(m.localAt > m.syncedAt)) return 'same';
    if (remoteNewer) {
      this.apply({ profile: rec.profile, prefs: rec.prefs, shortcuts: shortcutMapOf(rec) });
      this.setMarks({ syncedAt: rec.updatedAt, localAt: rec.updatedAt });
      return 'applied';
    }
    await this.push();
    return 'pushed';
  }

  /** Stores (or removes) the sealed connection in the account. */
  async setVault(sealed: Sealed | undefined): Promise<void> {
    this.vault = sealed;
    await this.push();
  }
}

