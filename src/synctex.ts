// SyncTeX: maps between source lines and PDF positions. Parses the .synctex data written by latexmk -synctex=1.
// All coordinates returned here are PDF points (bp, 1/72 inch) from the TOP-LEFT of the page, like pdf.js viewports.

import { gunzipSync } from 'fflate';

export interface SyncBox {
  tag: number; // input file number
  line: number; // 1-based source line
  x: number;
  y: number; // top edge
  w: number;
  h: number; // height including depth
}

export interface SyncTex {
  inputs: Map<number, string>;
  pages: SyncBox[][]; // index = sheet number - 1
}

export interface Rect { x: number; y: number; w: number; h: number }

/** 1 bp = 65781.76 sp (TeX scaled points). */
const BP = 65781.76;

export function parseSynctexFile(bytes: Uint8Array): SyncTex {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return parseSynctex(new TextDecoder().decode(raw));
}

export function parseSynctex(text: string): SyncTex {
  const inputs = new Map<number, string>();
  const pages: SyncBox[][] = [];
  let unit = 1, mag = 1000, xoff = 0, yoff = 0;
  let cur: SyncBox[] | null = null;
  let inContent = false;
  const n = text.length;
  for (let start = 0; start < n;) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = n;
    const c = text[start];
    if (c === 'I' && text.startsWith('Input:', start)) {
      const m = /^Input:(\d+):(.*)$/.exec(text.slice(start, end).replace(/\r$/, ''));
      if (m) inputs.set(Number(m[1]), m[2]);
    } else if (!inContent) {
      const line = text.slice(start, end);
      if (line.startsWith('Magnification:')) mag = Number(line.slice(14)) || 1000;
      else if (line.startsWith('Unit:')) unit = Number(line.slice(5)) || 1;
      else if (line.startsWith('X Offset:')) xoff = Number(line.slice(9)) || 0;
      else if (line.startsWith('Y Offset:')) yoff = Number(line.slice(9)) || 0;
      else if (line.startsWith('Content:')) inContent = true;
    } else if (c === '{') {
      const num = parseInt(text.slice(start + 1, end), 10);
      cur = Number.isFinite(num) && num > 0 ? (pages[num - 1] ??= []) : null;
    } else if (c === '}') {
      cur = null;
    } else if (cur && (c === '(' || c === '[' || c === 'h' || c === 'v')) {
      // type tag,line[,column]:h,v:W,H,D   (sizes in sp)
      const f = text.slice(start + 1, end).split(':');
      if (f.length >= 3) {
        const a = f[0].split(',');
        const p = f[1].split(',');
        const s = f[2].split(',');
        const line = Number(a[1]);
        const W = Number(s[0]), H = Number(s[1]), D = Number(s[2]);
        if (line > 0 && W > 0 && H + D > 0) {
          const k = (unit * mag) / 1000;
          cur.push({
            tag: Number(a[0]), line,
            x: (Number(p[0]) * k + xoff) / BP,
            y: ((Number(p[1]) - H) * k + yoff) / BP,
            w: (W * k) / BP,
            h: ((H + D) * k) / BP,
          });
        }
      }
    }
    start = end + 1;
  }
  return { inputs, pages };
}

function normalise(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Maps SyncTeX input numbers to repository paths. Absolute paths from the compile container
 * ("/work/<project>/…") are cut at the project folder; relative ones are resolved against the main file's folder.
 */
export function mapInputs(inputs: Map<number, string>, projectRoot: string, mainDir: string, repoPaths: { has(p: string): boolean }): Map<number, string> {
  const out = new Map<number, string>();
  const marker = `/${projectRoot}/`;
  for (const [tag, raw] of inputs) {
    const p = raw.replace(/\\/g, '/');
    let rel: string;
    const i = p.indexOf(marker);
    if (i >= 0) rel = normalise(p.slice(i + 1));
    else if (!/^([A-Za-z]:)?\//.test(p)) rel = normalise(`${mainDir}/${p}`);
    else continue; // system file (TeX Live, MiKTeX)
    if (repoPaths.has(rel)) out.set(tag, rel);
  }
  return out;
}

export interface Forward { page: number; rects: Rect[]; exact: boolean }

/** Source line -> PDF position. Uses the nearest line that produced output when `line` itself did not. */
export function forward(st: SyncTex, tags: Set<number>, line: number): Forward | null {
  let bestLine = -1;
  let bestDist = Infinity;
  for (const page of st.pages) {
    for (const b of page ?? []) {
      if (!tags.has(b.tag)) continue;
      const d = Math.abs(b.line - line);
      if (d < bestDist || (d === bestDist && b.line > bestLine)) { bestDist = d; bestLine = b.line; }
    }
  }
  if (bestLine < 0) return null;
  for (let i = 0; i < st.pages.length; i++) {
    const hits = (st.pages[i] ?? []).filter((b) => tags.has(b.tag) && b.line === bestLine);
    if (!hits.length) continue;
    // Keep only the innermost boxes: drop a box when another hit lies inside it (page-sized containers).
    const small = hits.slice().sort((a, b) => a.w * a.h - b.w * b.h).slice(0, 200);
    // Identical boxes must not eliminate each other: ties go to the earlier one, so at least one box survives.
    const leaves = small.filter((b, bi) => !small.some((o, oi) => o !== b
      && (o.w * o.h < b.w * b.h || (o.w * o.h === b.w * b.h && oi < bi))
      && o.x >= b.x - 0.01 && o.y >= b.y - 0.01 && o.x + o.w <= b.x + b.w + 0.01 && o.y + o.h <= b.y + b.h + 0.01));
    return { page: i + 1, rects: leaves.slice(0, 40).map(({ x, y, w, h }) => ({ x, y, w, h })), exact: bestLine === line };
  }
  return null;
}

export interface Inverse { tag: number; line: number }

/** PDF position -> source. Picks the smallest box under the point, else the nearest one within 30 bp. */
export function inverse(st: SyncTex, page: number, x: number, y: number, usable: (tag: number) => boolean): Inverse | null {
  const boxes = st.pages[page - 1];
  if (!boxes) return null;
  let best: SyncBox | null = null;
  let bestArea = Infinity;
  for (const b of boxes) {
    if (!usable(b.tag)) continue;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h && b.w * b.h < bestArea) { best = b; bestArea = b.w * b.h; }
  }
  if (!best) {
    let bestD = 30;
    for (const b of boxes) {
      if (!usable(b.tag)) continue;
      const d = Math.hypot(Math.max(b.x - x, 0, x - (b.x + b.w)), Math.max(b.y - y, 0, y - (b.y + b.h)));
      if (d < bestD) { bestD = d; best = b; }
    }
  }
  return best ? { tag: best.tag, line: best.line } : null;
}
