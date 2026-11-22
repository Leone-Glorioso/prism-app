// Preferences (not secret): look and feel, editor behaviour, PDF click behaviour. Kept in this browser and, with an account, synced.

export type AccentName = 'indigo' | 'blue' | 'teal' | 'green' | 'orange' | 'rose' | 'slate';
export type EditorFont = 'mono' | 'serif' | 'sans';

export interface Prefs {
  theme: 'auto' | 'light' | 'dark';
  accent: AccentName;
  fontSize: number;
  editorFont: EditorFont;
  lineNumbers: boolean;
  lineWrap: boolean;
  autoComplete: boolean;
  spellcheck: boolean;
  spellLang: string;
  pdfJump: 'double' | 'ctrl' | 'off';
  followCursor: boolean;
}

export const defaultPrefs: Prefs = {
  theme: 'auto', accent: 'indigo', fontSize: 14, editorFont: 'mono', lineNumbers: true, lineWrap: true, autoComplete: true,
  spellcheck: false, spellLang: 'en', pdfJump: 'double', followCursor: false,
};

interface Palette { accent: string; hover: string; soft: string; selected: string; text: string }
/** Accent colours for light and dark backgrounds (text on the accent keeps a contrast of at least 4.5:1). */
export const ACCENTS: Record<AccentName, { label: string; light: Palette; dark: Palette }> = {
  indigo: { label: 'Indigo', light: { accent: '#4f46e5', hover: '#4338ca', soft: '#eceafd', selected: '#e8e7fc', text: '#ffffff' }, dark: { accent: '#8b85ff', hover: '#a29dff', soft: '#24234a', selected: '#2a2952', text: '#0e0d24' } },
  blue: { label: 'Blue', light: { accent: '#2563eb', hover: '#1d4ed8', soft: '#e6efff', selected: '#dbe7ff', text: '#ffffff' }, dark: { accent: '#7aa7ff', hover: '#9bbcff', soft: '#1b2a4a', selected: '#223660', text: '#0b1220' } },
  teal: { label: 'Teal', light: { accent: '#0f766e', hover: '#115e59', soft: '#dff5f2', selected: '#d0efea', text: '#ffffff' }, dark: { accent: '#4fd1c5', hover: '#7ae0d6', soft: '#12332f', selected: '#18443e', text: '#06201d' } },
  green: { label: 'Green', light: { accent: '#15803d', hover: '#166534', soft: '#e3f5e8', selected: '#d3eedb', text: '#ffffff' }, dark: { accent: '#6ee7a0', hover: '#94efbb', soft: '#14301f', selected: '#1b4029', text: '#08210f' } },
  orange: { label: 'Orange', light: { accent: '#c2410c', hover: '#9a3412', soft: '#fdeee3', selected: '#fbe2d0', text: '#ffffff' }, dark: { accent: '#fdba74', hover: '#fdcd9b', soft: '#3a2514', selected: '#4b2f19', text: '#2a1404' } },
  rose: { label: 'Rose', light: { accent: '#be185d', hover: '#9d174d', soft: '#fde6ef', selected: '#fbd7e5', text: '#ffffff' }, dark: { accent: '#fb9ac0', hover: '#fcb5d1', soft: '#3b1a29', selected: '#4d2234', text: '#2b0c18' } },
  slate: { label: 'Slate', light: { accent: '#475569', hover: '#334155', soft: '#eceff3', selected: '#e1e6ec', text: '#ffffff' }, dark: { accent: '#b6c0d0', hover: '#cdd5e1', soft: '#232a34', selected: '#2c3541', text: '#10151c' } },
};

export const EDITOR_FONTS: Record<EditorFont, { label: string; css: string }> = {
  mono: { label: 'Monospace', css: 'ui-monospace, "Cascadia Code", "Cascadia Mono", "SF Mono", Consolas, monospace' },
  serif: { label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  sans: { label: 'Sans-serif', css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
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
  const has = <T extends string>(set: Record<T, unknown>, v: unknown, fallback: T): T => (typeof v === 'string' && Object.hasOwn(set, v) ? (v as T) : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'auto',
    accent: has(ACCENTS, p.accent, 'indigo'),
    fontSize: Math.min(28, Math.max(10, Math.round(Number(p.fontSize) || 14))),
    editorFont: has(EDITOR_FONTS, p.editorFont, 'mono'),
    lineNumbers: bool(p.lineNumbers, true),
    lineWrap: bool(p.lineWrap, true),
    autoComplete: bool(p.autoComplete, true),
    spellcheck: !!p.spellcheck,
    spellLang: typeof p.spellLang === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(p.spellLang) ? p.spellLang : 'en',
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
  root.style.setProperty('--editor-font', EDITOR_FONTS[p.editorFont].css);
  root.dataset.lineNumbers = p.lineNumbers ? 'on' : 'off';
  const vars = ['--accent', '--accent-hover', '--accent-soft', '--selected', '--accent-text'];
  if (p.accent === 'indigo') {
    for (const v of vars) root.style.removeProperty(v); // the stylesheet already defines indigo for both themes
  } else {
    const c = ACCENTS[p.accent][isDark(p) ? 'dark' : 'light'];
    [c.accent, c.hover, c.soft, c.selected, c.text].forEach((value, i) => root.style.setProperty(vars[i], value));
  }
}
