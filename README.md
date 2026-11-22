# Prism web

A free, online replacement for Prism: edit LaTeX projects in the browser and compile them with full TeX Live.
Design: static web app on GitHub Pages + a private GitHub repo for the projects + GitHub Actions for compiling.
Security and privacy: see [SECURITY.md](SECURITY.md).

| Part | Where | Cost |
|---|---|---|
| Web app (this folder) | GitHub Pages, from a **public** repo `prism-latex/prism-app` in its **own organisation** (own web address `prism-latex.github.io`; code only, no thesis content) | free |
| Projects | **private** repo (for example `prism-data`) with all projects + `prism-projects.json` | free |
| Compiler | GitHub Actions in that repo (`compile.yml`, full TeX Live container, latexmk, BibTeX/Biber) | free allowance for private repos |

## What it does

**Start screen** — all your projects as cards (name, engine, "edited … ago", unsaved-changes badge) with search and sorting.
Click a card to open it; the brand or the *Projects* button brings you back. Per project: **rename**, **duplicate**,
**download as ZIP**, **delete** (all stay local until you Save; Git history keeps old versions). **New project** starts from a
template (Article, Article with bibliography, Report/thesis, Beamer slides, Letter, Greek article, TikZ/PGFPlots figures,
code listings, Blank — each compiled on GitHub before release). **Upload ZIP** imports an existing project: a wrapper
folder is removed, junk skipped, the main file and the engine (pdfLaTeX / XeLaTeX / LuaLaTeX) are detected.

**Editing** — file tree; CodeMirror editor with LaTeX highlighting, search (Ctrl+F), word count, optional
spell-check; auto-completion for commands, environments, `\ref{…}` labels, `\cite{…}` keys and file names; **ready-made
blocks** (type `\figure`, `\table`, `\equation`, `\align`, `\itemize`, `\enumerate`, `\frame`, `\tikz`, `\plot`, `\code`,
`\theorem` and press Enter, then Tab through the blanks); image preview (click to toggle actual size); upload, new file,
rename/move, delete, download.

**Compiler settings (you choose, and it really changes)** — *Compiler* on the start screen: the **TeX Live version**
(latest, or any frozen year 2025 … 2013 — the same document then compiles exactly as in that year) and the **time limit**
(1–40 minutes). They are saved as `prism-compiler.json` in your repository; no workflow editing and no extra token permission
needed. Per project (*Project settings*): engine, main file, **clean build**, **extra latexmk options**, `.latexmkrc`, shell
escape. After a compile the bar shows the TeX Live year that was used and the exact latexmk command (hover). Verified on
real GitHub runners: choosing 2024 compiled with TeX Live 2024, latest with 2026, an invalid hand-written value falls back to
latest, unsafe extra options are rejected, and a 1-minute limit stopped a 200-second job.

**What LaTeX can do here** — the compile container is a complete TeX Live: pdfLaTeX, XeLaTeX, LuaLaTeX, BibTeX and Biber
(BibLaTeX), makeindex, TikZ/PGFPlots, Beamer, polyglossia/Greek, `minted` code highlighting, any package TeX Live ships. In *Project
settings*: **use the project's `.latexmkrc`** (needed for glossaries/acronyms and custom build steps) and **allow shell
escape** (packages that run programs, for example pythontex). Both only run inside the isolated container.
Not available: programs that are not in TeX Live (Inkscape for the `svg` package, Python libraries, Typst, Pandoc).

**Navigating** — *Outline* of chapters and sections across `\input`/`\include` files; *Search* in the whole project
(Ctrl+Shift+F, plain or regular expression) with **Replace all** (stays local until you Save); *File history* with a coloured comparison and one-click restore.

**PDF** — selectable text; clickable table of contents, cross references, citations and URLs; page box ("12 / 170", type a
number to jump); zoom; download. **Stop** cancels a running compile.
**SyncTeX both ways:** double-click in the PDF (or Ctrl/Cmd+click, see Preferences) to jump to the source line;
"Show this line in the PDF" (button or Ctrl+Alt+J) scrolls to and highlights the spot; optionally the PDF follows the cursor.

