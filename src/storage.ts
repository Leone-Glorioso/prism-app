// Per-browser storage: connection settings and unsaved text drafts. Every access tolerates blocked storage.

export interface Settings {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

const SETTINGS_KEY = 'prism.settings';

function get(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function set(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadSettings(): Settings | null {
  try {
    const s = JSON.parse(get(SETTINGS_KEY) ?? 'null') as Settings | null;
    return s && s.owner && s.repo && s.token ? { ...s, branch: s.branch || 'main' } : null;
  } catch {
    return null;
  }
}

export function saveSettings(s: Settings | null): boolean {
  return set(SETTINGS_KEY, s ? JSON.stringify(s) : null);
}

/** Unsaved text edits, kept so a closed tab or crash loses nothing. base = blob SHA the edit started from. */
export type Drafts = Record<string, { text: string; base: string | null }>;

const draftKey = (s: Settings) => `prism.drafts:${s.owner}/${s.repo}@${s.branch}`;

export function loadDrafts(s: Settings): Drafts {
  try { return JSON.parse(get(draftKey(s)) ?? '{}') as Drafts; } catch { return {}; }
}

export function saveDrafts(s: Settings, d: Drafts): boolean {
  return set(draftKey(s), Object.keys(d).length ? JSON.stringify(d) : null);
}

export function lastProject(s: Settings): string | null {
  return get(`${draftKey(s)}:project`);
}
export function setLastProject(s: Settings, project: string) {
  set(`${draftKey(s)}:project`, project);
}
