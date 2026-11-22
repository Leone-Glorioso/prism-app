import './guard'; // must stay first: refuses to run inside a frame
import './style.css';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { zipSync } from 'fflate';
import { GitHub, GitHubError } from './github';
import { Workspace, ConflictError } from './workspace';
import { compile, fetchBuild, Build, CompileCancelled } from './compile';
import { PdfView, PdfPoint } from './pdfview';
import { createState, createView, currentLine, EditorEnv, goToLine } from './editor';
import * as store from './storage';
import { applyIcons, icon } from './icons';
import { applyPrefs, isDark, loadPrefs, Prefs, sanitize, savePrefs } from './prefs';
import { forward, inverse, mapInputs, parseSynctexFile, SyncTex } from './synctex';
import { ProjectIndex } from './projectindex';
import { projectOutline, wordCount } from './outline';
import { replaceInTexts, searchTexts } from './search';
import { daysLeft, expiryState } from './expiry';
import { diffLines } from './diff';
import { citeKeysIn, completionSource, labelsIn } from './complete';
import { SETUP_FILES, setupStatus } from './setup';
import { TEMPLATES, templateById } from './templates';
import {
  COMPILER_FILE, CompilerConfig, defaultCompilerConfig, isTexliveChoice, MAX_TIMEOUT_MINUTES, parseCompilerConfig, serializeCompilerConfig,
  TEXLIVE_YEARS, texliveFromLog, validLatexmkArgs,
} from './compiler';
import { guessEngine, MAX_ZIP_BYTES, nameFromFile, pickMainFile, readZip, timeAgo, uniqueName } from './projects';
import { WrongPassphrase } from './vault';
import {
  applyEol, cleanPath, decodeText, detectEol, dirname, encodeText, Eol, formatBytes, imageType, isTexLike, joinPath,
  parseLog, resolveLogPath,
} from './util';

applyIcons();

// ---------- Types and state ----------

interface ManifestEntry {
  Project: string;
  MainFile: string;
  Engine: string;
  Bibliography?: string;
  [key: string]: unknown;
}
interface OpenFile { state: EditorState; original: string; eol: Eol }
interface SyncState { tex: SyncTex; map: Map<number, string>; tagsByPath: Map<string, Set<number>> }

const MANIFEST = 'prism-projects.json';
const MAX_UPLOAD = 50 * 1024 * 1024;

let settings: store.Settings | null = null;
let prefs: Prefs = loadPrefs();
let gh: GitHub | null = null;
let ws: Workspace | null = null;
let index: ProjectIndex | null = null;
let manifest: ManifestEntry[] = [];
let project: ManifestEntry | null = null;
let current: string | null = null; // open file path
let selected: string | null = null; // selected tree item (file path or folder path ending with "/")
const open = new Map<string, OpenFile>();
const expanded = new Set<string>();
let compileSeq = 0;
let compiling = false;
let currentRunId: number | null = null;
let authProblem = false;
let lastBuild: Build | null = null;
let previewUrl: string | null = null;
let sideTab: 'files' | 'outline' | 'search' = 'files';
let outlineTexts = new Map<string, string>();
let completionLabels: string[] = [];
let completionCites: string[] = [];
let completionFiles: string[] = [];
const syncCache = new WeakMap<Build, Promise<SyncState | null>>();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const view: EditorView = createView($('editor'));
const pdf = new PdfView($('pdf'));
pdf.jumpMode = prefs.pdfJump;
pdf.onChange = () => { renderBuildInfo(); setEnabled(); };
pdf.onJump = (pt) => void jumpToSource(pt);

// ---------- Small UI helpers ----------

