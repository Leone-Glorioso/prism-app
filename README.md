# LeoTeX

A free online LaTeX editor. Write in the browser, compile with a complete TeX Live, keep every project in your own private
GitHub repository. No server to run, nothing to install.

**Live site:** <https://prism-latex.github.io/prism-app/> · **Licence:** [MIT](LICENSE) · **Security and privacy:** [SECURITY.md](SECURITY.md) ·
**Full guide (PDF):** [docs/LeoTeX-Guide.pdf](docs/LeoTeX-Guide.pdf)

| Part | Where | Cost |
|---|---|---|
| The app (this repository) | GitHub Pages, from a **public** repository in its **own organisation** (own web address; code only, no project content) | free |
| Your projects | a **private** repository of yours (for example `prism-data`) with all projects and `prism-projects.json` | free |
| The compiler | GitHub Actions in that private repository: full TeX Live container, latexmk, BibTeX/Biber | free allowance for private repositories |
| Accounts (optional) | a free [Supabase](https://supabase.com) project that you own: email/password, Google, GitHub sign-in, settings sync | free |

The name: *LeoTeX*, written like TeX with a lowered E. The repository, organisation and file names (`prism-app`,
`prism-latex`, `prism-data`, `prism-projects.json`, `prism-compiler.json`) are historical and stay as they are.

## What it does

**Start page and accounts** — a signed-out visitor sees a landing page with sign-in. With an account (optional) you can
sign in with **email and password, Google or GitHub**; your profile, settings, shortcuts and, if you choose, your GitHub
connection come along to every browser. Without an account everything works exactly as before: connect once with a token.

**Projects** — cards with name, engine, "edited … ago" and an unsaved badge; search and sorting. Per project: rename,
duplicate, download as ZIP, delete (all stay local until you Save; Git history keeps old versions). **New project** starts from
a template (Article, Article with bibliography, Report/thesis, Beamer slides, Letter, Greek article, TikZ/PGFPlots figures, code
listings, Blank — each compiled on GitHub before release). **Upload ZIP** imports an existing project (wrapper folder removed,
junk skipped, main file and engine detected).

**Writing, with real help**
* **Suggestions while you type.** Type `\cite` **or `/cite`** and pick a command. `\cite{` then lists the entries of your `.bib`
  files with author, year and title (search by key, author, title or year; the title shows beside the list). Picking a
  command inserts its arguments with blanks to fill (Tab moves on) and opens the next list: `\usepackage{` offers packages,
  `\documentclass{`, `\bibliographystyle{`, `\usetikzlibrary{`, `\ref{` your labels, `\includegraphics{` your images,
  `\input{` your files, `\bibliography{` / `\addbibresource{` your `.bib` files.
* `\begin{` offers environments and **writes the matching `\end{…}`**; `\end{` suggests the environment that is still open.
* More than 400 commands and symbols (Greek letters and operators shown with their glyph), and ready-made blocks: type
  `\figure`, `\table`, `\equation`, `\align`, `\itemize`, `\enumerate`, `\frame`, `\tikz`, `\plot`, `\code`, `\theorem`.
* CodeMirror editor with LaTeX highlighting, search (Ctrl+F), word count, optional spell-check, image preview, file tree, upload,
  rename/move, delete, download, drag and drop.

**Speed** — a compile has a fixed start-up cost: GitHub must start a machine and download TeX Live (the full image takes about 90 seconds, the medium one about 15). With the default "latest" setting LeoTeX tries the small image first and uses the full one only when something is missing, and remembers that per project; simple documents then finish in under a minute, documents that need the full TeX Live take about two minutes. The status bar shows compile time and total time. Frozen TeX Live years always use the full image.

**Compiler settings (you choose, and it really changes)** — *Compiler* on the start page: the **TeX Live version** (latest or any
frozen year 2025 … 2013) and the **time limit** (1–40 min), saved as `prism-compiler.json`. Per project: engine, main file, clean
build, extra latexmk options, `.latexmkrc`, shell escape. After a compile the bar shows the TeX Live year used and the exact
command. Verified on real GitHub runners (2024 compiled with TeX Live 2024, latest with 2026, an invalid hand-written value
falls back, unsafe options are rejected, a 1-minute limit stopped a 200-second job).

**What LaTeX can do here** — a complete TeX Live: pdfLaTeX, XeLaTeX, LuaLaTeX, BibTeX and Biber, makeindex, TikZ/PGFPlots, Beamer,
polyglossia/Greek, `minted`, any package TeX Live ships. Not available: programs outside TeX Live (Inkscape for `svg`, Python
libraries, Typst, Pandoc).

**Navigating** — outline across `\input`/`\include` files; search in the whole project (Ctrl+Shift+F, plain or regular expression)
with replace all; file history with coloured comparison and restore.

**PDF** — selectable text; clickable contents, references, citations, URLs; page box; zoom; download; Stop button. **SyncTeX both
ways:** double-click in the PDF to jump to the source line; "Show this line in the PDF" scrolls to and highlights the spot.

**Saving** — **Save** is one commit. If the branch changed elsewhere (Codex, Claude, another device), edits to different files are
merged; for the same file the app asks which version to keep, never overwriting silently. Unsaved text survives a reload.

**Settings page** (avatar menu → Settings)
* **Profile:** display name and picture (shrunk to 160 × 160 in your browser).
* **Appearance:** light / dark / system, seven accent colours, editor font and size.
* **Editor:** suggestions on/off, line numbers, line wrapping, spell-check and language, PDF click behaviour, PDF follows cursor.
* **Shortcuts:** change any of nine shortcuts (save, compile, show line in PDF, search project, projects, settings, bold, emphasis,
  inline math). Keys the browser needs are refused; clashes are reported. Defaults: Ctrl+S, Ctrl+Enter, Ctrl+Alt+J,
  Ctrl+Shift+F, Ctrl+Alt+H, Ctrl+, , Ctrl+B, Ctrl+I, Ctrl+Alt+M (Cmd on a Mac).
* **Connection:** repository, branch, how the token is kept, expiry date, *Clear this browser*.
* **Account:** sign in/out, save or remove the GitHub connection in your account, change password, delete account.

## Set up your own repository (two minutes, no command line)

Everybody uses **their own** repository: GitHub does not let a fine-grained token use someone else's personal repository.

1. On GitHub create a **private** repository, for example `prism-data`, and tick **Add a README file**.
2. Create a **fine-grained token** (GitHub → Settings → Developer settings → Fine-grained tokens): repository access = only that
   repository; permissions **Contents**, **Actions** and, for the first setup only, **Workflows** — all *Read and write*.
3. Open the app → *Connect* → owner, repository, branch, token. Choose how the token is kept (encrypted with a passphrase is the
   most careful). Optionally enter the token's expiry date: the app warns 10 days before it ends.
4. The banner "not set up for compiling yet" → **Set up**. It commits the compile workflow and an empty project list. Afterwards
   remove the *Workflows* permission from the token.
5. **New project** (pick a template) or **Upload ZIP**.

## Accounts (optional): so a new browser does not ask for the token

Without accounts, each new browser needs the repository and token typed once. With accounts you sign in instead. The app has no
server, so accounts use a free **Supabase** project that *you* own and that only stores a small record per person.

**What is stored there:** email, a hashed password (or the Google/GitHub identity), display name, picture, preferences,
shortcuts and — only if you press *Save my connection to my account* — your repository and token, in one of two ways you choose:
**sign-in only** (stored readable in your service project: a new browser opens your projects right after sign-in; whoever gets into that
account or steals your session gets the token) or **with a passphrase** (encrypted in your browser first, AES-256-GCM, PBKDF2 600,000 rounds; the
service cannot read it; a new browser needs sign-in plus the passphrase). **Your project files never touch the account service.** No third-party script runs in the page: sign-in
is plain requests to that one service address (the page's security policy allows exactly that address and `api.github.com`).

**Owner's one-time setup** (about 15 minutes):

1. Create a free project at <https://supabase.com> (choose a region near you). Keep the database password somewhere safe; the app does not use it.
2. *SQL Editor* → new query → paste [`supabase/setup.sql`](supabase/setup.sql) → Run. (Creates the table with row-level security, the
   delete-account function and a harmless `ping` function.)
3. *Project Settings → API*: copy the **Project URL** and the **anon / publishable** key. **Never** use the `service_role` / secret key; the build refuses it.
4. *Authentication → URL Configuration*: Site URL `https://prism-latex.github.io/prism-app/`; add the same address to *Redirect URLs*
   (and `http://localhost:5173/` if you develop locally).
5. *Authentication → Providers*: **Email** on (keep "Confirm email" on). **GitHub**: on GitHub → Settings → Developer settings → OAuth Apps → *New*;
   homepage `https://prism-latex.github.io/prism-app/`, callback `https://<project-ref>.supabase.co/auth/v1/callback`; paste its Client ID and
   secret into Supabase. **Google**: Google Cloud Console → APIs & Services → Credentials → *OAuth client ID* (Web application), authorised redirect
   URI `https://<project-ref>.supabase.co/auth/v1/callback`; paste Client ID and secret into Supabase.
6. In this repository create `cloud.config.json` next to `package.json`:
   ```json
   { "url": "https://<project-ref>.supabase.co", "anonKey": "<the public key>" }
   ```
   Commit and push. The Pages workflow rebuilds; the settings page then shows accounts as available. Without this file the app is built
   without accounts and nothing else changes.

Notes: Google and GitHub sign-in link to the same account as an email sign-in when the verified address matches. The built-in Supabase
email sender is rate-limited (a few messages an hour); add your own SMTP in Supabase for more. A weekly workflow
(`keepalive.yml`) sends one harmless request so a free project does not pause (GitHub switches scheduled workflows off after 60 days without
any repository activity; run it by hand or push anything to wake it).

## Fair use and rules

* **GitHub Actions** is for building what is in the repository; compiling your own documents in the repository that holds them is that use.
  Do not use the workflow as a general serverless service or content-delivery network. Free private repositories get a monthly allowance of
  minutes (2,000 at the time of writing); a typical document compiles in under a minute, a 170-page thesis in about half a minute.
* **GitHub Pages** hosts the app: published sites are limited to 1 GB and about 100 GB of traffic a month and are not for commercial
  transactions. Summary written on 22 November 2026 from GitHub's public pages
  ([additional terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features),
  [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)); the current text there is what counts.
* Licences of the bundled software: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Maintainer notes

```powershell
npm install
npm test          # unit tests (85)
npm run build     # type-check + production build into dist/
npm run preview   # serve dist/ locally
```

Node 18+ locally (CI uses Node 20). `data-repo/` holds the files every projects repository needs (`compile.yml`, `compile.sh`,
`.gitignore`); the app bundles them. Changing them makes every repository show "newer workflow available" until its owner presses
**Set up** again. To test accounts without a real project, build with `LEOTEX_CLOUD_CONFIG=<file>` pointing at a local test service
(`http://127.0.0.1:<port>` is allowed for tests only).

`New-PrismDataRepo.ps1 -Destination <folder>` copies migrated Prism projects (following the thesis junction), verifies every file by
SHA-256, writes the manifest and makes one local commit — it never pushes.

**Working locally (you, Codex, Claude):** clone the projects repository, `git pull` before editing, `git push` after. The web app sees
pushes on refresh. Online compiles are stored on `builds/<id>` branches (one commit each, replaced on every compile).
