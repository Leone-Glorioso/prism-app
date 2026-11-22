// The sign-in / create-account form (used on the start page and in the sign-in window).

import type { Cloud, Provider } from './cloud';

const GITHUB_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';
const GOOGLE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.27-2.09 3.57-5.17 3.57-8.81Z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.87-3a7.2 7.2 0 0 1-10.72-3.78H1.34v3.09A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.34 14.31a7.2 7.2 0 0 1 0-4.62V6.6H1.34a12 12 0 0 0 0 10.8l4-3.09Z"/><path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.43-3.43A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.34 6.6l4 3.09A7.2 7.2 0 0 1 12 4.77Z"/></svg>';

type Attrs = Record<string, string | boolean>;
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids);
  return e;
}

export const MIN_PASSWORD = 8;
export const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

export interface AuthHooks {
  onSignedIn(): void;
  /** Called with a short note the page may also show elsewhere (optional). */
  startTab?: 'signin' | 'signup';
}

export function buildAuthForm(cloud: Cloud, hooks: AuthHooks): HTMLElement {
  let tab: 'signin' | 'signup' = hooks.startTab ?? 'signin';
  const root = el('div', { class: 'auth-form' });
  const msg = el('p', { class: 'msg', role: 'status' });
  const err = el('p', { class: 'msg error', role: 'alert' });
  const say = (text: string, bad = false) => { msg.textContent = bad ? '' : text; err.textContent = bad ? text : ''; };

  const tabs = el('div', { class: 'auth-tabs', role: 'tablist', 'aria-label': 'Sign in or create an account' });
  const tabIn = el('button', { type: 'button', role: 'tab' }, 'Sign in');
  const tabUp = el('button', { type: 'button', role: 'tab' }, 'Create account');
  tabs.append(tabIn, tabUp);

  const provider = (p: Provider, label: string, svg: string) => {
    const b = el('button', { type: 'button', class: 'btn provider-btn' });
    b.insertAdjacentHTML('afterbegin', svg);
    b.append(label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { location.assign(await cloud.oauthUrl(p)); } catch (e) { say(e instanceof Error ? e.message : String(e), true); b.disabled = false; }
    });
    // Coming back with the browser's Back button restores the page as it was: the button must work again.
    window.addEventListener('pageshow', () => { b.disabled = false; });
    return b;
  };

  const email = el('input', { type: 'email', autocomplete: 'email', required: true, spellcheck: 'false', placeholder: 'you@example.com' });
  const password = el('input', { type: 'password', required: true, minlength: String(MIN_PASSWORD), spellcheck: 'false' });
  const submit = el('button', { type: 'submit', class: 'btn primary' });
  const forgot = el('button', { type: 'button', class: 'linklike' }, 'Forgot your password?');
  const form = el('form', { novalidate: true },
    el('label', {}, 'Email', email),
    el('label', {}, 'Password', password),
    submit, forgot);

  const render = () => {
    tabIn.setAttribute('aria-selected', String(tab === 'signin'));
    tabUp.setAttribute('aria-selected', String(tab === 'signup'));
    submit.textContent = tab === 'signin' ? 'Sign in' : 'Create account';
    password.autocomplete = tab === 'signin' ? 'current-password' : 'new-password';
    forgot.hidden = tab !== 'signin';
    say('');
  };
  tabIn.addEventListener('click', () => { tab = 'signin'; render(); });
  tabUp.addEventListener('click', () => { tab = 'signup'; render(); });

  forgot.addEventListener('click', async () => {
    if (!validEmail(email.value.trim())) { say('Enter your email address above first.', true); email.focus(); return; }
    try {
      await cloud.recover(email.value.trim());
      say('If an account exists for this address, we sent a link to reset the password. Open it in this browser.');
    } catch (e) { say(e instanceof Error ? e.message : String(e), true); }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const address = email.value.trim();
    if (!validEmail(address)) { say('Enter a valid email address.', true); email.focus(); return; }
    if (password.value.length < MIN_PASSWORD) { say(`The password needs at least ${MIN_PASSWORD} characters.`, true); password.focus(); return; }
    submit.disabled = true;
    say(tab === 'signin' ? 'Signing in…' : 'Creating your account…');
    try {
      if (tab === 'signin') {
        await cloud.signIn(address, password.value);
        password.value = '';
        hooks.onSignedIn();
      } else if (await cloud.signUp(address, password.value)) {
        password.value = '';
        say(`Almost done: we sent a confirmation link to ${address}. Open it, then come back and sign in.`);
        tab = 'signin';
        tabIn.setAttribute('aria-selected', 'true');
        tabUp.setAttribute('aria-selected', 'false');
        submit.textContent = 'Sign in';
        forgot.hidden = false;
      } else {
        password.value = '';
        hooks.onSignedIn();
      }
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    } finally {
      submit.disabled = false;
    }
  });

  root.append(
    tabs,
    provider('google', 'Continue with Google', GOOGLE_SVG),
    provider('github', 'Continue with GitHub', GITHUB_SVG),
    el('div', { class: 'or' }, 'or with your email'),
    form, msg, err,
    el('p', { class: 'hint' }, 'Signing in with Google or GitHub uses the same account as your email when the address matches. Your files never pass through the account service.'),
  );
  render();
  return root;
}
