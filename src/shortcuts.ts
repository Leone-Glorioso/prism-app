// Keyboard shortcuts: the list of actions, their default keys, user overrides (kept in this browser and, with an
// account, synced), conflict checks and conversion to CodeMirror key names.
// A combination is written like "Mod-Shift-f": Mod = Ctrl (Cmd on a Mac), then Alt, Shift, then one key.

export type ActionId = 'save' | 'compile' | 'forward' | 'searchProject' | 'bold' | 'italic' | 'inlineMath' | 'settings' | 'projects';

export interface ActionInfo {
  id: ActionId;
  label: string;
  group: 'File' | 'Editor' | 'Navigate';
  editorOnly: boolean; // only works while the cursor is in the editor
  key: string; // default combination
}

export const ACTIONS: ActionInfo[] = [
  { id: 'save', label: 'Save to GitHub', group: 'File', editorOnly: false, key: 'Mod-s' },
  { id: 'compile', label: 'Save and compile', group: 'File', editorOnly: false, key: 'Mod-Enter' },
  { id: 'forward', label: 'Show this line in the PDF', group: 'Navigate', editorOnly: true, key: 'Mod-Alt-j' },
  { id: 'searchProject', label: 'Search in the whole project', group: 'Navigate', editorOnly: false, key: 'Mod-Shift-f' },
  { id: 'projects', label: 'Back to all projects', group: 'Navigate', editorOnly: false, key: 'Mod-Alt-h' },
  { id: 'settings', label: 'Open settings', group: 'Navigate', editorOnly: false, key: 'Mod-,' },
  { id: 'bold', label: 'Bold around the selection', group: 'Editor', editorOnly: true, key: 'Mod-b' },
  { id: 'italic', label: 'Emphasis around the selection', group: 'Editor', editorOnly: true, key: 'Mod-i' },
  { id: 'inlineMath', label: 'Inline math around the selection', group: 'Editor', editorOnly: true, key: 'Mod-Alt-m' },
];

export type ShortcutMap = Record<ActionId, string>;
export const defaultShortcuts = (): ShortcutMap => Object.fromEntries(ACTIONS.map((a) => [a.id, a.key])) as ShortcutMap;

/** Keys the browser or the editor already use for something that matters; refused for remapping. */
const RESERVED = new Set([
  'Mod-z', 'Mod-y', 'Mod-Shift-z', 'Mod-c', 'Mod-v', 'Mod-x', 'Mod-a', 'Mod-f', 'Mod-g', 'Mod-Shift-g', 'Mod-w', 'Mod-t', 'Mod-n',
  'Mod-r', 'Mod-l', 'Mod-p', 'Mod-q', 'Mod-o', 'Mod-d', 'Mod-u', 'Mod-h', 'Mod-j', 'Mod-k', 'Mod-e', 'Mod-/', 'Mod-Space', 'Mod-Shift-t',
  'Mod-Shift-n', 'Mod-Shift-w', 'Mod-Shift-Delete', 'Mod-Tab', 'F5', 'F11', 'F12', 'Escape', 'Tab', 'Enter', 'Backspace', 'Delete',
]);

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);
const NAMED = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert']);

export interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }

/** The combination a key press stands for, or null for a bare modifier key. */
export function comboOf(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key = e.key === ' ' ? 'Space' : e.key;
  if (key.length === 1) key = key.toLowerCase();
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  // Shift on a symbol key changes the character itself (Shift+/ is "?"): only record it for letters, digits and named keys.
  if (e.shiftKey && (/^[a-z0-9]$/.test(key) || key.length > 1)) parts.push('Shift');
  parts.push(key);
  return parts.join('-');
}

/** "Mod-Alt-j" → modifiers and key; "Mod--" is Mod plus the minus key. */
export function splitCombo(combo: string): { mods: string[]; key: string } {
  if (combo.endsWith('--') || combo === '-') return { mods: combo.slice(0, -2).split('-').filter(Boolean), key: '-' };
  const parts = combo.split('-');
  return { mods: parts.slice(0, -1), key: parts[parts.length - 1] };
}

/** Checks a combination; returns an error message or null when it can be used. */
export function validateCombo(combo: string): string | null {
  const { mods, key } = splitCombo(combo);
  if (!key) return 'Press a key.';
  const isFn = /^F([1-9]|1[0-2])$/.test(key);
  if (!isFn && !mods.includes('Mod') && !mods.includes('Alt')) return 'Use Ctrl (or Cmd) or Alt together with the key.';
  if (RESERVED.has(combo)) return 'The browser or the editor already uses this combination.';
  if (key.length > 1 && !isFn && !NAMED.has(key)) return 'This key cannot be used.';
  return null;
}

/** The action that already uses `combo`, if any (other than `except`). */
export function conflictFor(map: ShortcutMap, combo: string, except: ActionId): ActionInfo | null {
  const hit = ACTIONS.find((a) => a.id !== except && map[a.id] === combo);
  return hit ?? null;
}

export function sanitizeShortcuts(raw: unknown): ShortcutMap {
  const out = defaultShortcuts();
  if (!raw || typeof raw !== 'object') return out;
  const used = new Set<string>();
  const entries = ACTIONS.map((a) => [a.id, (raw as Record<string, unknown>)[a.id]] as const);
  // Keep a stored value only when it is valid and not used twice; otherwise fall back to the default.
  for (const [id, v] of entries) {
    if (typeof v === 'string' && v !== out[id] && validateCombo(v) === null && !used.has(v)) {
      out[id] = v;
      used.add(v);
    }
  }
  // A default may now collide with a custom value: give the action without a free key an empty slot (disabled).
  const seen = new Set<string>();
  for (const a of ACTIONS) {
    if (out[a.id] && seen.has(out[a.id])) out[a.id] = '';
    seen.add(out[a.id]);
  }
  return out;
}

const KEY = 'prism.shortcuts';

export function loadShortcuts(): ShortcutMap {
  try { return sanitizeShortcuts(JSON.parse(localStorage.getItem(KEY) ?? 'null')); } catch { return defaultShortcuts(); }
}

export function saveShortcuts(map: ShortcutMap): void {
  try {
    const changed = Object.fromEntries(ACTIONS.filter((a) => map[a.id] !== a.key).map((a) => [a.id, map[a.id]]));
    if (Object.keys(changed).length) localStorage.setItem(KEY, JSON.stringify(changed));
    else localStorage.removeItem(KEY);
  } catch { /* storage blocked */ }
}

/** Only the entries that differ from the defaults (what gets stored and synced). */
export function overrides(map: ShortcutMap): Partial<ShortcutMap> {
  return Object.fromEntries(ACTIONS.filter((a) => map[a.id] !== a.key).map((a) => [a.id, map[a.id]]));
}

/** "Mod-Shift-f" → "Ctrl+Shift+F" (or "⌘⇧F" on a Mac). */
export function formatCombo(combo: string, mac = /Mac|iPhone|iPad/.test(navigator.platform)): string {
  if (!combo) return '—';
  const { mods, key } = splitCombo(combo);
  const shown = key.length === 1 ? key.toUpperCase() : key === 'Space' ? 'Space' : key;
  if (mac) return `${mods.includes('Mod') ? '⌘' : ''}${mods.includes('Alt') ? '⌥' : ''}${mods.includes('Shift') ? '⇧' : ''}${shown}`;
  return [...mods.map((m) => (m === 'Mod' ? 'Ctrl' : m)), shown].join('+');
}

/** CodeMirror uses the same notation; an empty combination means "no key". */
export const cmKey = (combo: string): string | null => (combo ? combo : null);
