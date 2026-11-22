// Document outline: sections across \input / \include files, starting from the main file.

import { dirname, joinPath } from './util';

export interface OutlineItem {
  level: number; // 0 part … 5 paragraph
  title: string;
  file: string;
  line: number; // 1-based
}

const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

/** Removes a LaTeX comment (an unescaped % to the end of the line). */
export function stripComment(line: string): string {
  return line.replace(/(^|[^\\])%.*$/, '$1');
}

/** Title text from the opening brace at `from`, honouring nested braces; stops at the end of the line if unbalanced. */
function braced(line: string, from: number): string {
  let depth = 0;
  let out = '';
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { out += line[i] + line[i + 1]; i++; continue; }
    if (c === '{') { depth++; if (depth === 1) continue; }
    if (c === '}') { depth--; if (depth === 0) return out; }
    out += c;
  }
  return out;
}

/** Plain-ish title: drops \label{…}, \texorpdfstring keeps the second part, removes remaining commands. */
export function cleanTitle(t: string): string {
  return t
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\texorpdfstring\{[^{}]*\}\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:textbf|textit|emph|texttt|textsc|foreignlanguage\{[^}]*\})\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+\*?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Parsed {
  /** Sections and includes in source order. */
  entries: ({ kind: 'item'; item: OutlineItem } | { kind: 'include'; target: string; line: number })[];
}

export function parseOutline(text: string, file: string): Parsed {
  const entries: Parsed['entries'] = [];
  const lines = text.split(/\r?\n/);
  let verbatim = false;
  lines.forEach((raw, i) => {
    if (/\\begin\{(verbatim|lstlisting|minted)\*?\}/.test(raw)) verbatim = true;
    if (verbatim) {
      if (/\\end\{(verbatim|lstlisting|minted)\*?\}/.test(raw)) verbatim = false;
      return;
    }
    const line = stripComment(raw);
    const re = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{|\\(input|include)\s*\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m[1]) {
        const title = cleanTitle(braced(line, m.index + m[0].length - 1));
        entries.push({ kind: 'item', item: { level: LEVELS[m[1]], title: title || `(${m[1]})`, file, line: i + 1 } });
      } else {
        entries.push({ kind: 'include', target: m[3].trim(), line: i + 1 });
      }
    }
  });
  return { entries };
}

/** Outline of the whole document: follows \input / \include from `main`, expanding each at its position. */
export function projectOutline(main: string, read: (path: string) => string | undefined): OutlineItem[] {
  const mainDir = dirname(main);
  const out: OutlineItem[] = [];
  const stack = new Set<string>();
  const walk = (file: string, depth: number) => {
    const text = read(file);
    if (text === undefined || stack.has(file) || depth > 8) return;
    stack.add(file);
    for (const e of parseOutline(text, file).entries) {
      if (e.kind === 'item') out.push(e.item);
      else {
        const target = /\.[A-Za-z0-9]+$/.test(e.target) ? e.target : `${e.target}.tex`;
        walk(joinPath(mainDir, target.replace(/^\.\//, '')), depth + 1);
      }
    }
    stack.delete(file);
  };
  walk(main, 0);
  return out;
}

/** Rough word count of prose: ignores comments, commands and math. */
export function wordCount(text: string): number {
  const prose = text
    .split(/\r?\n/).map(stripComment).join('\n')
    .replace(/\\begin\{(equation|align|eqnarray|displaymath|gather|multline)\*?\}[\s\S]*?\\end\{\1\*?\}/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, ' ')
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, ' ')
    .replace(/[{}\\~&_^#]/g, ' ');
  return (prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}
