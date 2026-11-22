// Per-browser storage: connection settings (with the token) and unsaved text drafts.
// Three ways to keep the token: 'device' (plain, survives restarts), 'encrypted' (passphrase, survives restarts),
// 'session' (plain, wiped when the tab closes). Every access tolerates blocked storage.

import { isSealed, newSalt, deriveKey, seal, unlock, unseal, Sealed } from './vault';

export type Mode = 'device' | 'encrypted' | 'session';

export interface Settings {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  mode: Mode;
  /** Token expiry date entered by the user (YYYY-MM-DD), for the reminder. Not secret. */
  expires?: string;
}

export interface Stored {
  owner: string;
  repo: string;
  branch: string;
  mode: Mode;
  token?: string;
  sealed?: Sealed;
  expires?: string;
}

const SETTINGS_KEY = 'prism.settings';
const LAST_KEY = 'prism.last';

function area(kind: 'local' | 'session'): Storage | null {
  try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch { return null; }
}
const areaFor = (m: Mode) => area(m === 'session' ? 'session' : 'local');

function read(a: Storage | null, key: string): string | null {
  try { return a?.getItem(key) ?? null; } catch { return null; }
}
function write(a: Storage | null, key: string, value: string | null): boolean {
  if (!a) return false;
  try {
    if (value === null) a.removeItem(key);
    else a.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Key held in memory while an encrypted profile is unlocked. */
let vault: { key: CryptoKey; salt: Uint8Array } | null = null;

function parseStored(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Stored;
    if (!s || typeof s.owner !== 'string' || typeof s.repo !== 'string' || !s.owner || !s.repo) return null;
    const mode: Mode = s.mode === 'encrypted' || s.mode === 'session' ? s.mode : 'device';
    return { owner: s.owner, repo: s.repo, branch: s.branch || 'main', mode, token: s.token, sealed: isSealed(s.sealed) ? s.sealed : undefined, expires: /^\d{4}-\d{2}-\d{2}$/.test(s.expires ?? '') ? s.expires : undefined };
  } catch {
    return null;
  }
}

export type Loaded = { settings: Settings } | { locked: Stored } | null;

export function loadSettings(): Loaded {
  const s = parseStored(read(area('local'), SETTINGS_KEY)) ?? parseStored(read(area('session'), SETTINGS_KEY));
  if (!s) return null;
  if (s.sealed) return { locked: s };
  if (!s.token) return null;
  return { settings: { owner: s.owner, repo: s.repo, branch: s.branch, token: s.token, mode: s.mode === 'encrypted' ? 'device' : s.mode, expires: s.expires } };
}

export async function unlockSettings(stored: Stored, passphrase: string): Promise<Settings> {
  if (!stored.sealed) throw new Error('Nothing to unlock.');
  const { key, salt, data } = await unlock(passphrase, stored.sealed);
  const token = (data as { token?: string } | null)?.token;
  if (!token) throw new Error('Stored data is damaged.');
  vault = { key, salt };
  return { owner: stored.owner, repo: stored.repo, branch: stored.branch, token, mode: 'encrypted', expires: stored.expires };
}

/** Saves settings. For 'encrypted' a passphrase is needed unless the vault is already unlocked. Returns false if storage failed. */
export async function saveSettings(s: Settings, passphrase?: string): Promise<boolean> {
  write(area('local'), SETTINGS_KEY, null);
  write(area('session'), SETTINGS_KEY, null);
  write(area('local'), LAST_KEY, JSON.stringify({ owner: s.owner, repo: s.repo, branch: s.branch }));
  if (s.mode === 'encrypted') {
    if (passphrase) {
      const salt = newSalt();
      vault = { key: await deriveKey(passphrase, salt), salt };
    }
    if (!vault) throw new Error('A passphrase is required.');
    const sealed = await seal(vault.key, vault.salt, { token: s.token });
    return write(area('local'), SETTINGS_KEY, JSON.stringify({ owner: s.owner, repo: s.repo, branch: s.branch, mode: s.mode, sealed, expires: s.expires }));
  }
  vault = null;
  return write(areaFor(s.mode), SETTINGS_KEY, JSON.stringify({ owner: s.owner, repo: s.repo, branch: s.branch, mode: s.mode, token: s.token, expires: s.expires }));
}

export function lastConnection(): { owner: string; repo: string; branch: string } | null {
  try {
    const v = JSON.parse(read(area('local'), LAST_KEY) ?? 'null') as { owner: string; repo: string; branch: string } | null;
    return v && v.owner && v.repo ? v : null;
  } catch {
    return null;
  }
}

/** Removes everything this app stored in this browser (token, drafts, preferences). */
export function clearAllLocalData() {
  vault = null;
  for (const a of [area('local'), area('session')]) {
    if (!a) continue;
    try {
      for (const k of Object.keys(a)) if (k.startsWith('prism.')) a.removeItem(k);
    } catch { /* ignore */ }
  }
}

// ---------- Drafts ----------

/** Unsaved text edits, kept so a closed tab or crash loses nothing. base = blob SHA the edit started from. */
export type Drafts = Record<string, { text: string; base: string | null }>;

const draftKey = (s: Settings) => `prism.drafts:${s.owner}/${s.repo}@${s.branch}`;

export async function loadDrafts(s: Settings): Promise<Drafts> {
  try {
    const parsed = JSON.parse(read(areaFor(s.mode), draftKey(s)) ?? '{}') as unknown;
    if (isSealed(parsed)) {
      if (!vault) return {};
      return (await unseal(vault.key, parsed)) as Drafts;
    }
    return (parsed ?? {}) as Drafts;
  } catch {
    return {};
  }
}

export async function saveDrafts(s: Settings, d: Drafts): Promise<boolean> {
  const a = areaFor(s.mode);
  if (!Object.keys(d).length) return write(a, draftKey(s), null);
  if (s.mode === 'encrypted') {
    if (!vault) return false; // never fall back to plain text for an encrypted profile
    return write(a, draftKey(s), JSON.stringify(await seal(vault.key, vault.salt, d)));
  }
  return write(a, draftKey(s), JSON.stringify(d));
}

/** Deletes the stored drafts of a repository from where this mode keeps them. */
export function dropDrafts(s: Settings): void {
  write(areaFor(s.mode), draftKey(s), null);
}

export function lastProject(s: Settings): string | null {
  return read(area('local'), `${draftKey(s)}:project`);
}
export function setLastProject(s: Settings, project: string) {
  write(area('local'), `${draftKey(s)}:project`, project);
}
