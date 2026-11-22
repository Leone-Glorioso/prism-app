// Preferences (not secret): theme, editor font size, spell check, PDF click behaviour.

export interface Prefs {
  theme: 'auto' | 'light' | 'dark';
  fontSize: number;
  spellcheck: boolean;
  spellLang: string;
  pdfJump: 'double' | 'ctrl' | 'off';
  followCursor: boolean;
}

export const defaultPrefs: Prefs = {
  theme: 'auto', fontSize: 14, spellcheck: false, spellLang: 'en', pdfJump: 'double', followCursor: false,
};

const KEY = 'prism.prefs';

export function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null;
    return sanitize({ ...defaultPrefs, ...p });
  } catch {
    return { ...defaultPrefs };
  }
}

export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}

export function sanitize(p: Prefs): Prefs {
  return {
    theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'auto',
    fontSize: Math.min(28, Math.max(10, Math.round(Number(p.fontSize) || 14))),
    spellcheck: !!p.spellcheck,
    spellLang: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(p.spellLang) ? p.spellLang : 'en',
    pdfJump: p.pdfJump === 'ctrl' || p.pdfJump === 'off' ? p.pdfJump : 'double',
    followCursor: !!p.followCursor,
  };
}

export function isDark(p: Prefs): boolean {
  return p.theme === 'dark' || (p.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function applyPrefs(p: Prefs): void {
  const root = document.documentElement;
  if (p.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = p.theme;
  root.style.setProperty('--editor-size', `${p.fontSize}px`);
}