function setStatus(text: string, kind: 'info' | 'error' | 'busy' = 'info') {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
  if (kind === 'error') console.error(text);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const projectRoot = () => (project ? project.MainFile.replace(/\\/g, '/').split('/')[0] : '');
const mainPath = () => (project ? project.MainFile.replace(/\\/g, '/') : '');
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const relative = (path: string) => path.slice(projectRoot().length + 1);

function setEnabled() {
  const connected = !!ws;
  const hasProject = connected && !!project;
  for (const id of ['project', 'new-project', 'home-btn']) ($(id) as HTMLButtonElement).disabled = !connected;
  for (const id of ['project-settings', 'new-file', 'upload-btn', 'zip', 'refresh']) ($(id) as HTMLButtonElement).disabled = !hasProject;
  const fileSelected = hasProject && !!selected && !selected.endsWith('/');
  ($('rename') as HTMLButtonElement).disabled = !hasProject || !selected;
  ($('delete') as HTMLButtonElement).disabled = !hasProject || !selected;
  ($('download') as HTMLButtonElement).disabled = !fileSelected;
  ($('save') as HTMLButtonElement).disabled = !ws?.dirty;
  $('save').querySelector('.label')!.textContent = ws?.dirty ? `Save (${ws.changes.size})` : 'Save';
  $('welcome').hidden = !!ws;
  $('editor-empty').hidden = !!current;
  $('pdf-empty').hidden = pdf.hasDocument || $('pdf').hidden;
  ($('compile') as HTMLButtonElement).disabled = !hasProject;
  ($('download-pdf') as HTMLButtonElement).disabled = !lastBuild?.pdf;
  $('compile').querySelector('.label')!.textContent = compiling ? 'Stop' : 'Compile';
  $('compile').title = compiling ? 'Stop waiting and cancel this compile' : 'Save and compile (Ctrl+Enter)';
  $('compile').classList.toggle('danger-solid', compiling);
  ($('forward') as HTMLButtonElement).disabled = !(lastBuild?.pdf && current && !view.dom.hidden);
  ($('history') as HTMLButtonElement).disabled = !(current && ws?.files.has(current));
  if (!current) {
    $('empty-title').textContent = hasProject ? 'No file open' : connected ? 'No projects yet' : 'Not connected';
    $('empty-text').textContent = hasProject ? 'Choose a file from the list on the left.' : connected ? 'Create one with the + button at the top.' : 'Connect your repository first.';
  }
}

function download(name: string, bytes: Uint8Array, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function showBanner(text: string, actionLabel?: string, action?: () => void, kind: 'warn' | 'error' = 'warn') {
  const b = $('banner');
  $('banner-text').textContent = text;
  const btn = $<HTMLButtonElement>('banner-action');
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel ?? '';
  btn.onclick = action ?? null;
  b.dataset.kind = kind;
  b.hidden = false;
}
const hideBanner = () => { $('banner').hidden = true; };

// ---------- Drafts (unsaved text kept in this browser) ----------

let draftTimer = 0;
function persistDrafts() {
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(async () => {
    if (!settings || !ws) return;
    const drafts: store.Drafts = {};
    for (const [path, c] of ws.changes) {
      if (c.kind !== 'put') continue;
      const text = decodeText(c.bytes);
      if (text !== null) drafts[path] = { text, base: c.base };
    }
    if (!(await store.saveDrafts(settings, drafts))) setStatus('Could not store a local draft (browser storage blocked or full). Save soon.', 'error');
  }, 400);
}

async function restoreDrafts() {
  if (!settings || !ws) return 0;
  const drafts = await store.loadDrafts(settings);
  for (const [path, d] of Object.entries(drafts)) ws.restore(path, encodeText(d.text), d.base);
  return Object.keys(drafts).length;
}

// ---------- Connect / manifest / projects ----------

async function connect(s: store.Settings) {
  settings = s;
  gh = new GitHub(s.token, s.owner, s.repo);
  authProblem = false;
  gh.onUnauthorized = () => { authProblem = true; renderBanner(); };
  ws = new Workspace(gh, s.branch);
  index = new ProjectIndex(ws);
  open.clear();
  current = null;
  setupBanner = null;
  renderBanner();
  setStatus('Loading repository…', 'busy');
  try {
    await ws.load();
  } catch (e) {
    ws = null;
    index = null;
    setEnabled();
    setStatus(errorText(e), 'error');
    if (e instanceof GitHubError && (e.status === 401 || e.status === 404)) {
      openSettings(`${errorText(e)}${e.status === 404 ? ' If the repository is brand new and empty, create it with "Add a README file" ticked.' : ''}`);
    }
    return;
  }
  const restored = await restoreDrafts();
  await loadManifest();
  await loadCompilerConfig();
  const last = store.lastProject(s);
  lastOpenedName = manifest.some((m) => m.Project === last) ? last : null;
  await selectProject(null);
  showHome(); // the start screen: all projects
  setStatus(restored ? `Restored ${restored} unsaved file(s) from this browser.` : 'Ready.');
  void checkSetup();
}

async function loadManifest() {
  if (!ws) return;
  let next: ManifestEntry[] = []; // built aside: the old list stays valid while the file is being read
  if (ws.exists(MANIFEST)) {
    const text = decodeText(await ws.read(MANIFEST));
    try {
      const parsed: unknown = JSON.parse((text ?? '').replace(/^﻿/, ''));
      if (!Array.isArray(parsed)) throw new Error('not a list');
      next = parsed.filter((m): m is ManifestEntry => !!m && typeof m.Project === 'string' && typeof m.MainFile === 'string');
    } catch (e) {
      setStatus(`${MANIFEST} is not valid: ${errorText(e)}`, 'error');
    }
  }
  manifest = next;
  manifest.sort((a, b) => a.Project.localeCompare(b.Project, undefined, { sensitivity: 'base' }));
  if (project) project = manifest.find((m) => m.Project === project!.Project) ?? null; // re-point to the parsed copy
  const sel = $<HTMLSelectElement>('project');
  sel.replaceChildren(...manifest.map((m) => new Option(m.Project, m.Project)));
  if (project) sel.value = project.Project;
}

function writeManifest() {
  ws!.put(MANIFEST, encodeText(JSON.stringify(manifest, null, 2) + '\n'));
  void loadManifest().then(() => { setEnabled(); });
}

// ---------- Start screen: all projects ----------

let lastOpenedName: string | null = null;
let homeSeq = 0;

type EditedCache = Record<string, { t: number; checked: number }>;
const editedKey = () => (settings ? `prism.edited:${settings.owner}/${settings.repo}` : '');
function loadEdited(): EditedCache {
  try { return JSON.parse(localStorage.getItem(editedKey()) ?? '{}') as EditedCache; } catch { return {}; }
}
function saveEdited(c: EditedCache) {
  try { localStorage.setItem(editedKey(), JSON.stringify(c)); } catch { /* storage blocked: dates are only a convenience */ }
}
/** Notes that these projects were just saved (their "last edited" time is now). */
function touchEdited(paths: string[]) {
  const roots = new Set(paths.filter((p) => p.includes('/')).map((p) => p.split('/')[0]));
  const c = loadEdited();
  const now = Date.now();
  for (const m of manifest) if (roots.has(rootOf(m))) c[m.Project] = { t: now, checked: now };
  saveEdited(c);
}

const rootOf = (m: ManifestEntry) => m.MainFile.replace(/\\/g, '/').split('/')[0];
const hasLocalChanges = (m: ManifestEntry) => !!ws && [...ws.changes.keys()].some((p) => p.startsWith(`${rootOf(m)}/`));
const ENGINE_LABEL: Record<string, string> = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' };

function setMode(m: 'home' | 'editor') {
  document.body.dataset.mode = m;
}

function showHome() {
  if (!ws) return;
  flushEdits();
  setMode('home');
  document.title = 'Prism';
  renderHome();
  void refreshEdited();
  setEnabled();
}

async function openProject(name: string) {
  await selectProject(name);
  setMode('editor');
  showView('editor');
  setEnabled();
}

function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

function renderHome() {
  const grid = $('home-grid');
  grid.replaceChildren();
  if (!ws) return;
  const q = $<HTMLInputElement>('home-search').value.trim().toLowerCase();
  const cache = loadEdited();
  const edited = (m: ManifestEntry) => (hasLocalChanges(m) ? Date.now() : cache[m.Project]?.t ?? 0);
  const byName = (a: ManifestEntry, b: ManifestEntry) => a.Project.localeCompare(b.Project, undefined, { sensitivity: 'base' });
  const items = manifest.filter((m) => !q || m.Project.toLowerCase().includes(q));
  items.sort($<HTMLSelectElement>('home-sort').value === 'name' ? byName : (a, b) => edited(b) - edited(a) || byName(a, b));
  $('home-note').textContent = manifest.length
    ? `${items.length === manifest.length ? manifest.length : `${items.length} of ${manifest.length}`} project${manifest.length === 1 ? '' : 's'}`
    : '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'home-empty';
    const h = document.createElement('h2');
    h.textContent = manifest.length ? 'No project matches your search' : 'No projects yet';
    const p = document.createElement('p');
    p.textContent = manifest.length ? 'Try another word.' : 'Create one from a template, or upload a ZIP file of an existing project.';
    empty.append(h, p);
    grid.append(empty);
    return;
  }
  for (const m of items) {
    const card = document.createElement('article');
    card.className = 'pcard';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open project ${m.Project}`);
    const top = document.createElement('div');
    top.className = 'pcard-top';
    const mark = document.createElement('div');
    mark.className = 'pcard-mark';
    mark.style.background = `hsl(${hueOf(m.Project)} 55% 42%)`;
    mark.textContent = ([...m.Project.trim()][0] ?? '?').toUpperCase();
    const title = document.createElement('div');
    title.className = 'pcard-title';
    title.textContent = m.Project;
    top.append(mark, title);
    const meta = document.createElement('div');
    meta.className = 'pcard-meta';
    const eng = document.createElement('span');
    eng.className = 'pcard-badge';
    eng.textContent = ENGINE_LABEL[(m.Engine ?? 'pdflatex').toLowerCase()] ?? String(m.Engine);
    meta.append(eng);
    if (hasLocalChanges(m)) {
      const b = document.createElement('span');
      b.className = 'pcard-badge warn';
      b.textContent = 'Unsaved changes';
      meta.append(b);
    } else if (m.Project === lastOpenedName) {
      const b = document.createElement('span');
      b.className = 'pcard-badge ok';
      b.textContent = 'Last opened';
      meta.append(b);
    }
    const when = document.createElement('span');
    const t = cache[m.Project]?.t;
    when.textContent = hasLocalChanges(m) ? '' : t ? `Edited ${timeAgo(t)}` : '';
    meta.append(when);
    const actions = document.createElement('div');
    actions.className = 'pcard-actions';
    const mk = (iconName: string, label: string, run: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn sm';
      b.title = label;
      b.setAttribute('aria-label', `${label}: ${m.Project}`);
      b.innerHTML = icon(iconName); // static SVG only
      b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
      b.addEventListener('keydown', (e) => e.stopPropagation());
      actions.append(b);
    };
    mk('pencil', 'Rename', () => openProjectDialog('rename', m.Project));
    mk('copy', 'Duplicate', () => openProjectDialog('duplicate', m.Project));
    mk('download', 'Download ZIP', () => void downloadProject(m));
    mk('trash', 'Delete', () => deleteProject(m));
    card.append(top, meta, actions);
    card.addEventListener('click', () => void openProject(m.Project));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openProject(m.Project); } });
    grid.append(card);
  }
}

/** Fills in "edited … ago" for every project (one small request each, cached for 15 minutes). */
async function refreshEdited() {
  if (!gh || !settings || !ws) return;
  const seq = ++homeSeq;
  const cache = loadEdited();
  const now = Date.now();
  const todo = manifest.map((m) => m.Project).filter((n) => !cache[n] || now - cache[n].checked > 15 * 60_000);
  if (!todo.length) return;
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (next < todo.length && !stop && seq === homeSeq) {
      const name = todo[next++];
      const m = manifest.find((x) => x.Project === name);
      if (!m) continue;
      try {
        const commits = await gh!.listCommits(rootOf(m), settings!.branch, 1);
        const d = commits[0]?.commit.author?.date;
        cache[name] = { t: d ? Date.parse(d) : 0, checked: Date.now() };
      } catch { stop = true; } // rate limit or network: show what we have
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
  saveEdited(cache);
  if (seq === homeSeq && document.body.dataset.mode === 'home') renderHome();
}

// ---------- Project operations (all stay local until Save) ----------

function validProjectName(name: string): string | null {
  if (!name) return 'Enter a name.';
  const r = cleanPath(name);
  if ('error' in r) return r.error;
  if (r.path.includes('/')) return 'The name cannot contain "/".';
  if (name.startsWith('.')) return 'The name cannot start with a dot.';
  if (r.path === MANIFEST || manifest.some((m) => m.Project.toLowerCase() === name.toLowerCase())
    || ws!.paths().some((p) => p.toLowerCase().startsWith(`${name.toLowerCase()}/`))) return 'A project or folder with that name already exists.';
  return null;
}

function duplicateProject(src: ManifestEntry, newName: string) {
  const from = `${rootOf(src)}/`;
  for (const p of ws!.paths().filter((x) => x.startsWith(from))) ws!.copy(p, `${newName}/${p.slice(from.length)}`);
  const copy: ManifestEntry = { ...src, Project: newName, MainFile: `${newName}/${src.MainFile.replace(/\\/g, '/').slice(from.length)}`, Status: 'New', Detail: `Copy of ${src.Project}.` };
  manifest.push(copy);
  writeManifest();
  persistDrafts();
}

function renameProject(src: ManifestEntry, newName: string) {
  const from = `${rootOf(src)}/`;
  if (project && rootOf(project) === rootOf(src)) void selectProject(null); // the open editor would point at moved files
  const files = ws!.paths().filter((x) => x.startsWith(from));
  for (const p of files) { ws!.rename(p, `${newName}/${p.slice(from.length)}`); open.delete(p); }
  src.MainFile = `${newName}/${src.MainFile.replace(/\\/g, '/').slice(from.length)}`;
  src.Project = newName;
  const cache = loadEdited();
  delete cache[newName];
  saveEdited(cache);
  writeManifest();
  persistDrafts();
}

function deleteProject(m: ManifestEntry) {
  const from = `${rootOf(m)}/`;
  const files = ws!.paths().filter((x) => x.startsWith(from));
  if (!confirm(`Delete the project "${m.Project}" with its ${files.length} file(s)?\n\nThe deletion is stored when you Save. Git history keeps every older version, so it can be recovered.`)) return;
  if (project && rootOf(project) === rootOf(m)) void selectProject(null);
  for (const p of files) { ws!.remove(p); open.delete(p); }
  manifest = manifest.filter((x) => x !== m);
  writeManifest();
  persistDrafts();
  setStatus(`Deleted "${m.Project}". Save to apply.`);
  void loadManifest().then(() => { renderHome(); setEnabled(); });
}

async function downloadProject(m: ManifestEntry) {
  flushEdits();
  setStatus('Preparing ZIP…', 'busy');
  try {
    const root = `${rootOf(m)}/`;
    const entries: Record<string, Uint8Array> = {};
    for (const p of ws!.paths().filter((x) => x.startsWith(root))) entries[p] = await ws!.read(p);
    download(`${m.Project}.zip`, zipSync(entries, { level: 6 }), 'application/zip');
    setStatus('ZIP ready.');
  } catch (e) {
    setStatus(`ZIP failed: ${errorText(e)}`, 'error');
  }
}

async function uploadProjectZip(file: File) {
  if (!ws) return;
  if (file.size > MAX_ZIP_BYTES) { alert(`That ZIP is larger than ${formatBytes(MAX_ZIP_BYTES)}.`); return; }
  setStatus('Reading ZIP…', 'busy');
  let zip;
  try {
    zip = readZip(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    setStatus(errorText(e), 'error');
    alert(errorText(e));
    return;
  }
  const texts = new Map<string, string>();
  for (const [p, bytes] of zip.files) if (/\.tex$/i.test(p)) { const t = decodeText(bytes); if (t !== null) texts.set(p, t); }
  const main = pickMainFile([...zip.files.keys()], (p) => texts.get(p));
  if (!main) { setStatus('That ZIP contains no .tex file.', 'error'); alert('That ZIP contains no .tex file, so it cannot be a LaTeX project.'); return; }
  const folders = ws.paths().map((p) => p.split('/')[0]);
  const name = uniqueName(nameFromFile(file.name), [...manifest.map((m) => m.Project), ...folders]);
  const bad = validProjectName(name);
  if (bad) { setStatus(bad, 'error'); alert(bad); return; }
  for (const [rel, bytes] of zip.files) ws.put(`${name}/${rel}`, bytes);
  manifest.push({ Project: name, MainFile: `${name}/${main}`, Engine: guessEngine(texts.get(main) ?? ''), Bibliography: 'none', MissingBibliography: [], Status: 'New', Detail: `Uploaded from ${file.name}.` });
  writeManifest();
  persistDrafts();
  const skipped = zip.skipped.length ? ` ${zip.skipped.length} item(s) skipped.` : '';
  setStatus(`Imported ${zip.files.size} files as "${name}" (main file ${main}, ${ENGINE_LABEL[guessEngine(texts.get(main) ?? '')]}).${skipped} Save to keep it.`);
  await loadManifest();
  renderHome();
  setEnabled();
}

async function selectProject(name: string | null) {
  project = manifest.find((m) => m.Project === name) ?? null;
  selected = null;
  lastBuild = null;
  outlineTexts = new Map();
  completionLabels = completionCites = completionFiles = [];
  pdf.clear();
  renderLog();
  closeEditor();
  $('build-info').replaceChildren();
  document.title = project ? `${project.Project} — Prism` : 'Prism';
  if (!project) { renderTree(); renderOutline(); setEnabled(); return; }
  $<HTMLSelectElement>('project').value = project.Project;
  if (settings) store.setLastProject(settings, project.Project);
  for (const d of dirParents(mainPath())) expanded.add(d);
  renderTree();
  setEnabled();
  if (ws!.exists(mainPath())) await openFile(mainPath());
  scheduleIndex(100);
  void loadLastBuild(project.Project);
}

async function loadLastBuild(name: string) {
  try {
    const b = await fetchBuild(gh!, name);
    if (project?.Project !== name) return;
    if (b) await showBuild(b);
    else $('build-info').textContent = 'Not compiled online yet. Press Compile.';
  } catch (e) {
    $('build-info').textContent = `Could not load the last build: ${errorText(e)}`;
  }
}

// ---------- Index (outline, search, auto-completion data) ----------

let indexTimer = 0;
let indexRun = 0;
function scheduleIndex(delay = 1200) {
  clearTimeout(indexTimer);
  indexTimer = window.setTimeout(() => void rebuildIndex(), delay);
}

async function rebuildIndex() {
  if (!ws || !project || !index) return;
  const run = ++indexRun;
  const root = projectRoot();
  try {
    const texts = await index.texts(root);
    if (run !== indexRun || !project) return;
    outlineTexts = texts;
    const labels: string[] = [];
    const cites: string[] = [];
    for (const [p, t] of texts) {
      if (/\.(tex|ltx|sty|cls)$/i.test(p)) labels.push(...labelsIn(t));
      if (/\.(bib|tex|bbl)$/i.test(p)) cites.push(...citeKeysIn(t));
    }
    completionLabels = [...new Set(labels)].sort();
    completionCites = [...new Set(cites)].sort();
    const mainDir = dirname(mainPath());
    completionFiles = ws.paths()
      .filter((p) => p.startsWith(`${mainDir}/`) && !/\.(aux|log|out|toc|blg|bbl|fls|gz|lof|lot|bcf|xml|xdv)$/i.test(p))
      .map((p) => p.slice(mainDir.length + 1));
    if (sideTab === 'outline') renderOutline();
  } catch (e) {
    console.error('Index failed', e);
  }
}

function editorEnv(): EditorEnv {
  return {
    dark: isDark(prefs),
    spellcheck: prefs.spellcheck,
    lang: prefs.spellLang,
    complete: completionSource(() => ({ labels: () => completionLabels, cites: () => completionCites, files: () => completionFiles })),
  };
}

// ---------- Sidebar: files / outline / search ----------

function setSideTab(tab: 'files' | 'outline' | 'search') {
  sideTab = tab;
  for (const t of ['files', 'outline', 'search'] as const) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
  }
  $('tree').hidden = tab !== 'files';
  $('files-tools').hidden = tab !== 'files';
  $('outline').hidden = tab !== 'outline';
  $('search').hidden = tab !== 'search';
  if (tab === 'outline') { renderOutline(); scheduleIndex(50); }
  if (tab === 'search') { $<HTMLInputElement>('search-q').focus(); $<HTMLInputElement>('search-q').select(); }
}

function dirParents(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(1, -1).map((_, i) => parts.slice(0, i + 2).join('/') + '/');
}

function renderTree() {
  const host = $('tree');
  host.replaceChildren();
  if (!ws || !project) return;
  const root = projectRoot() + '/';
  const paths = ws.paths().filter((p) => p.startsWith(root));
  interface Node { dirs: Map<string, Node>; files: string[] }
  const top: Node = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.slice(root.length).split('/');
    let n = top;
    for (const d of parts.slice(0, -1)) {
      if (!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [] });
      n = n.dirs.get(d)!;
    }
    n.files.push(p);
  }
  const build = (n: Node, prefix: string): HTMLUListElement => {
    const ul = document.createElement('ul');
    for (const [name, child] of [...n.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const dirPath = `${prefix}${name}/`;
      const li = document.createElement('li');
      const det = document.createElement('details');
      det.open = expanded.has(dirPath);
      det.addEventListener('toggle', () => { if (det.open) expanded.add(dirPath); else expanded.delete(dirPath); });
      const sum = document.createElement('summary');
      sum.textContent = name;
      if (selected === dirPath) sum.classList.add('selected');
      // No re-render here: it would replace the <details> before it toggles.
      sum.addEventListener('click', () => { selected = dirPath; markSelection(sum); });
      det.append(sum, build(child, dirPath));
      li.append(det);
      ul.append(li);
    }
    for (const p of n.files.sort((a, b) => a.localeCompare(b))) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'file';
      btn.dataset.path = p;
      btn.innerHTML = icon(imageType(p) ? 'image' : 'file'); // static SVG only
      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = basename(p);
      btn.append(label);
      btn.title = relative(p);
      if (isTexLike(p)) btn.dataset.kind = 'tex';
      const c = ws!.changes.get(p);
      if (c) btn.classList.add(c.base === null ? 'added' : 'modified');
      if (p === current) btn.classList.add('current');
      if (p === selected) btn.classList.add('selected');
      if (p === mainPath()) btn.classList.add('main');
      btn.addEventListener('click', () => { selected = p; void openFile(p); });
      li.append(btn);
      ul.append(li);
    }
    return ul;
  };
  host.append(build(top, root));
  const deleted = [...ws.changes].filter(([p, c]) => c.kind === 'delete' && p.startsWith(root)).length;
  if (deleted) {
    const note = document.createElement('p');
    note.className = 'tree-note';
    note.textContent = `${deleted} file(s) deleted — Save to apply.`;
    host.append(note);
  }
}

function markSelection(el: HTMLElement) {
  for (const s of $('tree').querySelectorAll('.selected')) s.classList.remove('selected');
  el.classList.add('selected');
  setEnabled();
}

function renderOutline() {
  const host = $('outline');
  host.replaceChildren();
  if (!project) return;
  const items = projectOutline(mainPath(), (p) => outlineTexts.get(p));
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'tree-note';
    p.textContent = outlineTexts.size ? 'No sections found in the document.' : 'Loading…';
    host.append(p);
    return;
  }
  const min = Math.min(...items.map((i) => i.level));
  const ul = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.dataset.level = String(item.level);
    b.style.paddingLeft = `${8 + (item.level - min) * 14}px`;
    b.title = `${relative(item.file)}:${item.line}`;
    b.append(item.title);
    b.addEventListener('click', () => void openAt(item.file, item.line));
    li.append(b);
    ul.append(li);
  }
  host.append(ul);
}

let searchSeq = 0;
let searchTimer = 0;
async function runSearch() {
  const q = $<HTMLInputElement>('search-q').value;
  const results = $('search-results');
  const summary = $('search-summary');
  const seq = ++searchSeq;
  if (!ws || !project || !index) return;
  if (!q) { results.replaceChildren(); summary.textContent = ''; return; }
  flushEdits();
  summary.textContent = 'Searching…';
  const texts = await index.texts(projectRoot());
  if (seq !== searchSeq) return;
  const r = searchTexts(texts, q, { regex: $<HTMLInputElement>('search-re').checked, caseSensitive: $<HTMLInputElement>('search-case').checked, max: 500 });
  results.replaceChildren();
  if (r.error) { summary.textContent = `Invalid pattern: ${r.error}`; return; }
  const files = new Set(r.hits.map((h) => h.file));
  summary.textContent = r.hits.length
    ? `${r.hits.length}${r.truncated ? '+' : ''} matches in ${files.size} file(s) · searched ${texts.size} text files`
    : `No matches · searched ${texts.size} text files`;
  let lastFile = '';
  for (const h of r.hits) {
    if (h.file !== lastFile) {
      lastFile = h.file;
      const head = document.createElement('div');
      head.className = 'file-head';
      head.textContent = relative(h.file);
      results.append(head);
    }
    const b = document.createElement('button');
    const ln = document.createElement('span');
    ln.className = 'ln';
    ln.textContent = String(h.line);
    const mark = document.createElement('mark');
    mark.textContent = h.text.slice(h.markStart, h.markStart + h.length);
    b.append(ln, h.text.slice(0, h.markStart), mark, h.text.slice(h.markStart + h.length));
    b.addEventListener('click', () => void openAt(h.file, h.line, { col: h.col, len: h.length }));
    results.append(b);
  }
}

/** Replace all matches of the current search in the whole project (stays local until Save; undo = File history or Save-less reload). */
async function replaceAll() {
  if (!ws || !project || !index) return;
  const q = $<HTMLInputElement>('search-q').value;
  const replacement = $<HTMLInputElement>('replace-q').value;
  if (!q) { setStatus('Type what to search for first.'); return; }
  flushEdits();
  const texts = await index.texts(projectRoot());
  const r = replaceInTexts(texts, q, replacement, { regex: $<HTMLInputElement>('search-re').checked, caseSensitive: $<HTMLInputElement>('search-case').checked });
  if (r.error) { setStatus(`Invalid pattern: ${r.error}`, 'error'); return; }
  if (!r.total) { setStatus('No matches to replace.'); return; }
  const list = [...r.changed].slice(0, 12).map(([f, c]) => `  ${relative(f)}: ${c.count}`).join('\n');
  const more = r.changed.size > 12 ? `\n  … and ${r.changed.size - 12} more files` : '';
  if (!confirm(`Replace ${r.total} match(es) in ${r.changed.size} file(s) with "${replacement}"?\n\n${list}${more}\n\nNothing is saved to GitHub until you press Save. To undo after saving, use File history.`)) return;
  for (const [file, c] of r.changed) {
    ws.put(file, encodeText(c.text));
    open.delete(file);
  }
  persistDrafts();
  const cur = current;
  if (cur && r.changed.has(cur)) { closeEditor(); void openFile(cur); }
  renderTree();
  setEnabled();
  scheduleIndex(300);
  setStatus(`Replaced ${r.total} match(es) in ${r.changed.size} file(s). Review, then Save.`);
  void runSearch();
}

/** Opens a file and puts the cursor on a line (optionally selecting a match). */
async function openAt(path: string, line: number, sel?: { col: number; len: number }) {
  if (!ws) return;
  flushEdits();
  if (!ws.exists(path)) return;
  if (current !== path || view.dom.hidden) await openFile(path);
  if (view.dom.hidden || current !== path) return;
  goToLine(view, line);
  if (sel) {
    const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    view.dispatch({ selection: { anchor: l.from + sel.col, head: Math.min(l.to, l.from + sel.col + sel.len) } });
  }
  showView('editor');
}

// ---------- Editor ----------

function closeEditor() {
  current = null;
  view.setState(EditorState.create({ doc: '' }));
  view.dom.hidden = true;
  showPreview(null);
  $('editor-title').textContent = 'Editor';
  $('editor-title').classList.remove('file-open');
  $('editor-empty').hidden = false;
  $('wc').textContent = '';
}

function showPreview(content: HTMLElement | null) {
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  const pv = $('preview');
  pv.replaceChildren(...(content ? [content] : []));
  pv.hidden = !content;
}

function updateWordCount() {
  const el = $('wc');
  if (!current || view.dom.hidden || !isTexLike(current) || current.endsWith('.bib')) { el.textContent = ''; return; }
  el.textContent = `${wordCount(view.state.doc.toString()).toLocaleString()} words`;
}

async function openFile(path: string) {
  if (!ws) return;
  current = path;
  selected = path;
  for (const d of dirParents(path)) expanded.add(d);
  renderTree();
  setEnabled();
  $('editor-title').textContent = path.slice(projectRoot().length + 1);
  $('editor-title').classList.add('file-open');
  $('wc').textContent = '';
  const cached = open.get(path);
  if (cached) {
    showPreview(null);
    view.dom.hidden = false;
    view.setState(cached.state);
    showView('editor');
    updateWordCount();
    setEnabled();
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = await ws.read(path);
  } catch (e) {
    setStatus(`Could not open ${path}: ${errorText(e)}`, 'error');
    return;
  }
  if (current !== path) return; // user clicked elsewhere meanwhile
  const img = imageType(path);
  const text = img ? null : decodeText(bytes);
  if (text === null) {
    view.dom.hidden = true;
    const box = document.createElement('div');
    box.className = 'preview-box';
    let url: string | null = null;
    const info = document.createElement('p');
    info.className = 'meta';
    if (img) {
      url = URL.createObjectURL(new Blob([bytes], { type: img }));
      const el = document.createElement('img');
      el.alt = basename(path);
      el.title = 'Click to toggle actual size';
      el.addEventListener('click', () => el.classList.toggle('actual'));
      el.addEventListener('load', () => { info.textContent = `${el.naturalWidth} × ${el.naturalHeight} px · ${formatBytes(bytes.length)} · click the image to toggle actual size`; });
      el.addEventListener('error', () => { info.textContent = `This image could not be displayed (${formatBytes(bytes.length)}).`; });
      el.src = url;
      info.textContent = formatBytes(bytes.length);
      box.append(el);
    } else info.textContent = `Binary file · ${formatBytes(bytes.length)}. Use Download to open it, or Upload to replace it.`;
    box.append(info);
    showPreview(box);
    previewUrl = url; // revoked by the next showPreview
    setEnabled();
    return;
  }
  // Original = committed text; editing back to it drops the local change.
  let original = text;
  if (ws.changes.has(path)) {
    const committed = await ws.readCommitted(path);
    original = (committed && decodeText(committed)) ?? text;
  }
  const eol = detectEol(original);
  const state = createState(path, text.replace(/\r\n/g, '\n'), hooks, editorEnv());
  open.set(path, { state, original, eol });
  if (current !== path) return;
  showPreview(null);
  view.dom.hidden = false;
  view.setState(state);
  showView('editor');
  updateWordCount();
  setEnabled();
}

let changeTimer = 0;
let followTimer = 0;
const pendingEdits = new Map<string, EditorState>();
const hooks = {
  onChange(path: string, state: EditorState) {
    const f = open.get(path);
    if (f) f.state = state;
    pendingEdits.set(path, state);
    clearTimeout(changeTimer);
    changeTimer = window.setTimeout(flushEdits, 300);
  },
  onCursor(path: string) {
    if (!prefs.followCursor || path !== current) return;
    clearTimeout(followTimer);
    followTimer = window.setTimeout(() => void forwardSearch(true), 400);
  },
  onSave: () => void save(),
  onCompile: () => void runCompile(),
  onForward: () => void forwardSearch(),
};

/** Moves pending editor text into the workspace. */
function flushEdits() {
  clearTimeout(changeTimer);
  if (!ws) return;
  const hadEdits = pendingEdits.size > 0;
  for (const [path, state] of pendingEdits) {
    const f = open.get(path);
    if (!f) continue;
    const text = applyEol(state.doc.toString(), f.eol);
    const c = ws.changes.get(path);
    const inPlace = c ? c.base !== null && c.base === ws.files.get(path)?.sha : ws.files.has(path);
    if (text === f.original && inPlace) ws.revert(path);
    else ws.put(path, encodeText(text));
  }
  pendingEdits.clear();
  persistDrafts();
  renderTree();
  setEnabled();
  if (hadEdits) { updateWordCount(); scheduleIndex(); }
}

/** Re-creates editor states (needed when theme, spell-check or language change). */
function rebuildEditorStates() {
  flushEdits();
  open.clear();
  const cur = current;
  if (cur && !view.dom.hidden) { closeEditor(); void openFile(cur); }
}

// ---------- Save / refresh ----------

let saving: Promise<boolean> | null = null;

function save(): Promise<boolean> {
  saving ??= doSave().finally(() => { saving = null; });
  return saving;
}

async function doSave(): Promise<boolean> {
  if (!ws) return false;
  flushEdits();
  if (!ws.dirty) return true;
  const paths = [...ws.changes.keys()];
  const message = paths.length === 1 ? `Update ${paths[0]}` : `Update ${paths.length} files`;
  setStatus('Saving…', 'busy');
  try {
    try {
      await ws.save(`${message} (Prism web)`);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      const list = e.paths.join('\n');
      const keepMine = confirm(
        `These files were changed somewhere else (another device, Codex or Claude) after you started editing:\n\n${list}\n\n` +
        `OK = keep YOUR version (replaces their change to these files)\nCancel = keep THEIR version (discards your edits to these files)`);
      if (keepMine) await ws.save(`${message} (Prism web, kept local version)`, e.paths);
      else {
        for (const p of e.paths) { ws.revert(p); open.delete(p); }
        await ws.refresh();
        if (ws.dirty) await ws.save(`${message} (Prism web)`);
      }
    }
  } catch (e) {
    setStatus(`Save failed: ${errorText(e)}`, 'error');
    setEnabled();
    return false;
  }
  touchEdited(paths);
  // Saved text is now the committed text.
  for (const f of open.values()) f.original = applyEol(f.state.doc.toString(), f.eol);
  persistDrafts();
  await afterRemoteChange();
  scheduleIndex(300);
  setStatus('Saved.');
  return true;
}

async function refresh() {
  if (!ws) return;
  flushEdits();
  try {
    const changed = await ws.refresh();
    let reloaded = 0;
    for (const p of changed) {
      if (!open.has(p)) continue;
      if (ws.changes.has(p)) continue; // local edits stay; Save will ask what to keep
      open.delete(p);
      reloaded++;
    }
    await afterRemoteChange();
    if (changed.length) scheduleIndex(300);
    const pending = changed.filter((p) => ws!.changes.has(p));
    setStatus(changed.length
      ? `Loaded ${changed.length} changed file(s)${reloaded ? `, reopened ${reloaded}` : ''}.${pending.length ? ` ${pending.length} also edited here: Save will ask which version to keep.` : ''}`
      : 'Up to date.');
  } catch (e) {
    setStatus(`Refresh failed: ${errorText(e)}`, 'error');
  }
}

async function afterRemoteChange() {
  const name = project?.Project ?? null;
  await loadManifest();
  await loadCompilerConfig();
  project = manifest.find((m) => m.Project === name) ?? null;
  if (current && (!ws!.exists(current) || !open.has(current))) {
    const p = current;
    closeEditor();
    if (ws!.exists(p)) await openFile(p);
  }
  renderTree();
  setEnabled();
  if (document.body.dataset.mode === 'home') renderHome();
  void checkSetup();
}

// ---------- Compile / build output ----------

async function runCompile() {
  if (!gh || !project || !settings) return;
  if (!(await save())) return;
  const token = ++compileSeq;
  const name = project.Project;
  const started = Date.now();
  compiling = true;
  currentRunId = null;
  setEnabled(); // the Compile button becomes Stop
  let phaseText = 'Starting compile…';
  setStatus(phaseText, 'busy');
  const tick = window.setInterval(() => {
    if (token === compileSeq) setStatus(`${phaseText} ${Math.round((Date.now() - started) / 1000)}s`, 'busy');
  }, 1000);
  try {
    const build = await compile(gh, settings.branch, name, (p, run) => {
      if (run && token === compileSeq) currentRunId = run.id;
      phaseText = p === 'queued' ? 'Waiting for a GitHub runner…' : p === 'in_progress' ? 'Compiling…' : p === 'fetching' ? 'Loading PDF…' : 'Starting compile…';
    }, () => token === compileSeq);
    if (token !== compileSeq || project?.Project !== name) return;
    await showBuild(build);
    const r = build.result;
    setStatus(r.status === 'ok' ? `Compiled in ${r.duration_seconds}s.`
      : r.status === 'warning' ? `Compiled with errors (${r.duration_seconds}s): ${r.first_error}`
      : `Compile failed: ${r.first_error || r.status}`, r.status === 'ok' ? 'info' : 'error');
    if (r.status === 'error' || r.status === 'timeout') showOutput('log');
  } catch (e) {
    if (token !== compileSeq) return;
    if (e instanceof CompileCancelled) setStatus(e.message || 'Compile cancelled.');
    else setStatus(errorText(e), 'error');
  } finally {
    clearInterval(tick);
    if (token === compileSeq) { compiling = false; currentRunId = null; setEnabled(); }
  }
}

/** Stops waiting for the running compile and asks GitHub to cancel it. */
async function stopCompile() {
  if (!compiling) return;
  compileSeq++; // the waiting loop notices and ends
  compiling = false;
  const id = currentRunId;
  currentRunId = null;
  setEnabled();
  setStatus('Compile stopped.');
  if (gh && id) {
    try { await gh.cancelRun(id); } catch (e) { console.error('Could not cancel the run', e); } // already finished, or no permission: harmless
  }
}

async function showBuild(b: Build) {
  lastBuild = b;
  renderLog();
  renderBuildInfo();
  setEnabled();
  if (b.pdf) {
    try {
      await pdf.show(b.pdf);
    } catch (e) {
      setStatus(`Could not display the PDF: ${errorText(e)}`, 'error');
    }
  } else pdf.clear();
  renderBuildInfo();
  setEnabled();
}

function renderBuildInfo() {
  const el = $('build-info');
  const b = lastBuild;
  if (!b) return;
  const r = b.result;
  const when = new Date(r.finished_at).toLocaleString();
  const stale = ws && r.sha && r.sha !== ws.baseCommit ? ' · from an earlier version' : '';
  const label = r.status === 'ok' ? 'OK' : r.status === 'warning' ? 'Errors (PDF produced)' : r.status === 'timeout' ? 'Timed out' : 'Failed';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = label;
  const pages = pdf.pageInfo ? ` · ${pdf.pageInfo}` : '';
  const tl = texliveFromLog(b.log);
  el.replaceChildren(badge, `${r.engine}${tl ? ` · TeX Live ${tl}` : ''} · ${r.duration_seconds}s · ${when}${pages}${stale}`);
  el.title = r.command ? `${r.command}${r.image ? `\nImage: ${r.image}` : ''}` : '';
  el.dataset.kind = r.status;
}

function renderLog() {
  const list = $('issues');
  list.replaceChildren();
  $('log-text').textContent = lastBuild?.log ?? '';
  const issues = lastBuild ? parseLog(lastBuild.log) : [];
  const errors = issues.filter((i) => i.kind === 'error').length;
  const warnings = issues.length - errors;
  $('show-log').querySelector('.label')!.textContent = errors ? `Log (${errors} ${errors === 1 ? 'error' : 'errors'})`
    : warnings ? `Log (${warnings} ${warnings === 1 ? 'warning' : 'warnings'})` : 'Log';
  const mainDir = dirname(lastBuild?.result.main_file || mainPath());
  for (const issue of issues.slice(0, 300)) {
    const li = document.createElement('li');
    li.className = issue.kind;
    const target = issue.file ? resolveLogPath(mainDir, issue.file) : null;
    const where = issue.file ? `${issue.file}:${issue.line}` : issue.line ? `line ${issue.line}` : '';
    const text = `${issue.kind === 'error' ? 'Error' : 'Warning'}${where ? ` (${where})` : ''}: ${issue.message}`;
    if (target && ws?.exists(target)) {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.addEventListener('click', () => void openAt(target, issue.line ?? 1));
      li.append(btn);
    } else li.textContent = text;
    list.append(li);
  }
}

function showOutput(which: 'pdf' | 'log') {
  $('pdf').hidden = which !== 'pdf';
  $('log').hidden = which !== 'log';
  $('page-nav').hidden = which !== 'pdf' || !pdf.hasDocument;
  $('show-pdf').setAttribute('aria-pressed', String(which === 'pdf'));
  $('show-log').setAttribute('aria-pressed', String(which === 'log'));
  setEnabled();
  showView('output');
}

function showView(v: 'files' | 'editor' | 'output') {
  // Only matters on narrow screens, where one panel shows at a time.
  if (window.matchMedia('(max-width: 899px)').matches) document.body.dataset.view = v;
}

// ---------- SyncTeX: source <-> PDF ----------

function loadSync(b: Build): Promise<SyncState | null> {
  let p = syncCache.get(b);
  if (!p) {
    p = (async () => {
      const bytes = await b.synctex();
      if (!bytes) return null;
      const tex = parseSynctexFile(bytes);
      const main = b.result.main_file.replace(/\\/g, '/');
      const map = mapInputs(tex.inputs, main.split('/')[0], dirname(main), { has: (path) => ws?.exists(path) ?? false });
      const tagsByPath = new Map<string, Set<number>>();
      for (const [tag, path] of map) {
        const set = tagsByPath.get(path) ?? new Set<number>();
        set.add(tag);
        tagsByPath.set(path, set);
      }
      return { tex, map, tagsByPath };
    })();
    syncCache.set(b, p);
    p.catch(() => syncCache.delete(b));
  }
  return p;
}

const staleNote = () => (lastBuild && ws && (lastBuild.result.sha !== ws.baseCommit || ws.dirty) ? ' — the PDF is older than your text, so the position may be off' : '');

/** Source line -> PDF position. */
async function forwardSearch(quiet = false) {
  if (!lastBuild?.pdf || !current || view.dom.hidden) {
    if (!quiet) setStatus('Compile the project first, then use "Show this line in the PDF".');
    return;
  }
  try {
    const st = await loadSync(lastBuild);
    if (!st) { if (!quiet) setStatus('This build has no SyncTeX data. Compile again.'); return; }
    const tags = st.tagsByPath.get(current);
    if (!tags) { if (!quiet) setStatus('This file is not part of the compiled document.'); return; }
    const f = forward(st.tex, tags, currentLine(view));
    if (!f) { if (!quiet) setStatus('No PDF output found for this line.'); return; }
    pdf.reveal(f.page, f.rects[0]?.y ?? 0, f.rects);
    if (!quiet) {
      showOutput('pdf');
      setStatus(`PDF page ${f.page}${f.exact ? '' : ' (nearest line with output)'}${staleNote()}`);
    }
  } catch (e) {
    if (!quiet) setStatus(`Could not read SyncTeX data: ${errorText(e)}`, 'error');
  }
}

/** PDF position -> source line. */
async function jumpToSource(pt: PdfPoint) {
  if (!lastBuild) return;
  try {
    const first = !syncCache.has(lastBuild);
    if (first) setStatus('Loading SyncTeX data…', 'busy');
    const st = await loadSync(lastBuild);
    if (!st) { setStatus('This build has no SyncTeX data. Compile again.'); return; }
    const hit = inverse(st.tex, pt.page, pt.x, pt.y, (tag) => st.map.has(tag));
    if (!hit) { setStatus('No source found at this position.'); return; }
    const path = st.map.get(hit.tag)!;
    await openAt(path, hit.line);
    setStatus(`Jumped to ${relative(path)}:${hit.line}${staleNote()}`);
  } catch (e) {
    setStatus(`Could not read SyncTeX data: ${errorText(e)}`, 'error');
  }
}

// ---------- File history ----------

interface Version { sha: string; message: string; author: string; date: string }
let historyVersions: Version[] = [];
let historyBytes: Uint8Array | null = null;
let historyPath = '';

async function openHistory() {
  if (!gh || !settings || !current || !ws?.files.has(current)) return;
  flushEdits();
  historyPath = current;
  historyBytes = null;
  $('history-title').textContent = `History of ${relative(historyPath)}`;
  $('history-list').replaceChildren();
  $('history-diff').replaceChildren();
  $('history-note').textContent = 'Loading versions…';
  ($('history-restore') as HTMLButtonElement).disabled = true;
  $<HTMLDialogElement>('history-dialog').showModal();
  try {
    const commits = await gh.listCommits(historyPath, settings.branch, 40);
    historyVersions = commits.map((c) => ({
      sha: c.sha, message: c.commit.message.split('\n')[0], author: c.commit.author?.name ?? 'unknown', date: c.commit.author?.date ?? '',
    }));
  } catch (e) {
    $('history-note').textContent = `Could not load the history: ${errorText(e)}`;
    return;
  }
  if (!historyVersions.length) { $('history-note').textContent = 'No earlier versions found.'; return; }
  $('history-note').textContent = 'Pick a version to compare it with your current text.';
  const list = $('history-list');
  historyVersions.forEach((v, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.append(v.message || '(no message)');
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `${v.author} · ${v.date ? new Date(v.date).toLocaleString() : ''}`;
    b.append(when);
    b.addEventListener('click', () => void selectVersion(i));
    li.append(b);
    list.append(li);
  });
}

async function selectVersion(i: number) {
  const v = historyVersions[i];
  for (const [j, b] of [...$('history-list').querySelectorAll('button')].entries()) b.setAttribute('aria-current', String(j === i));
  const diffEl = $('history-diff');
  diffEl.replaceChildren();
  historyBytes = null;
  ($('history-restore') as HTMLButtonElement).disabled = true;
  $('history-note').textContent = 'Loading…';
  try {
    const bytes = await gh!.getFileAt(historyPath, v.sha);
    if (!bytes) { $('history-note').textContent = 'The file did not exist in that version.'; return; }
    const old = decodeText(bytes);
    if (old === null) { $('history-note').textContent = 'This version is a binary file; it cannot be compared.'; historyBytes = bytes; ($('history-restore') as HTMLButtonElement).disabled = false; return; }
    const nowBytes = ws!.exists(historyPath) ? await ws!.read(historyPath) : new Uint8Array();
    const now = decodeText(nowBytes) ?? '';
    const lines = diffLines(now.replace(/\r\n/g, '\n').split('\n'), old.replace(/\r\n/g, '\n').split('\n'));
    historyBytes = bytes;
    ($('history-restore') as HTMLButtonElement).disabled = false;
    if (!lines) { $('history-note').textContent = 'The versions differ too much to show a comparison. You can still restore it.'; return; }
    const changed = lines.filter((l) => l.type !== 'eq').length;
    $('history-note').textContent = changed
      ? `Restoring this version would ADD the green lines and REMOVE the red lines (${changed} changed lines).`
      : 'Identical to your current text.';
    // Show changes with 3 lines of context; collapse the rest.
    const keep = lines.map((l, k) => l.type !== 'eq' || lines.slice(Math.max(0, k - 3), k + 4).some((x) => x.type !== 'eq'));
    let gap = false;
    lines.forEach((l, k) => {
      if (!keep[k]) { gap = true; return; }
      if (gap) { const g = document.createElement('span'); g.className = 'l'; g.textContent = '⋯'; diffEl.append(g); gap = false; }
      const s = document.createElement('span');
      s.className = `l ${l.type}`;
      s.textContent = `${l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}${l.text}`;
      diffEl.append(s);
    });
  } catch (e) {
    $('history-note').textContent = `Could not load that version: ${errorText(e)}`;
  }
}

function restoreVersion() {
  if (!ws || !historyBytes || !historyPath) return;
  ws.put(historyPath, historyBytes);
  open.delete(historyPath);
  persistDrafts();
  $<HTMLDialogElement>('history-dialog').close();
  const p = historyPath;
  closeEditor();
  void openFile(p);
  setStatus('Older version loaded into the editor. Review it, then Save to keep it.');
}

// ---------- File operations ----------

function targetDir(): string {
  if (selected?.endsWith('/')) return selected.slice(0, -1);
  if (selected) return dirname(selected);
  return projectRoot();
}

/** Validates a path typed relative to the project folder. */
function projectPath(input: string): string | null {
  const r = cleanPath(joinPath(projectRoot(), input.replace(/^\/+/, '')));
  if ('error' in r) { alert(r.error); return null; }
  return r.path;
}

function newFile() {
  const dir = relative(targetDir() + '/');
  const input = prompt('New file path inside the project (use / for folders):', dir);
  if (!input) return;
  const path = projectPath(input);
  if (!path) return;
  if (ws!.exists(path)) { alert('A file with that name already exists.'); return; }
  ws!.put(path, new Uint8Array());
  persistDrafts();
  void openFile(path);
}

async function upload(files: ArrayLike<File>) {
  const dir = targetDir();
  for (const file of Array.from(files)) {
    if (file.size > MAX_UPLOAD) { alert(`${file.name} is larger than ${formatBytes(MAX_UPLOAD)} and cannot be stored in GitHub this way.`); continue; }
    const r = cleanPath(joinPath(dir, file.name));
    if ('error' in r) { alert(`${file.name}: ${r.error}`); continue; }
    if (ws!.exists(r.path) && !confirm(`${relative(r.path)} exists. Replace it?`)) continue;
    ws!.put(r.path, new Uint8Array(await file.arrayBuffer()));
    open.delete(r.path);
    if (current === r.path) closeEditor();
  }
  persistDrafts();
  renderTree();
  setEnabled();
  setStatus('Uploaded. Save to store the files.');
}

function renameSelected() {
  if (!selected) return;
  flushEdits();
  const isDir = selected.endsWith('/');
  const input = prompt(`Rename / move ${isDir ? 'folder' : 'file'} (path inside the project):`, relative(isDir ? selected.slice(0, -1) : selected));
  if (!input) return;
  const to = projectPath(input);
  if (!to) return;
  const moves: [string, string][] = isDir
    ? ws!.paths().filter((p) => p.startsWith(selected!)).map((p) => [p, to + '/' + p.slice(selected!.length)])
    : [[selected, to]];
  if (moves.some(([, t]) => ws!.exists(t))) { alert('Something already exists at the new location.'); return; }
  try {
    for (const [from, t] of moves) {
      ws!.rename(from, t);
      open.delete(from);
      if (current === from) current = t;
      if (project && mainPath() === from) { project.MainFile = t; writeManifest(); }
    }
  } catch (e) {
    alert(errorText(e));
  }
  selected = isDir ? to + '/' : to;
  const cur = current;
  closeEditor();
  persistDrafts();
  if (cur && ws!.exists(cur)) void openFile(cur);
  else renderTree();
  setEnabled();
  scheduleIndex(300);
}

function deleteSelected() {
  if (!selected) return;
  const isDir = selected.endsWith('/');
  const targets = isDir ? ws!.paths().filter((p) => p.startsWith(selected!)) : [selected];
  if (targets.includes(mainPath())) { alert('This contains the main file. Choose another main file in Project settings first.'); return; }
  if (!confirm(`Delete ${targets.length} file(s)?\n\n${targets.slice(0, 15).map(relative).join('\n')}${targets.length > 15 ? '\n…' : ''}\n\nThe deletion is stored when you Save; Git history keeps old versions.`)) return;
  for (const p of targets) {
    ws!.remove(p);
    open.delete(p);
    if (current === p) closeEditor();
  }
  selected = null;
  persistDrafts();
  renderTree();
  setEnabled();
  scheduleIndex(300);
}

async function downloadSelected() {
  if (!selected || selected.endsWith('/')) return;
  flushEdits();
  download(basename(selected), await ws!.read(selected));
}

async function downloadZip() {
  if (!project) return;
  flushEdits();
  setStatus('Preparing ZIP…', 'busy');
  try {
    const root = projectRoot() + '/';
    const entries: Record<string, Uint8Array> = {};
    for (const p of ws!.paths().filter((x) => x.startsWith(root))) entries[p] = await ws!.read(p);
    download(`${project.Project}.zip`, zipSync(entries, { level: 6 }), 'application/zip');
    setStatus('ZIP ready.');
  } catch (e) {
    setStatus(`ZIP failed: ${errorText(e)}`, 'error');
  }
}

// ---------- Repository setup (compile workflow) ----------

async function checkSetup() {
  if (!ws) return;
  try {
    const st = await setupStatus(ws.files);
    setupBanner = !st.needed ? null : st.missing.length
      ? 'This repository is not set up for compiling yet.'
      : 'A newer version of the compile workflow is available.';
    renderBanner();
  } catch (e) {
    console.error('Setup check failed', e);
  }
}

/** One banner slot, most urgent first: token expired / expiring, then repository set-up. */
let setupBanner: string | null = null;
function renderBanner() {
  const ex = settings ? expiryState(settings.expires) : null;
  if (authProblem) showBanner('GitHub no longer accepts your token (it expired or was revoked). Your edits are kept in this browser. Enter a new token to continue.', 'Update token', () => openSettings(), 'error');
  else if (ex) showBanner(ex.text, 'Update token', () => openSettings(), ex.level === 'expired' ? 'error' : 'warn');
  else if (setupBanner) showBanner(setupBanner, 'Set up', () => openSetup());
  else hideBanner();
}

async function openSetup() {
  if (!ws) return;
  const st = await setupStatus(ws.files);
  const parts: string[] = [];
  if (st.missing.length) parts.push(`Missing: ${st.missing.join(', ')}.`);
  if (st.outdated.length) parts.push(`Out of date: ${st.outdated.join(', ')}.`);
  $('setup-text').textContent = parts.join(' ') || 'Everything is already set up.';
  $('setup-error').textContent = ws.dirty ? 'You have unsaved changes. Save them first: setting up commits on its own.' : '';
  ($('setup-ok') as HTMLButtonElement).disabled = ws.dirty;
  $<HTMLDialogElement>('setup-dialog').showModal();
}

async function runSetup() {
  if (!ws) return;
  const err = $('setup-error');
  if (ws.dirty) { err.textContent = 'Save your other changes first.'; return; }
  const st = await setupStatus(ws.files);
  const paths = [...st.missing, ...st.outdated];
  if (!ws.files.get('.gitignore')) paths.push('.gitignore');
  err.textContent = 'Setting up…';
  for (const p of paths) ws.put(p, encodeText(SETUP_FILES[p]));
  try {
    await ws.save('Set up Prism compile workflow (Prism web)');
  } catch (e) {
    for (const p of paths) ws.revert(p);
    const msg = errorText(e);
    err.textContent = /workflow|403|404|refus/i.test(msg)
      ? `GitHub refused the workflow files. Edit your token on GitHub and give it "Workflows: Read and write" (plus Contents and Actions), then try again. (${msg})`
      : `Set up failed: ${msg}`;
    renderTree();
    setEnabled();
    return;
  }
  $<HTMLDialogElement>('setup-dialog').close();
  await afterRemoteChange();
  setStatus('Repository set up. You can remove the Workflows permission from your token now.');
}

// ---------- Dialogs: connection, unlock, preferences, projects ----------

function selectedMode(): store.Mode {
  return (document.querySelector<HTMLInputElement>('input[name="s-mode"]:checked')?.value as store.Mode | undefined) ?? 'device';
}

function syncPassField() {
  $('s-pass-label').hidden = selectedMode() !== 'encrypted';
}

function openSettings(error = '') {
  const last = settings ?? store.lastConnection();
  $<HTMLInputElement>('s-owner').value = last?.owner ?? '';
  $<HTMLInputElement>('s-repo').value = last?.repo ?? 'prism-data';
  $<HTMLInputElement>('s-branch').value = last?.branch ?? 'main';
  const tokenInput = $<HTMLInputElement>('s-token');
  tokenInput.value = '';
  tokenInput.placeholder = settings ? '(unchanged — paste a new token to replace it)' : 'github_pat_…';
  $<HTMLInputElement>('s-expires').value = settings?.expires ?? '';
  $<HTMLInputElement>('s-pass').value = '';
  const mode = settings?.mode ?? 'device';
  const radio = document.querySelector<HTMLInputElement>(`input[name="s-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  syncPassField();
  $('s-error').textContent = error;
  const dlg = $<HTMLDialogElement>('settings-dialog');
  if (!dlg.open) dlg.showModal();
}

async function submitSettings() {
  const err = $('s-error');
  const mode = selectedMode();
  const pass = $<HTMLInputElement>('s-pass').value;
  const next: store.Settings = {
    owner: $<HTMLInputElement>('s-owner').value.trim(),
    repo: $<HTMLInputElement>('s-repo').value.trim(),
    branch: $<HTMLInputElement>('s-branch').value.trim() || 'main',
    token: $<HTMLInputElement>('s-token').value.trim() || settings?.token || '',
    mode,
    expires: $<HTMLInputElement>('s-expires').value || undefined,
  };
  if (!next.owner || !next.repo || !next.token) { err.textContent = 'Owner, repository and token are required.'; return; }
  if (next.expires) {
    const left = daysLeft(next.expires);
    // A brand-new token must not already be expired; keeping an old, expired date is allowed so the user can still open the dialog.
    if (left === null) { err.textContent = 'The expiry date is not valid.'; return; }
    if (left < 0 && $<HTMLInputElement>('s-token').value.trim()) { err.textContent = 'That expiry date is in the past. Enter the date of the new token.'; return; }
  }
  if (!/^[A-Za-z0-9-]+$/.test(next.owner) || !/^[A-Za-z0-9._-]+$/.test(next.repo)) { err.textContent = 'Owner or repository contains characters GitHub does not allow.'; return; }
  if (mode === 'encrypted' && pass.length < 8) { err.textContent = 'Choose a passphrase of at least 8 characters.'; return; }
  if (ws?.dirty && (next.owner !== settings?.owner || next.repo !== settings?.repo || next.branch !== settings?.branch)
    && !confirm('You have unsaved changes for the current repository. They stay as a draft only for text files. Switch anyway?')) return;
  err.textContent = 'Checking…';
  try {
    const test = new GitHub(next.token, next.owner, next.repo);
    const { info, classicScopes } = await test.checkToken();
    if (!info.permissions?.push) throw new Error('This token cannot write to the repository (needs Contents: read and write).');
    if (!(await test.getRefSha(next.branch))) throw new Error(`Branch "${next.branch}" does not exist. If the repository is empty, create it with "Add a README file" ticked.`);
    if (classicScopes !== null && !confirm(
      `This is a CLASSIC token (scopes: ${classicScopes || 'none'}). It can reach ALL of your GitHub repositories, not just this one. ` +
      'A fine-grained token limited to this repository is much safer.\n\nUse the classic token anyway?')) { err.textContent = ''; return; }
    if (!info.private && !confirm('WARNING: this repository is PUBLIC, so everyone can read your files. Continue anyway?')) { err.textContent = ''; return; }
  } catch (e) {
    err.textContent = errorText(e);
    return;
  }
  // Changing how the token is kept also changes where unsaved drafts live: move them, so no plain copy is left behind.
  const sameRepo = !!settings && settings.owner === next.owner && settings.repo === next.repo && settings.branch === next.branch;
  const carried = sameRepo ? await store.loadDrafts(settings!) : null;
  try {
    if (!(await store.saveSettings(next, mode === 'encrypted' ? pass : undefined))) {
      err.textContent = 'Connected, but this browser blocks storage: you will need to enter the token again next time.';
    }
    if (sameRepo && carried && settings!.mode !== next.mode) {
      store.dropDrafts(settings!);
      await store.saveDrafts(next, carried);
    }
  } catch (e) {
    err.textContent = errorText(e);
    return;
  }
  $<HTMLDialogElement>('settings-dialog').close();
  await connect(next);
}

let pendingLocked: store.Stored | null = null;
function openUnlock(stored: store.Stored) {
  pendingLocked = stored;
  $<HTMLInputElement>('u-pass').value = '';
  $('u-error').textContent = '';
  $<HTMLDialogElement>('unlock-dialog').showModal();
  $<HTMLInputElement>('u-pass').focus();
}

async function submitUnlock() {
  if (!pendingLocked) return;
  const err = $('u-error');
  err.textContent = 'Unlocking…';
  try {
    const s = await store.unlockSettings(pendingLocked, $<HTMLInputElement>('u-pass').value);
    $<HTMLDialogElement>('unlock-dialog').close();
    await connect(s);
  } catch (e) {
    err.textContent = e instanceof WrongPassphrase ? e.message : errorText(e);
  }
}

function openPrefs() {
  $<HTMLSelectElement>('pf-theme').value = prefs.theme;
  $<HTMLInputElement>('pf-size').value = String(prefs.fontSize);
  $<HTMLSelectElement>('pf-jump').value = prefs.pdfJump;
  $<HTMLSelectElement>('pf-lang').value = prefs.spellLang;
  $<HTMLInputElement>('pf-spell').checked = prefs.spellcheck;
  $<HTMLInputElement>('pf-follow').checked = prefs.followCursor;
  $<HTMLDialogElement>('prefs-dialog').showModal();
}

function prefsChanged() {
  const before = prefs;
  prefs = sanitize({
    theme: $<HTMLSelectElement>('pf-theme').value as Prefs['theme'],
    fontSize: Number($<HTMLInputElement>('pf-size').value),
    spellcheck: $<HTMLInputElement>('pf-spell').checked,
    spellLang: $<HTMLSelectElement>('pf-lang').value,
    pdfJump: $<HTMLSelectElement>('pf-jump').value as Prefs['pdfJump'],
    followCursor: $<HTMLInputElement>('pf-follow').checked,
  });
  savePrefs(prefs);
  applyPrefs(prefs);
  pdf.jumpMode = prefs.pdfJump;
  if (before.theme !== prefs.theme || before.spellcheck !== prefs.spellcheck || before.spellLang !== prefs.spellLang) rebuildEditorStates();
}

type ProjectDialogMode = 'new' | 'edit' | 'rename' | 'duplicate';
let projectDialogMode: ProjectDialogMode = 'new';
let projectDialogTarget: ManifestEntry | null = null;

function applyTemplateToDialog() {
  const t = templateById($<HTMLSelectElement>('p-template').value);
  $('p-template-desc').textContent = t.description;
  $<HTMLSelectElement>('p-engine').value = t.engine;
  $<HTMLInputElement>('p-rc').checked = !!t.latexmkrc;
  $<HTMLInputElement>('p-shell').checked = !!t.shellEscape;
  $<HTMLInputElement>('p-clean').checked = false;
  $<HTMLInputElement>('p-args').value = '';
}

function openProjectDialog(mode: ProjectDialogMode, targetName?: string) {
  projectDialogMode = mode;
  projectDialogTarget = mode === 'edit' ? project : manifest.find((m) => m.Project === targetName) ?? null;
  const target = projectDialogTarget;
  const titles: Record<ProjectDialogMode, string> = {
    new: 'New project', edit: `Project settings: ${project?.Project ?? ''}`,
    rename: `Rename "${target?.Project ?? ''}"`, duplicate: `Duplicate "${target?.Project ?? ''}"`,
  };
  $('p-title').textContent = titles[mode];
  const nameMode = mode !== 'edit';
  const fullMode = mode === 'new' || mode === 'edit';
  $('p-name-label').hidden = !nameMode;
  $('p-template-label').hidden = mode !== 'new';
  $('p-template-desc').hidden = mode !== 'new';
  $('p-main-label').hidden = mode !== 'edit';
  $('p-engine').closest('label')!.hidden = !fullMode;
  $('p-advanced').hidden = !fullMode;
  ($('p-advanced').previousElementSibling as HTMLElement).hidden = !fullMode;
  const nameInput = $<HTMLInputElement>('p-name');
  nameInput.value = mode === 'rename' ? target?.Project ?? '' : mode === 'duplicate' ? uniqueName(`${target?.Project ?? 'Project'} copy`, manifest.map((m) => m.Project)) : '';
  $('p-error').textContent = '';
  const tplSelect = $<HTMLSelectElement>('p-template');
  if (!tplSelect.options.length) tplSelect.replaceChildren(...TEMPLATES.map((t) => new Option(t.name, t.id)));
  if (mode === 'new') {
    tplSelect.value = TEMPLATES[0].id;
    applyTemplateToDialog();
  } else if (mode === 'edit' && project) {
    $<HTMLSelectElement>('p-engine').value = (project.Engine ?? 'pdflatex').toLowerCase();
    $<HTMLInputElement>('p-rc').checked = !!project.UseLatexmkrc;
    $<HTMLInputElement>('p-shell').checked = !!project.ShellEscape;
    $<HTMLInputElement>('p-clean').checked = !!project.CleanBuild;
    $<HTMLInputElement>('p-args').value = typeof project.LatexmkArgs === 'string' ? project.LatexmkArgs : '';
    const root = projectRoot() + '/';
    const texFiles = ws!.paths().filter((p) => p.startsWith(root) && p.toLowerCase().endsWith('.tex'));
    $<HTMLSelectElement>('p-main').replaceChildren(...texFiles.map((p) => new Option(relative(p), p, false, p === mainPath())));
  }
  const dlg = $<HTMLDialogElement>('project-dialog');
  dlg.showModal();
  if (nameMode) { nameInput.focus(); nameInput.select(); }
}

function submitProjectDialog() {
  const err = $('p-error');
  const engine = $<HTMLSelectElement>('p-engine').value;
  const shell = $<HTMLInputElement>('p-shell').checked;
  const rc = $<HTMLInputElement>('p-rc').checked;
  const clean = $<HTMLInputElement>('p-clean').checked;
  const args = $<HTMLInputElement>('p-args').value.trim().replace(/\s+/g, ' ');
  const close = () => $<HTMLDialogElement>('project-dialog').close();
  if (!ws) return;
  if ((projectDialogMode === 'edit' || projectDialogMode === 'new') && !validLatexmkArgs(args)) {
    err.textContent = 'Extra options may only contain letters, digits, spaces and _ = . , : + / @ % - (at most 300 characters).';
    return;
  }

  if (projectDialogMode === 'edit') {
    if (!project) return;
    project.MainFile = $<HTMLSelectElement>('p-main').value || project.MainFile;
    project.Engine = engine;
    if (shell) project.ShellEscape = true; else delete project.ShellEscape;
    if (rc) project.UseLatexmkrc = true; else delete project.UseLatexmkrc;
    if (clean) project.CleanBuild = true; else delete project.CleanBuild;
    if (args) project.LatexmkArgs = args; else delete project.LatexmkArgs;
    writeManifest();
    close();
    renderTree();
    setStatus('Project settings changed. Save or Compile to store them.');
    return;
  }

  const name = $<HTMLInputElement>('p-name').value.trim();
  const target = projectDialogTarget;
  // Renaming to the same name is a no-op; any other name must be free.
  if (projectDialogMode === 'rename' && target && name === target.Project) { close(); return; }
  const bad = validProjectName(name);
  if (bad) { err.textContent = bad; return; }

  if (projectDialogMode === 'new') {
    const tpl = templateById($<HTMLSelectElement>('p-template').value);
    for (const [rel, text] of Object.entries(tpl.files)) ws.put(`${name}/${rel}`, encodeText(text));
    manifest.push({
      Project: name, MainFile: `${name}/main.tex`, Engine: engine, Bibliography: tpl.bibliography, MissingBibliography: [], Status: 'New', Detail: `Created from the "${tpl.name}" template.`,
      ...(shell ? { ShellEscape: true } : {}), ...(rc ? { UseLatexmkrc: true } : {}),
      ...(clean ? { CleanBuild: true } : {}), ...(args ? { LatexmkArgs: args } : {}),
    });
    writeManifest();
    persistDrafts();
    close();
    void loadManifest().then(() => openProject(name)).then(() => setStatus('Project created. Save or Compile to store it.'));
  } else if (projectDialogMode === 'duplicate' && target) {
    duplicateProject(target, name);
    close();
    void loadManifest().then(() => { renderHome(); setEnabled(); setStatus(`Duplicated as "${name}". Save to keep it.`); });
  } else if (projectDialogMode === 'rename' && target) {
    renameProject(target, name);
    close();
    void loadManifest().then(() => { renderHome(); setEnabled(); setStatus(`Renamed to "${name}". Save to apply. Earlier online builds of the old name are no longer shown.`); });
  }
}

// ---------- Compiler settings (whole repository) ----------

let compilerConfig: CompilerConfig = { ...defaultCompilerConfig };

async function loadCompilerConfig() {
  if (!ws) return;
  try {
    compilerConfig = parseCompilerConfig(ws.exists(COMPILER_FILE) ? decodeText(await ws.read(COMPILER_FILE)) : null);
  } catch { compilerConfig = { ...defaultCompilerConfig }; }
}

function describeTexlive(v: string): string {
  return v === 'latest'
    ? 'Always the newest TeX Live. New packages, but a document may change when a new year is released.'
    : `TeX Live ${v} exactly as it was in ${v}: the same document compiles the same way every time. The first compile with a new version downloads about 2–3 GB, which adds roughly a minute once.`;
}

function openCompilerDialog() {
  if (!ws) return;
  const sel = $<HTMLSelectElement>('c-texlive');
  sel.replaceChildren(new Option('Latest', 'latest'), ...TEXLIVE_YEARS.map((y) => new Option(`TeX Live ${y} (frozen)`, y)));
  sel.value = compilerConfig.texlive;
  $<HTMLInputElement>('c-timeout').value = String(compilerConfig.timeoutMinutes);
  $('c-texlive-hint').textContent = describeTexlive(compilerConfig.texlive);
  const used = lastBuild ? texliveFromLog(lastBuild.log) : null;
  $('c-last').textContent = used ? `The last build of the open project used TeX Live ${used}.` : '';
  $('c-error').textContent = '';
  const dlg = $<HTMLDialogElement>('compiler-dialog');
  if (!dlg.open) dlg.showModal();
}

function applyCompilerDialog() {
  if (!ws) return;
  const texlive = $<HTMLSelectElement>('c-texlive').value;
  const minutes = Number($<HTMLInputElement>('c-timeout').value);
  if (!isTexliveChoice(texlive)) { $('c-error').textContent = 'Choose a TeX Live version from the list.'; return; }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MINUTES) { $('c-error').textContent = `The time limit must be a whole number of minutes from 1 to ${MAX_TIMEOUT_MINUTES}.`; return; }
  const next: CompilerConfig = { texlive, timeoutMinutes: minutes };
  const changed = next.texlive !== compilerConfig.texlive || next.timeoutMinutes !== compilerConfig.timeoutMinutes;
  compilerConfig = next;
  if (changed || ws.exists(COMPILER_FILE)) ws.put(COMPILER_FILE, encodeText(serializeCompilerConfig(next)));
  persistDrafts();
  setEnabled();
  $<HTMLDialogElement>('compiler-dialog').close();
  setStatus(changed ? `Compiler set to ${next.texlive === 'latest' ? 'the latest TeX Live' : `TeX Live ${next.texlive}`}, ${next.timeoutMinutes} min limit. Save or Compile to apply.` : 'Compiler settings unchanged.');
}

// ---------- Robustness: unexpected errors, connection state ----------

function reportUnexpected(reason: unknown) {
  const msg = reason instanceof Error ? reason.message : String(reason);
  // Browser noise that is not a problem: resize loops, cancelled PDF renders, aborted navigations.
  if (/ResizeObserver loop|RenderingCancelled|Worker was destroyed|AbortError|Transport destroyed/i.test(msg) || (reason instanceof Error && /RenderingCancelled|AbortException/.test(reason.name))) return;
  console.error('Unexpected error', reason);
  setStatus(`Something unexpected went wrong: ${msg.slice(0, 160)}. Your edits are still in this browser; Save, then reload the page if it keeps happening.`, 'error');
}
window.addEventListener('error', (e) => reportUnexpected(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportUnexpected(e.reason));
window.addEventListener('offline', () => setStatus('You are offline. Editing still works; Save, Compile and Refresh need a connection.', 'error'));
window.addEventListener('online', () => setStatus('Back online.'));

// ---------- Wiring ----------

$('help').addEventListener('click', () => { $('app-version').textContent = `v${__APP_VERSION__}`; $<HTMLDialogElement>('help-dialog').showModal(); });
$('help-close').addEventListener('click', () => $<HTMLDialogElement>('help-dialog').close());

// PDF page navigation
pdf.onPage = (page, total) => {
  const input = $<HTMLInputElement>('pdf-page');
  $('page-nav').hidden = !total || $('pdf').hidden;
  $('pdf-total').textContent = String(total);
  input.max = String(total);
  if (document.activeElement !== input) input.value = page ? String(page) : '';
};
$('pdf-page').addEventListener('change', () => { const n = Number($<HTMLInputElement>('pdf-page').value); if (Number.isFinite(n) && n >= 1) pdf.goToPage(n); });

// Drop files onto the file list to upload them; drop a ZIP on the start screen to import a project.
function enableDrop(el: HTMLElement, handle: (files: File[]) => void, accept: () => boolean) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => { if (accept() && e.dataTransfer?.types.includes('Files')) { depth++; el.classList.add('dropping'); e.preventDefault(); } });
  el.addEventListener('dragover', (e) => { if (accept() && e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('dropping'); });
  el.addEventListener('drop', (e) => {
    depth = 0;
    el.classList.remove('dropping');
    if (!accept() || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    handle([...e.dataTransfer.files]);
  });
}
enableDrop(document.querySelector<HTMLElement>('.panel.files')!, (files) => void upload(files), () => !!ws && !!project && sideTab === 'files');
enableDrop($('home'), (files) => {
  const zips = files.filter((f) => /\.zip$/i.test(f.name));
  if (!zips.length) { setStatus('Drop a .zip file to import a project.', 'error'); return; }
  for (const z of zips) void uploadProjectZip(z);
}, () => !!ws);

$('home-compiler').addEventListener('click', openCompilerDialog);
$('p-open-compiler').addEventListener('click', () => { $<HTMLDialogElement>('project-dialog').close(); openCompilerDialog(); });
$('c-cancel').addEventListener('click', () => $<HTMLDialogElement>('compiler-dialog').close());
$('c-ok').addEventListener('click', applyCompilerDialog);
$('c-texlive').addEventListener('change', () => { $('c-texlive-hint').textContent = describeTexlive($<HTMLSelectElement>('c-texlive').value); });
$('brand').addEventListener('click', showHome);
$('home-btn').addEventListener('click', showHome);
$('home-new').addEventListener('click', () => openProjectDialog('new'));
$('home-upload').addEventListener('click', () => $<HTMLInputElement>('zip-upload').click());
$<HTMLInputElement>('zip-upload').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) void uploadProjectZip(input.files[0]).finally(() => { input.value = ''; });
});
$('home-search').addEventListener('input', renderHome);
$('home-sort').addEventListener('change', renderHome);
$('p-template').addEventListener('change', applyTemplateToDialog);
$('settings').addEventListener('click', openPrefs);
$('connection').addEventListener('click', () => openSettings());
$('welcome-connect').addEventListener('click', () => openSettings());
$('banner-close').addEventListener('click', hideBanner);

