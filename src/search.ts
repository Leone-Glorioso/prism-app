// Project-wide text search over already loaded files.

export interface Hit {
  file: string;
  line: number; // 1-based
  col: number; // 0-based
  length: number;
  text: string; // the line, trimmed for display
  markStart: number; // where the match starts inside `text`
}

export interface SearchResult {
  hits: Hit[];
  truncated: boolean;
  error?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function searchTexts(texts: Map<string, string>, query: string, opts: { regex: boolean; caseSensitive: boolean; max: number }): SearchResult {
  if (!query) return { hits: [], truncated: false };
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? query : escapeRe(query), opts.caseSensitive ? 'g' : 'gi');
  } catch (e) {
    return { hits: [], truncated: false, error: (e as Error).message };
  }
  const hits: Hit[] = [];
  for (const file of [...texts.keys()].sort()) {
    const lines = texts.get(file)!.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i]))) {
        if (m[0] === '') { re.lastIndex++; continue; } // an empty regex match would loop forever
        if (hits.length >= opts.max) return { hits, truncated: true };
        const lead = lines[i].length - lines[i].trimStart().length;
        hits.push({ file, line: i + 1, col: m.index, length: m[0].length, text: lines[i].trim().slice(0, 240), markStart: Math.max(0, m.index - lead) });
      }
    }
  }
  return { hits, truncated: false };
}

export interface ReplaceResult {
  /** New text of every file that changes, with the number of replacements. */
  changed: Map<string, { text: string; count: number }>;
  total: number;
  error?: string;
}

/**
 * Replaces matches line by line (same semantics as the search, so counts agree). Line endings are kept exactly.
 * In plain mode the replacement is literal; in regex mode "$1" style group references work.
 */
export function replaceInTexts(texts: Map<string, string>, query: string, replacement: string, opts: { regex: boolean; caseSensitive: boolean }): ReplaceResult {
  const changed = new Map<string, { text: string; count: number }>();
  if (!query) return { changed, total: 0 };
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? query : escapeRe(query), opts.caseSensitive ? 'g' : 'gi');
  } catch (e) {
    return { changed, total: 0, error: (e as Error).message };
  }
  let total = 0;
  for (const [file, text] of texts) {
    let count = 0;
    // The split keeps the line separators (\n or \r\n) as odd entries; they are copied untouched.
    const parts = text.split(/(\r?\n)/).map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(re, (...args: unknown[]) => {
        const match = args[0] as string;
        if (match === '') return match; // never insert text at empty matches
        count++;
        if (!opts.regex) return replacement;
        const hasNamedGroups = typeof args[args.length - 1] === 'object';
        const captures = args.slice(1, args.length - (hasNamedGroups ? 3 : 2)) as (string | undefined)[];
        return expandReplacement(replacement, match, captures);
      });
    });
    if (count > 0) { changed.set(file, { text: parts.join(''), count }); total += count; }
  }
  return { changed, total };
}

/** Expands $$, $& and $1..$99 like String.prototype.replace does. */
function expandReplacement(repl: string, match: string, captures: (string | undefined)[]): string {
  return repl.replace(/\$(\$|&|\d{1,2})/g, (whole, g: string) => {
    if (g === '$') return '$';
    if (g === '&') return match;
    const n = Number(g);
    return n >= 1 && n <= captures.length ? (captures[n - 1] ?? '') : whole;
  });
}
