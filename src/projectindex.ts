// Loads the text files of one project (cached by blob SHA) for search, outline and auto-completion.

import type { Workspace } from './workspace';
import { decodeText, extension } from './util';

const SEARCHABLE = new Set(['tex', 'sty', 'cls', 'bib', 'bbl', 'ltx', 'bst', 'bbx', 'cbx', 'lbx', 'def', 'cfg', 'tikz', 'txt', 'md', 'csv', 'json', 'r', 'py', 'sh', 'yml', 'yaml']);
export const isSearchable = (path: string) => SEARCHABLE.has(extension(path));

export class ProjectIndex {
  private cache = new Map<string, string | null>(); // blob sha -> text (null: binary or too large)

  constructor(private ws: Workspace, private maxBytes = 1_500_000) {}

  async texts(root: string, filter: (path: string) => boolean = isSearchable): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const paths = this.ws.paths().filter((p) => p.startsWith(`${root}/`) && filter(p));
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        const p = paths[next++];
        const t = await this.textOf(p);
        if (t !== null) out.set(p, t);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, paths.length) }, worker));
    return out;
  }

  private async textOf(path: string): Promise<string | null> {
    const change = this.ws.changes.get(path);
    if (change?.kind === 'put') return decodeText(change.bytes);
    const entry = this.ws.files.get(path);
    const sha = change?.kind === 'copy' ? change.sha : entry?.sha;
    if (!sha) return null;
    const cached = this.cache.get(sha);
    if (cached !== undefined) return cached;
    if (entry?.size !== undefined && entry.size > this.maxBytes) { this.cache.set(sha, null); return null; }
    try {
      const t = decodeText(await this.ws.read(path));
      this.cache.set(sha, t);
      return t;
    } catch {
      return null; // a file that cannot be read is skipped, not fatal
    }
  }
}
