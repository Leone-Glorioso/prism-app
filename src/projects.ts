// Pure helpers for creating projects from names, templates and ZIP files.

import { unzipSync } from 'fflate';
import { cleanPath } from './util';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_BYTES = 150 * 1024 * 1024;

/** A name not used yet (case-insensitively), by appending " 2", " 3" … */
export function uniqueName(base: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  const clean = base.replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Project';
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean} ${i}`.toLowerCase())) return `${clean} ${i}`;
}

/** Project name from a file name: "My Thesis.zip" -> "My Thesis". */
export function nameFromFile(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9]+$/, '').replace(/[_]+/g, ' ').replace(/[\\/]+/g, ' ').trim() || 'Project';
}

/** Engine to use, judged from the document's own packages. */
export function guessEngine(mainText: string): 'pdflatex' | 'xelatex' | 'lualatex' {
  const t = mainText.split(/\r?\n/).filter((l) => !l.trim().startsWith('%')).join('\n');
  if (/\\(?:directlua|luaexec)\b|\\usepackage(?:\[[^\]]*\])?\{(?:luacode|luatexbase|luamplib)\}/.test(t)) return 'lualatex';
  if (/\\usepackage(?:\[[^\]]*\])?\{(?:fontspec|polyglossia|unicode-math|xeCJK|xltxtra|xunicode)\}|\\set(?:main|sans|mono)font\b/.test(t)) return 'xelatex';
  return 'pdflatex';
}

/** Main file among the files of a project: a top-level .tex with \documentclass, preferring main/ms/thesis names. */
export function pickMainFile(files: string[], read: (path: string) => string | undefined): string | null {
  const tex = files.filter((f) => /\.tex$/i.test(f));
  const hasClass = (f: string) => /\\documentclass\b/.test((read(f) ?? '').split(/\r?\n/).filter((l) => !l.trim().startsWith('%')).join('\n'));
  const candidates = tex.filter(hasClass);
  const pool = candidates.length ? candidates : tex;
  if (!pool.length) return null;
  const score = (f: string) => {
    const depth = f.split('/').length - 1;
    const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase();
    const named = /^(main|msc|thesis|paper|report|article|index|document)\.tex$/.test(base) ? 0 : 1;
    return depth * 10 + named * 3 + (hasClass(f) ? 0 : 5);
  };
  return [...pool].sort((a, b) => score(a) - score(b) || a.localeCompare(b))[0];
}

export interface ZipResult {
  files: Map<string, Uint8Array>;
  skipped: string[];
}

/**
 * Reads a ZIP safely: no absolute or ".." paths, no junk (__MACOSX, .DS_Store, .git), limits on file and total size,
 * and a single wrapper folder is removed ("Thesis/main.tex" -> "main.tex").
 */
export function readZip(data: Uint8Array): ZipResult {
  let total = 0;
  const skipped: string[] = [];
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(data, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        if (f.originalSize > MAX_FILE_BYTES) { skipped.push(`${f.name} (larger than ${MAX_FILE_BYTES / 1024 / 1024} MB)`); return false; }
        total += f.originalSize;
        if (total > MAX_ZIP_BYTES) throw new Error(`The ZIP expands to more than ${MAX_ZIP_BYTES / 1024 / 1024} MB.`);
        return true;
      },
    });
  } catch (e) {
    throw new Error(e instanceof Error && e.message.includes('expands') ? e.message : 'This file is not a valid ZIP archive.');
  }
  const entries = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(raw)) {
    const norm = name.replace(/\\/g, '/');
    if (/(^|\/)(__MACOSX|\.git|\.DS_Store|Thumbs\.db)(\/|$)/.test(norm)) continue;
    const c = cleanPath(norm);
    if ('error' in c) { skipped.push(`${name} (${c.error})`); continue; }
    entries.set(c.path, bytes);
  }
  // Remove one common wrapper folder.
  const firsts = new Set([...entries.keys()].map((p) => p.split('/')[0]));
  const allNested = [...entries.keys()].every((p) => p.includes('/'));
  if (firsts.size === 1 && allNested) {
    const wrapper = [...firsts][0] + '/';
    return { files: new Map([...entries].map(([p, b]) => [p.slice(wrapper.length), b])), skipped };
  }
  return { files: entries, skipped };
}

/** "3 days ago", "yesterday", "just now" for a timestamp. */
export function timeAgo(then: number, now = Date.now()): string {
  const s = Math.round((now - then) / 1000);
  if (s < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year']];
  let v = s;
  for (const [div, unit] of steps) {
    if (Math.abs(v) < div) return rtf.format(-Math.round(v), unit);
    v /= div;
  }
  return '';
}