// Resizable panels (desktop). Widths are remembered in this browser.
(() => {
  const layout = $('layout');
  const KEY = 'prism.layout';
  const apply = (filesW: number, edFrac: number) => {
    layout.style.setProperty('--files-w', `${filesW}px`);
    layout.style.setProperty('--ed', `${edFrac}fr`);
    layout.style.setProperty('--out', `${1 - edFrac}fr`);
  };
  let filesW = 260;
  let edFrac = 0.5;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { filesW: number; edFrac: number } | null;
    if (saved) ({ filesW, edFrac } = saved);
  } catch { /* storage blocked */ }
  const clamp = () => {
    filesW = Math.min(520, Math.max(160, Number(filesW) || 260));
    edFrac = Math.min(0.8, Math.max(0.2, Number(edFrac) || 0.5));
    apply(filesW, edFrac);
  };
  const remember = () => { try { localStorage.setItem(KEY, JSON.stringify({ filesW, edFrac })); } catch { /* ignore */ } };
  clamp();
  for (const g of document.querySelectorAll<HTMLElement>('.gutter')) {
    const which = g.dataset.gutter;
    const update = (clientX: number) => {
      const box = layout.getBoundingClientRect();
      if (which === 'files') filesW = clientX - box.left - 8;
      else {
        const left = box.left + 8 + filesW + 6;
        const width = box.width - 16 - filesW - 12;
        edFrac = (clientX - left) / width;
      }
      clamp();
    };
    g.addEventListener('pointerdown', (e) => {
      g.setPointerCapture(e.pointerId);
      g.classList.add('dragging');
      document.body.classList.add('resizing');
    });
    g.addEventListener('pointermove', (e) => { if (g.hasPointerCapture(e.pointerId)) update(e.clientX); });
    const end = (e: PointerEvent) => {
      if (!g.hasPointerCapture(e.pointerId)) return;
      g.releasePointerCapture(e.pointerId);
      g.classList.remove('dragging');
      document.body.classList.remove('resizing');
      remember();
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    g.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      if (which === 'files') filesW += step * 20;
      else edFrac += step * 0.04;
      clamp();
      remember();
    });
  }
})();

