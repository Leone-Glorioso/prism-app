import './style.css';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { zipSync } from 'fflate';
import { GitHub, GitHubError } from './github';
import { Workspace, ConflictError } from './workspace';
import { compile, fetchBuild, Build, CompileCancelled } from './compile';
import { PdfView } from './pdfview';
import { createState, createView, goToLine } from './editor';
import * as store from './storage';
import { applyIcons, icon } from './icons';
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

const MANIFEST = 'prism-projects.json';
const MAX_UPLOAD = 50 * 1024 * 1024;

let settings = store.loadSettings();
let gh: GitHub | null = null;
let ws: Workspace | null = null;
let manifest: ManifestEntry[] = [];
let project: ManifestEntry | null = null;
let current: string | null = null; // open file path
let selected: string | null = null; // selected tree item (file path or folder path ending with "/")
const open = new Map<string, OpenFile>();
const expanded = new Set<string>();
let compileSeq = 0;
let compiling = false;
let lastBuild: Build | null = null;
let previewUrl: string | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const view: EditorView = createView($('editor'));
const pdf = new PdfView($('pdf'));
pdf.onChange = () => { renderBuildInfo(); setEnabled(); };

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

function setEnabled() {
  const connected = !!ws;
  const hasProject = connected && !!project;
  for (const id of ['project', 'new-project']) ($(id) as HTMLButtonElement).disabled = !connected;
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
}

function download(name: string, bytes: Uint8Array, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

// ---------- Drafts (unsaved text kept in this browser) ----------

let draftTimer = 0;
function persistDrafts() {
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    if (!settings || !ws) return;
    const drafts: store.Drafts = {};
    for (const [path, c] of ws.changes) {
      if (c.kind !== 'put') continue;
      const text = decodeText(c.bytes);
      if (text !== null) drafts[path] = { text, base: c.base };
    }
    if (!store.saveDrafts(settings, drafts)) setStatus('Could not store a local draft (browser storage blocked or full). Save soon.', 'error');
  }, 400);
}

function restoreDrafts() {
  if (!settings || !ws) return 0;
  const drafts = store.loadDrafts(settings);
  for (const [path, d] of Object.entries(drafts)) ws.restore(path, encodeText(d.text), d.base);
  return Object.keys(drafts).length;
}

// ---------- Connect / manifest / projects ----------

async function connect() {
  if (!settings) return openSettings();
  gh = new GitHub(settings.token, settings.owner, settings.repo);
  ws = new Workspace(gh, settings.branch);
  open.clear();
  current = null;
  setStatus('Loading repository…', 'busy');
  try {
    await ws.load();
  } catch (e) {
    ws = null;
    setEnabled();
    setStatus(errorText(e), 'error');
    if (e instanceof GitHubError && (e.status === 401 || e.status === 404)) openSettings(errorText(e));
    return;
  }
  const restored = restoreDrafts();
  await loadManifest();
  const last = store.lastProject(settings);
  const pick = manifest.find((m) => m.Project === last) ?? manifest[0] ?? null;
  await selectProject(pick?.Project ?? null);
  setStatus(restored ? `Restored ${restored} unsaved file(s) from this browser.` : 'Ready.');
}

