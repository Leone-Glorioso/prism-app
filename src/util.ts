// Small pure helpers. Covered by util.test.ts.

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8 = new TextEncoder();

/** Text for editing, or null when the bytes are not UTF-8 text. ignoreBOM keeps a BOM so saving restores it. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

export function encodeText(text: string): Uint8Array {
  return utf8.encode(text);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export type Eol = '\n' | '\r\n';

/** CodeMirror works with "\n"; remember the file's line ending so saving does not rewrite every line. */
export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function applyEol(lfText: string, eol: Eol): string {
  return eol === '\n' ? lfText : lfText.replace(/\r?\n/g, '\r\n');
}

export function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};
export function imageType(path: string): string | undefined {
  return IMAGE_TYPES[extension(path)];
}

const TEX_LIKE = new Set(['tex', 'sty', 'cls', 'ltx', 'dtx', 'ins', 'def', 'cfg', 'clo', 'bbx', 'cbx', 'lbx', 'tikz', 'bib']);
export function isTexLike(path: string): boolean {
  return TEX_LIKE.has(extension(path));
}

/**
 * Validates a repository-relative path typed by the user. Returns the cleaned path or an error message.
 */
export function cleanPath(input: string): { path: string } | { error: string } {
  const path = input.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (!path) return { error: 'Empty path.' };
  const parts = path.split('/');
  if (parts.some((p) => p === '.' || p === '..')) return { error: 'Paths may not contain "." or ".." segments.' };
  if (parts[0] === '.git' || parts[0] === '.github') return { error: 'Repository control folders cannot be edited here.' };
  if (/[\u0000-\u001f]/.test(path)) return { error: 'Control characters are not allowed in paths.' };
  return { path };
}

export function joinPath(dir: string, rel: string): string {
  return dir ? `${dir}/${rel}` : rel;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Resolves a path from a TeX log ("./chapters/x.tex") against the main file's folder. */
export function resolveLogPath(mainDir: string, logPath: string): string | null {
  if (logPath.startsWith('/')) return null; // TeX Live system file
  const out = mainDir ? mainDir.split('/') : [];
  for (const part of logPath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

export interface LogIssue {
  kind: 'error' | 'warning';
  message: string;
  file?: string; // as written in the log
  line?: number;
}

/** Extracts errors (file-line-error format and "! ..." lines) and LaTeX/package warnings from a TeX log. */
export function parseLog(log: string): LogIssue[] {
  const issues: LogIssue[] = [];
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fle = /^(\.{0,2}\/?[^:\s][^:]*\.[A-Za-z0-9]+):(\d+): (.*)$/.exec(l);
    if (fle) {
      issues.push({ kind: 'error', file: fle[1], line: Number(fle[2]), message: fle[3] });
      continue;
    }
    if (l.startsWith('! ')) {
      // Without -file-line-error the location comes later as "l.<n> ...".
      let line: number | undefined;
      for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
        const m = /^l\.(\d+)/.exec(lines[j]);
        if (m) { line = Number(m[1]); break; }
      }
      issues.push({ kind: 'error', message: l.slice(2), line });
      continue;
    }
    const w = /^((?:LaTeX|Package|Class) (?:\S+ )?Warning: .*)$/.exec(l);
    if (w) {
      let message = w[1];
      // Warnings continue on following lines that start with "(<package>)" padding.
      while (i + 1 < lines.length && /^\([^)]*\)\s{2,}/.test(lines[i + 1])) message += ' ' + lines[++i].replace(/^\([^)]*\)\s+/, '');
      const ln = /on input line (\d+)/.exec(message);
      issues.push({ kind: 'warning', message, line: ln ? Number(ln[1]) : undefined });
    }
  }
  return issues;
}

/** Builds branch name shared with compile.yml: builds/<first 12 hex of SHA-1 of the UTF-8 project name>. */
export async function buildBranch(project: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', encodeText(project));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `builds/${hex.slice(0, 12)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