**Saving and compiling** — **Save** (Ctrl+S) is one commit. If the branch changed elsewhere (Codex, Claude, another
device), edits to different files are merged; for the same file the app asks which version to keep — never a silent
overwrite. Unsaved text survives a reload. **Compile** (Ctrl+Enter) saves, runs the workflow and shows the PDF and a log
with clickable errors. Returning to the tab loads changes pushed from elsewhere.

**Other** — light/dark/system theme, font size, resizable panels, phone layout, passphrase-encrypted token storage, and an optional **token expiry reminder**: enter the date you chose on GitHub and the app warns you 10 days before it ends.

**Convenience and safety nets** — drag files onto the file list to upload them (drop a ZIP on the start screen to import a
project); Ctrl+B / Ctrl+I bold and emphasis; the **?** button lists every shortcut; if your token stops working a red banner
explains it and your edits stay in the browser; offline and unexpected-error messages instead of silence.

Not included: real-time co-editing, in-browser compiling, AI chat.

## Fair use and rules

* **GitHub Actions** is meant for building and testing what is in the repository. Compiling your own documents in the
  repository that holds them is that kind of use. GitHub's terms say Actions must not be used as a general serverless
  service or content-delivery network and may be restricted if abused; keep the compile workflow for your own documents and
  do not point it at unrelated heavy computation. Free private repositories get a monthly allowance of minutes (2,000 at the
  time of writing); a compile of a typical document takes under a minute, a 170-page thesis about half a minute.
* **GitHub Pages** hosts the app: published sites are limited to 1 GB and about 100 GB of traffic a month, and Pages is not for
  commercial transactions or for sending passwords or card numbers. The app is a static page; your token never leaves your
  browser except to `api.github.com`.
* Summary written on 22 November 2026 from GitHub's public pages
  ([additional terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features),
  [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)); the current text on
  those pages is what counts.
* Licences of the bundled software: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Set up your own repository (you or a friend) — about two minutes, no command line

Everybody uses **their own** repository: GitHub does not let a fine-grained token use someone else's personal
repository. (A shared repository would need a GitHub organisation.)

1. On GitHub, create a **private** repository, for example `prism-data`, and tick **Add a README file**.
2. Create a **fine-grained token** (GitHub → Settings → Developer settings → Fine-grained tokens): repository access =
   only that repository; permissions = **Contents**, **Actions** and, for the first setup only, **Workflows** — all *Read and write*.
3. Open the app → *Connect* → enter owner, repository, branch and token. Pick "Encrypted with a passphrase".
4. The app shows a banner "not set up for compiling yet" → **Set up**. It commits the compile workflow and an empty
   project list (the app carries these files itself). Afterwards remove the *Workflows* permission from the token.
5. Create a project with **New project** (pick a template), or **Upload ZIP**. Name the token anything you like, for example `Prism app`.

To import existing projects use `New-PrismDataRepo.ps1` (see below) or upload files in the app.

## Maintainer notes

```powershell
npm install
npm test          # unit tests
npm run build     # type-check + production build into dist/
npm run preview   # serve dist/ locally
```

Requires Node 18+ locally (CI uses Node 20). `data-repo/` holds the files every projects repository needs
(`compile.yml`, `compile.sh`, `.gitignore`); the app bundles them, so `setup.ts` and `data-repo/` stay in sync.
Changing them makes every repository show "newer workflow available" until its owner presses **Set up** again.

The compile script can be tested locally with MiKTeX from Git Bash: `bash .github/scripts/compile.sh "<Project>" out`
inside a projects-repo checkout.

`New-PrismDataRepo.ps1 -Destination <folder>` copies the migrated Prism projects (following the thesis junction),
verifies every file by SHA-256, writes the manifest and makes one local commit — it never pushes.

## Working locally (you, Codex, Claude)

Clone the projects repository, `git pull` before editing and `git push` after. The web app sees pushes on refresh.
Build output of online compiles is stored on branches `builds/<id>` (one commit each, replaced on every compile).
