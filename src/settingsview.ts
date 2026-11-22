// The settings page: profile, appearance, editor, shortcuts, connection, account and about.

import { ACCENTS, EDITOR_FONTS } from './prefs';
import type { AccentName, EditorFont, Prefs } from './prefs';
import { ACTIONS, comboOf, conflictFor, defaultShortcuts, formatCombo, validateCombo } from './shortcuts';
import type { ActionId, ShortcutMap } from './shortcuts';
import { imageToAvatar, paintAvatar } from './profile';
import type { Profile } from './account';
import type { CloudUser } from './cloud';
import type { Mode } from './storage';
import { el } from './authui';

export type SectionId = 'profile' | 'appearance' | 'editor' | 'shortcuts' | 'connection' | 'account' | 'about';

/** What the account panel needs from the rest of the app. */
export interface AccountApi {
  configured: boolean;
  user(): CloudUser | null;
  syncError(): string;
  hasVault(): boolean;
  hasPlain(): boolean;
  connected(): boolean;
  signIn(): void;
  signOut(): Promise<void>;
  saveConnection(): void;
  removeConnection(): void;
  changePassword(password: string): Promise<void>;
  deleteAccount(): Promise<void>;
  syncNow(): Promise<void>;
}

export interface SettingsCtx {
  prefs(): Prefs;
  setPrefs(p: Prefs): void;
  shortcuts(): ShortcutMap;
  setShortcuts(m: ShortcutMap): void;
  profile(): Profile;
  setProfile(p: Profile): void;
  email(): string | undefined;
  connection(): { owner: string; repo: string; branch: string; mode: Mode; expires?: string } | null;
  editConnection(): void;
  clearBrowser(): void;
  account: AccountApi;
  version: string;
}

