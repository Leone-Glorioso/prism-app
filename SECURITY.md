# Security and privacy notes

Prism web has no server of its own. The page is static (GitHub Pages); your files live in **your own private GitHub
repository**; compiling runs in **GitHub Actions** in that repository. This file states what protects what, what was
checked, and what is left.

## Who can see what

| Data | Where it is | Who can read it |
|---|---|---|
| Your LaTeX files, PDFs, logs | your private repo `prism-data` (and `builds/*` branches in it) | you, and anyone you add to the repo. **Keep the repo private**: the app warns when it is public. |
| The app code | public repo `prism-app` / GitHub Pages | everyone. It contains no personal data and no thesis content. |
| Your token | this browser only | see below |
| Unsaved drafts | this browser only (same storage mode as the token) | see below |

The app contacts only `api.github.com` (enforced by the page's Content-Security-Policy). No analytics, no third-party
scripts, no CDN. The token is sent only in the `Authorization` header, never in a URL.

## The token

Use a **fine-grained** personal access token restricted to the one repository, with Contents and Actions
(read and write). A stolen token can then read and change that repository's files and start compiles — nothing else.
It cannot change workflow files (that needs the separate *Workflows* permission, which you only need for the first
setup) and it cannot reach your other repositories. The app asks for confirmation if you enter a **classic** token
(it detects them) because those reach all your repositories.

Three ways to keep it in the browser (Connection and security → "Keep the token in this browser"):

1. **On this device** — plain text in `localStorage`. Convenient; readable by any script running on the same site address.
2. **Encrypted with a passphrase** (recommended) — AES-256-GCM, key from PBKDF2-SHA256 (600,000 iterations); the
   passphrase is asked after each restart and the key lives only in memory. Drafts are encrypted too. A wrong passphrase
   or tampered data is rejected. There is no recovery if you forget the passphrase: connect again with a new token.
3. **Only until the tab closes** — `sessionStorage`, wiped when the tab is closed.

The connection window also takes the token's expiry date (optional, not secret); the app then shows a banner from 10 days before it ends. "Clear this browser" removes the token, drafts and preferences. Revoke a token on GitHub (Settings → Developer
settings) if a device is lost.

### Sites on the same address share browser storage (handled by giving the app its own address)

GitHub Pages gives every repository of an account or organisation the same web address (`<name>.github.io`). Browser
storage and scripts are shared by everything served from one address, so another Pages site there could read a token
stored "on this device" (plain). **This app therefore lives alone in its own GitHub organisation**
(`prism-latex.github.io/prism-app/`). Keep it that way: do not publish any other Pages site from that organisation.
Put other websites in a different organisation or account, and give any future app that stores secrets its own
organisation too. Organisations are free. (A custom domain per site would be the paid alternative.)

## Compile isolation

Your TeX code is treated as untrusted. The compile job runs it in a container with: **no network**
(`--network none`), **no Linux capabilities** (`--cap-drop ALL`), `no-new-privileges`, **non-root user**, memory and
process limits, TeX Live's default restricted shell escape, and **no job token in the container** (the checkout does not
persist credentials). The result is published to a `builds/*` branch by a separate step. Workflows can only use GitHub's
own actions, pinned to commit hashes (the repository requires SHA pinning). A project name coming from the app is passed
as an environment variable, never pasted into a shell command, and the main file must live inside that project's folder.

## Conflicts and "locking"

There are no pessimistic locks. Saving is **fast-forward only**: if the branch moved since you opened a file (Codex,
Claude, another device or tab), changes to *different* files are merged automatically; for the *same* file the app stops
and asks which version to keep — it never overwrites silently. Git keeps every older version (File history → restore).
Compiles of one project cancel each other (newest wins).

## Page hardening

* Content-Security-Policy: `default-src 'none'`; scripts only from the same origin; `connect-src` only `api.github.com`;
  no frames, no forms, no inline scripts. (Inline *styles* are allowed because CodeMirror needs them.)
* GitHub Pages cannot send `X-Frame-Options`/`frame-ancestors`, so the app refuses to run inside a frame (clickjacking).
* All file names, log lines and PDF text are inserted as text, never as HTML. PDF links are limited to `http`, `https`
  and `mailto`; SVG images are shown through `<img>` (scripts in SVG do not run).
* `Referrer-Policy: no-referrer`; links to GitHub open with `noopener`.

## Checked on 22 November 2026

* Unit tests (48): token vault round trip, wrong passphrase, tampering, fresh IV; token never in URL; save/merge/conflict
  logic; path validation; SyncTeX; log parsing.
* Real GitHub run of the hardened compile job on the thesis, an XeLaTeX+Biber project and a pdfLaTeX project: all `ok`;
  thesis identical to the earlier build (170 pages, 66 warnings).
* `npm audit` for the shipped code: 0 vulnerabilities. Six advisories remain in **development-only** tools (vite/vitest
  dev server and test runner); they are not part of the published site, and fixing them needs Node 20+ locally.
* Repository `prism-data`: private; allowed Actions limited to GitHub-owned; SHA pinning required.
  Repository `prism-app`: secret scanning with push protection, Dependabot alerts/security updates enabled.

## Not covered

* Anyone who has your token (or your unlocked browser) has full read/write access to that repository.
* Browser extensions and malware on your computer can read what the page can read.
* GitHub itself (and its policies, outages and free-tier limits) is a dependency.
* The TeX Live container image is `texlive/texlive:latest`, pulled at compile time.
* The data repo is only as private as its settings: do not make it public.
