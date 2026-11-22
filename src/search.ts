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