$('s-cancel').addEventListener('click', () => $<HTMLDialogElement>('settings-dialog').close());
$('s-save').addEventListener('click', () => void submitSettings());
for (const r of document.querySelectorAll('input[name="s-mode"]')) r.addEventListener('change', syncPassField);
$('s-forget').addEventListener('click', () => {
  if (!confirm('Remove the token, unsaved drafts and preferences from this browser?\n\nUnsaved changes that were never saved to GitHub will be lost.')) return;
  store.clearAllLocalData();
  location.reload();
});
$('u-ok').addEventListener('click', () => void submitUnlock());
$('u-forget').addEventListener('click', () => {
  if (!confirm('Forget the stored token and any drafts kept in this browser?')) return;
  store.clearAllLocalData();
  location.reload();
});
$('pf-close').addEventListener('click', () => $<HTMLDialogElement>('prefs-dialog').close());
for (const id of ['pf-theme', 'pf-size', 'pf-jump', 'pf-lang', 'pf-spell', 'pf-follow']) $(id).addEventListener('change', prefsChanged);
$('p-cancel').addEventListener('click', () => $<HTMLDialogElement>('project-dialog').close());
$('p-ok').addEventListener('click', submitProjectDialog);
$('setup-cancel').addEventListener('click', () => $<HTMLDialogElement>('setup-dialog').close());
$('setup-ok').addEventListener('click', () => void runSetup());
$('history-close').addEventListener('click', () => $<HTMLDialogElement>('history-dialog').close());
$('history-restore').addEventListener('click', restoreVersion);
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox' && (e.target as HTMLInputElement).type !== 'radio') {
      e.preventDefault();
      (d.querySelector('button.primary') as HTMLButtonElement | null)?.click();
    }
  });
}