async function loadManifest() {
  if (!ws) return;
  manifest = [];
  if (ws.exists(MANIFEST)) {
    const text = decodeText(await ws.read(MANIFEST));
    try {
      const parsed: unknown = JSON.parse((text ?? '').replace(/^﻿/, ''));
      if (!Array.isArray(parsed)) throw new Error('not a list');
      manifest = parsed.filter((m): m is ManifestEntry => !!m && typeof m.Project === 'string' && typeof m.MainFile === 'string');
    } catch (e) {
      setStatus(`${MANIFEST} is not valid: ${errorText(e)}`, 'error');
    }
  }
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

async function selectProject(name: string | null) {
  project = manifest.find((m) => m.Project === name) ?? null;
  selected = null;
  lastBuild = null;
  pdf.clear();
  renderLog();
  closeEditor();
  if (!project) { renderTree(); setEnabled(); return; }
  $<HTMLSelectElement>('project').value = project.Project;
  if (settings) store.setLastProject(settings, project.Project);
  for (const d of dirParents(mainPath())) expanded.add(d);
  renderTree();
  setEnabled();
  if (ws!.exists(mainPath())) await openFile(mainPath());
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

// ---------- File tree ----------

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
      btn.innerHTML = icon('file'); // static SVG only
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

// ---------- Editor ----------

function closeEditor() {
  current = null;
  view.setState(EditorState.create({ doc: '' }));
  view.dom.hidden = true;
  showPreview(null);
  $('editor-title').textContent = 'Editor';
  $('editor-title').classList.remove('file-open');
  $('editor-empty').hidden = false;
}

function showPreview(content: HTMLElement | null) {
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  const pv = $('preview');
  pv.replaceChildren(...(content ? [content] : []));
  pv.hidden = !content;
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
  const cached = open.get(path);
  if (cached) {
    showPreview(null);
    view.dom.hidden = false;
    view.setState(cached.state);
    showView('editor');
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
    let url: string | null = null;
    if (img) {
      url = URL.createObjectURL(new Blob([bytes], { type: img }));
      const el = document.createElement('img');
      el.src = url;
      el.alt = basename(path);
      box.append(el);
    }
    const info = document.createElement('p');
    info.textContent = `${img ? 'Image' : 'Binary file'} · ${formatBytes(bytes.length)}. Use Download to open it, or Upload to replace it.`;
    box.append(info);
    showPreview(box);
    previewUrl = url; // revoked by the next showPreview
    return;
  }
  // Original = committed text; editing back to it drops the local change.
  let original = text;
  if (ws.changes.has(path)) {
    const committed = await ws.readCommitted(path);
    original = (committed && decodeText(committed)) ?? text;
  }
  const eol = detectEol(original);
  const state = createState(path, text.replace(/\r\n/g, '\n'), hooks);
  open.set(path, { state, original, eol });
  if (current !== path) return;
  showPreview(null);
  view.dom.hidden = false;
  view.setState(state);
  showView('editor');
}

let changeTimer = 0;
const pendingEdits = new Map<string, EditorState>();
const hooks = {
  onChange(path: string, state: EditorState) {
    const f = open.get(path);
    if (f) f.state = state;
    pendingEdits.set(path, state);
    clearTimeout(changeTimer);
    changeTimer = window.setTimeout(flushEdits, 300);
  },
  onSave: () => void save(),
  onCompile: () => void runCompile(),
};

/** Moves pending editor text into the workspace. */
function flushEdits() {
  clearTimeout(changeTimer);
  if (!ws) return;
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
  // Saved text is now the committed text.
  for (const f of open.values()) f.original = applyEol(f.state.doc.toString(), f.eol);
  persistDrafts();
  await afterRemoteChange();
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
  project = manifest.find((m) => m.Project === name) ?? null;
  if (current && (!ws!.exists(current) || !open.has(current))) {
    const p = current;
    closeEditor();
    if (ws!.exists(p)) await openFile(p);
  }
  renderTree();
  setEnabled();
}

// ---------- Compile / build output ----------

async function runCompile() {
  if (!gh || !project || !settings) return;
  if (!(await save())) return;
  const token = ++compileSeq;
  const name = project.Project;
  const started = Date.now();
  compiling = true;
  let phaseText = 'Starting compile…';
  setStatus(phaseText, 'busy');
  const tick = window.setInterval(() => {
    if (token === compileSeq) setStatus(`${phaseText} ${Math.round((Date.now() - started) / 1000)}s`, 'busy');
  }, 1000);
  try {
    const build = await compile(gh, settings.branch, name, (p) => {
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
    if (token === compileSeq) compiling = false;
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
  el.replaceChildren(badge, `${r.engine} · ${r.duration_seconds}s · ${when}${pages}${stale}`);
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
      btn.addEventListener('click', async () => {
        await openFile(target);
        if (issue.line) goToLine(view, issue.line);
      });
      li.append(btn);
    } else li.textContent = text;
    list.append(li);
  }
}

function showOutput(which: 'pdf' | 'log') {
  $('pdf').hidden = which !== 'pdf';
  $('log').hidden = which !== 'log';
  $('show-pdf').setAttribute('aria-pressed', String(which === 'pdf'));
  $('show-log').setAttribute('aria-pressed', String(which === 'log'));
  setEnabled();
  showView('output');
}

function showView(v: 'files' | 'editor' | 'output') {
  // Only matters on narrow screens, where one panel shows at a time.
  if (window.matchMedia('(max-width: 899px)').matches) document.body.dataset.view = v;
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

function relative(path: string) {
  return path.slice(projectRoot().length + 1);
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

async function upload(files: FileList) {
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

// ---------- Dialogs ----------

function openSettings(error = '') {
  const s = settings;
  $<HTMLInputElement>('s-owner').value = s?.owner ?? '';
  $<HTMLInputElement>('s-repo').value = s?.repo ?? 'prism-data';
  $<HTMLInputElement>('s-branch').value = s?.branch ?? 'main';
  $<HTMLInputElement>('s-token').value = s?.token ?? '';
  $('s-error').textContent = error;
  $<HTMLDialogElement>('settings-dialog').showModal();
}

async function submitSettings() {
  const next: store.Settings = {
    owner: $<HTMLInputElement>('s-owner').value.trim(),
    repo: $<HTMLInputElement>('s-repo').value.trim(),
    branch: $<HTMLInputElement>('s-branch').value.trim() || 'main',
    token: $<HTMLInputElement>('s-token').value.trim(),
  };
  const err = $('s-error');
  if (!next.owner || !next.repo || !next.token) { err.textContent = 'Owner, repository and token are required.'; return; }
  if (ws?.dirty && (next.owner !== settings?.owner || next.repo !== settings?.repo || next.branch !== settings?.branch)
    && !confirm('You have unsaved changes for the current repository. They stay as a draft only for text files. Switch anyway?')) return;
  err.textContent = 'Checking…';
  try {
    const test = new GitHub(next.token, next.owner, next.repo);
    const info = await test.getRepo();
    if (!info.permissions?.push) throw new Error('This token cannot write to the repository (needs Contents: read and write).');
    if (!(await test.getRefSha(next.branch))) throw new Error(`Branch "${next.branch}" does not exist.`);
    if (!info.private && !confirm('WARNING: this repository is PUBLIC, so everyone can read your files. Continue anyway?')) { err.textContent = ''; return; }
  } catch (e) {
    err.textContent = errorText(e);
    return;
  }
  if (!store.saveSettings(next)) err.textContent = 'Connected, but this browser blocks storage: you will need to enter the token again next time.';
  settings = next;
  $<HTMLDialogElement>('settings-dialog').close();
  await connect();
}

let projectDialogMode: 'new' | 'edit' = 'new';

function openProjectDialog(mode: 'new' | 'edit') {
  projectDialogMode = mode;
  $('p-title').textContent = mode === 'new' ? 'New project' : `Project settings: ${project?.Project}`;
  $('p-name-label').hidden = mode !== 'new';
  $('p-main-label').hidden = mode !== 'edit';
  $<HTMLInputElement>('p-name').value = '';
  $('p-error').textContent = '';
  const engine = $<HTMLSelectElement>('p-engine');
  engine.value = mode === 'edit' ? (project?.Engine ?? 'pdflatex').toLowerCase() : 'pdflatex';
  if (mode === 'edit' && project) {
    const root = projectRoot() + '/';
    const texFiles = ws!.paths().filter((p) => p.startsWith(root) && p.toLowerCase().endsWith('.tex'));
    $<HTMLSelectElement>('p-main').replaceChildren(...texFiles.map((p) => new Option(relative(p), p, false, p === mainPath())));
  }
  $<HTMLDialogElement>('project-dialog').showModal();
}

const TEMPLATE = `\\documentclass[11pt]{article}
\\usepackage[margin=2.5cm]{geometry}

\\title{Title}
\\author{Author}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Write here.

\\end{document}
`;

function submitProjectDialog() {
  const err = $('p-error');
  const engine = $<HTMLSelectElement>('p-engine').value;
  if (projectDialogMode === 'new') {
    const name = $<HTMLInputElement>('p-name').value.trim();
    const r = cleanPath(name);
    if ('error' in r) { err.textContent = r.error; return; }
    if (r.path.includes('/')) { err.textContent = 'The name cannot contain "/".'; return; }
    if (r.path === MANIFEST || manifest.some((m) => m.Project.toLowerCase() === name.toLowerCase())
      || ws!.paths().some((p) => p.toLowerCase().startsWith(name.toLowerCase() + '/'))) {
      err.textContent = 'A project or folder with that name already exists.';
      return;
    }
    const main = `${name}/main.tex`;
    ws!.put(main, encodeText(TEMPLATE));
    manifest.push({ Project: name, MainFile: main, Engine: engine, Bibliography: 'none', MissingBibliography: [], Status: 'New', Detail: 'Created in Prism web.' });
    writeManifest();
    persistDrafts();
    $<HTMLDialogElement>('project-dialog').close();
    void loadManifest().then(() => selectProject(name)).then(() => setStatus('Project created. Save or Compile to store it.'));
  } else if (project) {
    project.MainFile = $<HTMLSelectElement>('p-main').value || project.MainFile;
    project.Engine = engine;
    writeManifest();
    $<HTMLDialogElement>('project-dialog').close();
    renderTree();
    setStatus('Project settings changed. Save or Compile to store them.');
  }
}

// ---------- Wiring ----------

$('settings').addEventListener('click', () => openSettings());
$('welcome-connect').addEventListener('click', () => openSettings());

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
    filesW = Math.min(520, Math.max(160, filesW));
    edFrac = Math.min(0.8, Math.max(0.2, edFrac));
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
$('s-forget').addEventListener('click', () => {
  if (!confirm('Remove the token and settings from this browser? Unsaved drafts stay.')) return;
  store.saveSettings(null);
  settings = null;
  location.reload();
});
$('p-cancel').addEventListener('click', () => $<HTMLDialogElement>('project-dialog').close());
$('p-ok').addEventListener('click', submitProjectDialog);
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      (d.querySelector('button.primary') as HTMLButtonElement).click();
    }
  });
}

$<HTMLSelectElement>('project').addEventListener('change', (e) => void selectProject((e.target as HTMLSelectElement).value));
$('new-project').addEventListener('click', () => openProjectDialog('new'));
$('project-settings').addEventListener('click', () => openProjectDialog('edit'));
$('save').addEventListener('click', () => void save());
$('compile').addEventListener('click', () => void runCompile());
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
for (const b of document.querySelectorAll<HTMLButtonElement>('.view-tabs button')) {
  b.addEventListener('click', () => { document.body.dataset.view = b.dataset.view!; });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !compiling) { e.preventDefault(); void runCompile(); }
});
window.addEventListener('beforeunload', (e) => {
  flushEdits();
  if (ws?.dirty) e.preventDefault(); // text drafts are kept, uploads and deletions are not
});
// Pick up pushes from Codex/Claude or another device when coming back to the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws && !saving) void refresh();
});

setEnabled();
closeEditor();
void connect();
