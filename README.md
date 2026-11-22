# Prism web

A free, online replacement for Prism: edit LaTeX projects in the browser and compile them with full TeX Live.
Design: static web app on GitHub Pages + a private GitHub repo for the projects + GitHub Actions for compiling.
Security and privacy: see [SECURITY.md](SECURITY.md).

| Part | Where | Cost |
|---|---|---|
| Web app (this folder) | GitHub Pages, from a **public** repo `prism-app` (code only, no thesis content) | free |
| Projects | **private** repo (for example `prism-data`) with all projects + `prism-projects.json` | free |
| Compiler | GitHub Actions in that repo (`compile.yml`, full TeX Live container, latexmk, BibTeX/Biber) | free allowance for private repos |

## What it does

**Editing** — project list; file tree; CodeMirror editor with LaTeX highlighting, search (Ctrl+F), word count, optional
spell-check; auto-completion for commands, environments, `\ref{…}` labels, `\cite{…}` keys and file names; image preview
(click to toggle actual size); upload, new file, rename/move, delete, download, project ZIP.

**Navigating** — *Outline* of chapters and sections across `\input`/`\include` files; *Search* in the whole project
(Ctrl+Shift+F, plain or regular expression); *File history* with a coloured comparison and one-click restore.

**PDF** — selectable text; clickable table of contents, cross references, citations and URLs; zoom; download.
**SyncTeX both ways:** double-click in the PDF (or Ctrl/Cmd+click, see Preferences) to jump to the source line;
"Show this line in the PDF" (button or Ctrl+Alt+J) scrolls to and highlights the spot; optionally the PDF follows the cursor.

**Saving and compiling** — **Save** (Ctrl+S) is one commit. If the branch changed elsewhere (Codex, Claude, another
device), edits to different files are merged; for the same file the app asks which version to keep — never a silent
overwrite. Unsaved text survives a reload. **Compile** (Ctrl+Enter) saves, runs the workflow and shows the PDF and a log
with clickable errors. Returning to the tab loads changes pushed from elsewhere.

**Other** — light/dark/system theme, font size, resizable panels, phone layout, passphrase-encrypted token storage.

Not included: real-time co-editing, in-browser compiling, AI chat, replace-in-project.

## Set up your own repository (you or a friend) — about two minutes, no command line

Everybody uses **their own** repository: GitHub does not let a fine-grained token use someone else's personal
repository. (A shared repository would need a GitHub organisation.)

1. On GitHub, create a **private** repository, for example `prism-data`, and tick **Add a README file**.
2. Create a **fine-grained token** (GitHub → Settings → Developer settings → Fine-grained tokens): repository access =
   only that repository; permissions = **Contents**, **Actions** and, for the first setup only, **Workflows** — all *Read and write*.
3. Open the app → *Connect* → enter owner, repository, branch and token. Pick "Encrypted with a passphrase".
4. The app shows a banner "not set up for compiling yet" → **Set up**. It commits the compile workflow and an empty
   project list (the app carries these files itself). Afterwards remove the *Workflows* permission from the token.
5. Create a project with **+**, or upload files.

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
