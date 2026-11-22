# Prism web

A free, online replacement for Prism: edit LaTeX projects in the browser and compile them with full TeX Live.
Design: static web app on GitHub Pages + a private GitHub repo for the projects + GitHub Actions for compiling.

| Part | Where | Cost |
|---|---|---|
| Web app (this folder) | GitHub Pages, from a **public** repo `prism-app` (code only, no thesis content) | free |
| Projects | **private** repo `prism-data` (all migrated projects + `prism-projects.json`) | free |
| Compiler | GitHub Actions in `prism-data` (`compile.yml`, full TeX Live container, latexmk, BibTeX/Biber) | free allowance for private repos |

## What it does

- Project list from `prism-projects.json`; new project; project settings (main file, engine).
- File tree; edit text files (CodeMirror, LaTeX highlighting, search with Ctrl+F); view images; upload, new file, rename/move, delete, download, project ZIP.
- **Save** (Ctrl+S) = one commit. If the branch changed elsewhere (Codex, Claude, another device), different files are merged automatically; for the same file the app asks which version to keep. Nothing is overwritten silently.
- Unsaved text edits are kept in this browser and restored on reload.
- **Compile** (Ctrl+Enter) saves, runs `compile.yml`, then shows the PDF (pdf.js) and the log with clickable errors.
- Coming back to the tab loads changes pushed from elsewhere.

Not included: real-time multi-user editing, SyncTeX click-to-source, PDF text selection, AI chat, in-browser compile.

## One-time setup

You need a GitHub account and the GitHub CLI (`winget install --id GitHub.cli`, then `gh auth login`).

1. **Create the data repo locally** (copies and hash-verifies all projects; pushes nothing):
   ```powershell
   .\New-PrismDataRepo.ps1 -Destination "$env:USERPROFILE\prism-data"
   ```
2. **Upload it as a private repo:**
   ```powershell
   cd "$env:USERPROFILE\prism-data"
   gh repo create prism-data --private --source . --push
   ```
3. **Publish the app** from this folder as a public repo and enable Pages with GitHub Actions:
   ```powershell
   git init -b main; git add -A; git commit -m "Prism web"
   gh repo create prism-app --public --source . --push
   gh api -X POST "repos/{owner}/prism-app/pages" -f build_type=workflow
   ```
   The `deploy` workflow then builds and publishes `https://<user>.github.io/prism-app/`.
4. **Create a token**: GitHub → Settings → Developer settings → Fine-grained tokens → Generate.
   Repository access: *Only select repositories* → `prism-data`. Permissions: **Contents: Read and write**, **Actions: Read and write** (Metadata: read is added automatically). Choose an expiry (for example 90 days).
5. Open the app, enter owner, `prism-data`, `main` and the token.

## Security

- The token is stored only in the browser's local storage. Anyone with access to that browser profile can use it. Use **Forget token** on shared computers; revoke it on GitHub if lost.
- The page loads no third-party code (Content-Security-Policy `script-src 'self'`, only `api.github.com` is contacted).
- The app warns if the data repo is public. Keep it private.
- Compiles run with shell escape restricted (TeX Live default) inside a throwaway container.

## Working locally (you, Codex, Claude)

Clone `prism-data`, `git pull` before editing and `git push` after. The web app sees pushes on refresh.
Build output of online compiles is stored on branches `builds/<id>` (one commit each, replaced on every compile).

## Development

```powershell
npm install
npm test          # unit tests (log parsing, text round trip, save/merge/conflict logic)
npm run build     # type-check + production build into dist/
npm run preview   # serve dist/ locally
```

Requires Node 18+. The compile script can be tested locally with MiKTeX from Git Bash:
`bash .github/scripts/compile.sh "<Project>" out` inside a data-repo checkout.