const MODE_TEXT: Record<Mode, string> = {
  device: 'kept on this device',
  encrypted: 'kept on this device, encrypted with your passphrase',
  session: 'kept only until this tab closes',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function initSettingsView(ctx: SettingsCtx) {
  let section: SectionId = 'profile';
  let capturing: ActionId | null = null;
  let stopCapture: (() => void) | null = null;

  // ----- navigation -----
  const panels = [...document.querySelectorAll<HTMLElement>('.spanel')];
  const navButtons = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')];
  function show(id: SectionId) {
    section = id;
    cancelCapture();
    for (const p of panels) p.hidden = p.id !== `sp-${id}`;
    for (const b of navButtons) {
      if (b.dataset.sp === id) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    refresh();
  }
  for (const b of navButtons) b.addEventListener('click', () => show(b.dataset.sp as SectionId));

  const update = (patch: Partial<Prefs>) => ctx.setPrefs({ ...ctx.prefs(), ...patch });

  // ----- profile -----
  const profileMsg = $('sp-profile-msg');
  $('sp-avatar-pick').addEventListener('click', () => $<HTMLInputElement>('sp-avatar-file').click());
  $<HTMLInputElement>('sp-avatar-file').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      ctx.setProfile({ ...ctx.profile(), avatar: await imageToAvatar(file) });
      profileMsg.textContent = 'Picture updated.';
    } catch (err) {
      profileMsg.textContent = err instanceof Error ? err.message : String(err);
    }
    refresh();
  });
  $('sp-avatar-remove').addEventListener('click', () => { ctx.setProfile({ ...ctx.profile(), avatar: '' }); profileMsg.textContent = 'Picture removed.'; refresh(); });
  $<HTMLInputElement>('sp-name').addEventListener('change', (e) => {
    ctx.setProfile({ ...ctx.profile(), name: (e.target as HTMLInputElement).value });
    profileMsg.textContent = 'Name saved.';
    refresh();
  });

  // ----- appearance -----
  for (const b of document.querySelectorAll<HTMLButtonElement>('#sp-theme button')) {
    b.addEventListener('click', () => { update({ theme: b.dataset.v as Prefs['theme'] }); refresh(); });
  }
  const swatches = $('sp-accents');
  for (const [name, info] of Object.entries(ACCENTS) as [AccentName, (typeof ACCENTS)[AccentName]][]) {
    const b = el('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-label': info.label, title: info.label, 'data-v': name });
    b.style.background = info.light.accent;
    b.addEventListener('click', () => { update({ accent: name }); refresh(); });
    swatches.append(b);
  }
  const fontSelect = $<HTMLSelectElement>('sp-font');
  for (const [id, f] of Object.entries(EDITOR_FONTS)) fontSelect.append(new Option(f.label, id));
  fontSelect.addEventListener('change', () => update({ editorFont: fontSelect.value as EditorFont }));
  $<HTMLInputElement>('sp-size').addEventListener('change', (e) => { update({ fontSize: Number((e.target as HTMLInputElement).value) }); refresh(); });

  // ----- editor -----
  const bind = (id: string, key: 'autoComplete' | 'lineNumbers' | 'lineWrap' | 'spellcheck' | 'followCursor') =>
    $<HTMLInputElement>(id).addEventListener('change', (e) => update({ [key]: (e.target as HTMLInputElement).checked }));
  bind('sp-autocomplete', 'autoComplete'); bind('sp-linenumbers', 'lineNumbers'); bind('sp-wrap', 'lineWrap');
  bind('sp-spell', 'spellcheck'); bind('sp-follow', 'followCursor');
  $<HTMLSelectElement>('sp-lang').addEventListener('change', (e) => update({ spellLang: (e.target as HTMLSelectElement).value }));
  $<HTMLSelectElement>('sp-jump').addEventListener('change', (e) => update({ pdfJump: (e.target as HTMLSelectElement).value as Prefs['pdfJump'] }));

  // ----- shortcuts -----
  const keysMsg = $('sp-keys-msg');
  function cancelCapture() {
    stopCapture?.();
    stopCapture = null;
    capturing = null;
  }
  function startCapture(id: ActionId) {
    cancelCapture();
    capturing = id;
    keysMsg.textContent = '';
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation(); // the pressed keys must not trigger the action they currently stand for
      if (e.key === 'Escape') { cancelCapture(); renderKeys(); return; }
      const combo = comboOf(e);
      if (!combo) return; // a modifier on its own: wait for the key
      const bad = validateCombo(combo);
      if (bad) { keysMsg.textContent = `${formatCombo(combo)}: ${bad}`; return; }
      const map = ctx.shortcuts();
      const clash = conflictFor(map, combo, id);
      if (clash) { keysMsg.textContent = `${formatCombo(combo)} is already used for "${clash.label}". Change that one first or press other keys.`; return; }
      cancelCapture();
      keysMsg.textContent = '';
      ctx.setShortcuts({ ...map, [id]: combo });
      renderKeys();
    };
    document.addEventListener('keydown', handler, true);
    stopCapture = () => document.removeEventListener('keydown', handler, true);
    renderKeys();
  }
  function renderKeys() {
    const box = $('sp-keys');
    const map = ctx.shortcuts();
    box.replaceChildren();
    let group = '';
    for (const a of ACTIONS) {
      if (a.group !== group) { group = a.group; box.append(el('div', { class: 'grp' }, group)); }
      const kbd = el('kbd', { class: capturing === a.id ? 'capturing' : '' }, capturing === a.id ? 'Press the new keys…' : formatCombo(map[a.id]));
      const change = el('button', { type: 'button', class: 'btn sm', 'aria-label': `Change shortcut for ${a.label}` }, capturing === a.id ? 'Cancel' : 'Change');
      change.addEventListener('click', () => { if (capturing === a.id) { cancelCapture(); renderKeys(); } else startCapture(a.id); });
      const reset = el('button', { type: 'button', class: 'btn sm', 'aria-label': `Reset shortcut for ${a.label}` }, 'Reset');
      reset.disabled = map[a.id] === a.key;
      reset.addEventListener('click', () => {
        const clash = conflictFor(map, a.key, a.id);
        if (clash) { keysMsg.textContent = `The default ${formatCombo(a.key)} is used for "${clash.label}" right now.`; return; }
        keysMsg.textContent = '';
        ctx.setShortcuts({ ...map, [a.id]: a.key });
        renderKeys();
      });
      box.append(
        el('div', { class: 'name' }, a.label + (a.editorOnly ? ' (in the editor)' : '')),
        el('div', { class: 'combo' }, kbd),
        el('div', { class: 'acts' }, change, reset),
      );
    }
  }
  $('sp-keys-reset').addEventListener('click', () => { cancelCapture(); keysMsg.textContent = ''; ctx.setShortcuts(defaultShortcuts()); renderKeys(); });

  // ----- connection -----
  $('sp-conn-edit').addEventListener('click', ctx.editConnection);
  $('sp-conn-clear').addEventListener('click', ctx.clearBrowser);
  function renderConnection() {
    const c = ctx.connection();
    const box = $('sp-conn-info');
    box.replaceChildren();
    if (!c) { box.append(el('p', {}, 'Not connected. Use “Change connection…” to connect your GitHub repository.')); return; }
    box.append(
      el('p', {}, el('strong', {}, `${c.owner}/${c.repo}`), ` on branch ${c.branch}`),
      el('p', {}, `Token ${MODE_TEXT[c.mode]}.`),
      el('p', {}, c.expires ? `Token expiry date you entered: ${c.expires}.` : 'No token expiry date entered (add one to get a reminder 10 days before).'),
    );
  }

  // ----- account -----
  function renderAccount() {
    const body = $('sp-account-body');
    const api = ctx.account;
    body.replaceChildren();
    if (!api.configured) {
      body.append(
        el('p', {}, el('span', { class: 'status-pill off' }, 'Not set up')),
        el('p', {}, 'This copy of LeoTeX was built without an account service, so everything stays in this browser: your token, settings and shortcuts do not follow you to other browsers.'),
        el('p', { class: 'hint' }, 'The site owner can switch accounts on (email and password, Google and GitHub sign-in); see the README, section “Accounts”.'),
      );
      return;
    }
    const user = api.user();
    if (!user) {
      body.append(
        el('p', {}, el('span', { class: 'status-pill off' }, 'Signed out')),
        el('p', {}, 'Sign in to bring your settings, shortcuts, profile picture and (optionally) your GitHub connection to every browser. You can sign in with email and password, Google or GitHub.'),
      );
      const b = el('button', { type: 'button', class: 'btn primary' }, 'Sign in or create an account');
      b.addEventListener('click', api.signIn);
      body.append(b);
      return;
    }
    const how = user.providers.length ? user.providers.map((p) => (p === 'email' ? 'email and password' : p[0].toUpperCase() + p.slice(1))).join(', ') : 'account';
    body.append(
      el('p', {}, el('span', { class: 'status-pill' }, 'Signed in')),
      el('div', { class: 'card-note' }, el('p', {}, el('strong', {}, user.email ?? user.name ?? 'Your account')), el('p', {}, `Sign-in methods: ${how}`)),
    );
    // sync
    const sync = el('p', { class: 'hint' }, api.syncError() ? `Last sync problem: ${api.syncError()}` : 'Settings, shortcuts and profile are synced automatically.');
    const syncBtn = el('button', { type: 'button', class: 'btn sm' }, 'Sync now');
    syncBtn.addEventListener('click', async () => { syncBtn.disabled = true; try { await api.syncNow(); } catch { /* shown by syncError */ } syncBtn.disabled = false; renderAccount(); });
    body.append(sync, syncBtn);
    // vault
    body.append(el('h3', {}, 'GitHub connection in your account'));
    if (api.hasVault()) {
      body.append(el('p', {}, el('span', { class: 'status-pill' }, 'Saved'), api.hasPlain() ? ' Your repository and token are stored in your account without a passphrase: signing in on a new browser opens your projects.' : ' Your repository and token are stored in your account, sealed with your vault passphrase. On a new browser, sign in and enter the passphrase.'));
      const upd = el('button', { type: 'button', class: 'btn sm' }, 'Replace with the current connection');
      upd.disabled = !api.connected();
      upd.addEventListener('click', api.saveConnection);
      const rem = el('button', { type: 'button', class: 'btn sm danger' }, 'Remove from my account');
      rem.addEventListener('click', api.removeConnection);
      body.append(el('div', { class: 'btn-row' }, upd, rem));
    } else {
      body.append(el('p', {}, 'Save your repository and token once, so a new browser needs only your sign-in (or sign-in plus a passphrase, if you choose that).'));
      const save = el('button', { type: 'button', class: 'btn primary' }, 'Save my connection to my account');
      save.disabled = !api.connected();
      save.addEventListener('click', api.saveConnection);
      body.append(save);
      if (!api.connected()) body.append(el('p', { class: 'hint' }, 'Connect your repository first.'));
    }
    // password and sign out
    if (user.providers.includes('email')) {
      body.append(el('h3', {}, 'Password'));
      const pw = el('input', { type: 'password', autocomplete: 'new-password', minlength: '8', placeholder: 'New password (8 or more characters)', 'aria-label': 'New password' });
      const pwBtn = el('button', { type: 'button', class: 'btn sm' }, 'Change password');
      const pwMsg = el('p', { class: 'msg', role: 'status' });
      pwBtn.addEventListener('click', async () => {
        if (pw.value.length < 8) { pwMsg.className = 'msg error'; pwMsg.textContent = 'Use at least 8 characters.'; return; }
        try { await api.changePassword(pw.value); pw.value = ''; pwMsg.className = 'msg'; pwMsg.textContent = 'Password changed.'; } catch (e) { pwMsg.className = 'msg error'; pwMsg.textContent = e instanceof Error ? e.message : String(e); }
      });
      body.append(el('div', { class: 'btn-row' }, pw, pwBtn), pwMsg);
    }
    body.append(el('h3', {}, 'Session'));
    const out = el('button', { type: 'button', class: 'btn' }, 'Sign out');
    out.addEventListener('click', async () => { await api.signOut(); renderAccount(); });
    const del = el('button', { type: 'button', class: 'btn danger' }, 'Delete my account…');
    del.addEventListener('click', async () => {
      if (!confirm('Delete your account and everything stored in it (profile, settings, sealed connection)?\n\nYour GitHub repository and projects are not touched. This cannot be undone.')) return;
      try { await api.deleteAccount(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
      renderAccount();
    });
    body.append(el('div', { class: 'btn-row' }, out, del));
  }

  // ----- refresh from state -----
  function refresh() {
    const p = ctx.prefs();
    const profile = ctx.profile();
    paintAvatar($('sp-avatar'), profile, ctx.email());
    const nameInput = $<HTMLInputElement>('sp-name');
    if (document.activeElement !== nameInput) nameInput.value = profile.name;
    $<HTMLButtonElement>('sp-avatar-remove').disabled = !profile.avatar;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#sp-theme button')) b.setAttribute('aria-checked', String(b.dataset.v === p.theme));
    for (const b of swatches.querySelectorAll<HTMLButtonElement>('.swatch')) b.setAttribute('aria-checked', String(b.dataset.v === p.accent));
    fontSelect.value = p.editorFont;
    $<HTMLInputElement>('sp-size').value = String(p.fontSize);
    $<HTMLInputElement>('sp-autocomplete').checked = p.autoComplete;
    $<HTMLInputElement>('sp-linenumbers').checked = p.lineNumbers;
    $<HTMLInputElement>('sp-wrap').checked = p.lineWrap;
    $<HTMLInputElement>('sp-spell').checked = p.spellcheck;
    $<HTMLSelectElement>('sp-lang').value = p.spellLang;
    $<HTMLSelectElement>('sp-jump').value = p.pdfJump;
    $<HTMLInputElement>('sp-follow').checked = p.followCursor;
    $('sp-version').textContent = ctx.version;
    if (section === 'shortcuts') renderKeys();
    if (section === 'connection') renderConnection();
    if (section === 'account') renderAccount();
  }

  return { show, refresh, section: () => section, cancelCapture };
}
