// Must be the first import of main.ts. GitHub Pages cannot send X-Frame-Options or CSP frame-ancestors,
// so refuse to run inside a frame (clickjacking: a hostile page could overlay buttons on our UI).
if (window.self !== window.top) {
  document.documentElement.replaceChildren();
  const body = document.createElement('body');
  const p = document.createElement('p');
  p.textContent = 'For your safety this app does not run inside another page. Open it in its own browser tab.';
  p.style.cssText = 'font:16px system-ui,sans-serif;padding:24px';
  body.append(p);
  document.documentElement.append(body);
  throw new Error('Prism refuses to run inside a frame.');
}
export {};