$<HTMLSelectElement>('project').addEventListener('change', (e) => void selectProject((e.target as HTMLSelectElement).value));
$('new-project').addEventListener('click', () => openProjectDialog('new'));
$('project-settings').addEventListener('click', () => openProjectDialog('edit'));
$('save').addEventListener('click', () => void save());
$('compile').addEventListener('click', () => void (compiling ? stopCompile() : runCompile()));
$('forward').addEventListener('click', () => void forwardSearch());
$('history').addEventListener('click', () => void openHistory());
$('new-file').addEventListener('click', newFile);
$('upload-btn').addEventListener('click', () => $<HTMLInputElement>('upload').click());
$<HTMLInputElement>('upload').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) void upload(input.files).finally(() => { input.value = ''; });
});
$('rename').addEventListener('click', renameSelected);
$('delete').addEventListener('click', deleteSelected);
$('download').addEventListener('click', () => void downloadSelected());
$('zip').addEventListener('click', () => void downloadZip());
$('refresh').addEventListener('click', () => void refresh());
$('show-pdf').addEventListener('click', () => showOutput('pdf'));
$('show-log').addEventListener('click', () => showOutput('log'));
$('zoom-in').addEventListener('click', () => pdf.setZoom('in'));
$('zoom-out').addEventListener('click', () => pdf.setZoom('out'));
$('zoom-fit').addEventListener('click', () => pdf.setZoom('fit'));
$('download-pdf').addEventListener('click', () => {
  if (lastBuild?.pdf && project) download(`${project.Project}.pdf`, lastBuild.pdf, 'application/pdf');
});
for (const t of ['files', 'outline', 'search'] as const) $(`tab-${t}`).addEventListener('click', () => setSideTab(t));
$('search-form').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(searchTimer); void runSearch(); });
$('replace-form').addEventListener('submit', (e) => { e.preventDefault(); void replaceAll(); });
for (const id of ['search-q', 'search-case', 'search-re']) {
  $(id).addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void runSearch(), 300); });
  $(id).addEventListener('change', () => void runSearch());
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.view-tabs button')) {
  b.addEventListener('click', () => { document.body.dataset.view = b.dataset.view!; });
}

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  if (mod && e.key === 'Enter' && !compiling) { e.preventDefault(); void runCompile(); }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'f' && ws) {
    e.preventDefault();
    showView('files');
    setSideTab('search');
  }
});
window.addEventListener('beforeunload', (e) => {
  flushEdits();
  if (ws?.dirty) e.preventDefault(); // text drafts are kept, uploads and deletions are not
});
// Pick up pushes from Codex/Claude or another device when coming back to the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderBanner(); // the expiry date may have come within 10 days meanwhile
  if (document.visibilityState === 'visible' && ws && !saving) void refresh();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (prefs.theme === 'auto') rebuildEditorStates(); });

// ---------- Start ----------

applyPrefs(prefs);
setEnabled();
closeEditor();
const loaded = store.loadSettings();
if (!loaded) openSettings();
else if ('locked' in loaded) openUnlock(loaded.locked);
else void connect(loaded.settings);
