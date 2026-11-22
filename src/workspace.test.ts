import { describe, expect, it } from 'vitest';
import { GitHubError, TreeEntry } from './github';
import { Api, ConflictError, Workspace } from './workspace';
import { encodeText } from './util';

/** In-memory fake of the Git Data API: commits are path->sha maps; trees are stored by id. */
class FakeGit implements Api {
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, { tree: string; parents: string[] }>();
  head = '';
  private n = 0;

  constructor(files: Record<string, string>) {
    const tree = this.newTree(new Map(Object.entries(files).map(([p, t]) => [p, this.blob(t)])));
    this.head = this.newCommit(tree, []);
  }
  private id(prefix: string) { return `${prefix}${++this.n}`; }
  blob(text: string) { const s = this.id('b'); this.blobs.set(s, encodeText(text)); return s; }
  private newTree(m: Map<string, string>) { const s = this.id('t'); this.trees.set(s, m); return s; }
  private newCommit(tree: string, parents: string[]) { const s = this.id('c'); this.commits.set(s, { tree, parents }); return s; }

  /** Simulates someone else pushing. */
  push(changes: Record<string, string | null>) {
    const m = new Map(this.trees.get(this.commits.get(this.head)!.tree)!);
    for (const [p, t] of Object.entries(changes)) if (t === null) m.delete(p); else m.set(p, this.blob(t));
    this.head = this.newCommit(this.newTree(m), [this.head]);
  }
  text(path: string) {
    const sha = this.trees.get(this.commits.get(this.head)!.tree)!.get(path);
    return sha ? new TextDecoder().decode(this.blobs.get(sha)) : null;
  }

  async getRefSha() { return this.head; }
  async getCommitTree(c: string) { return this.commits.get(c)!.tree; }
  async getTree(t: string): Promise<TreeEntry[]> {
    return [...this.trees.get(t)!].map(([path, sha]) => ({ path, sha, mode: '100644', type: 'blob' as const }));
  }
  async getBlob(sha: string) { return this.blobs.get(sha)!; }
  async createBlob(bytes: Uint8Array) { const s = this.id('b'); this.blobs.set(s, bytes); return s; }
  async createTree(base: string, entries: { path: string; sha: string | null }[]) {
    const m = new Map(this.trees.get(base)!);
    for (const e of entries) {
      if (e.sha === null) { if (!m.has(e.path)) throw new GitHubError(422, 'missing path'); m.delete(e.path); }
      else m.set(e.path, e.sha);
    }
    return this.newTree(m);
  }
  async createCommit(_msg: string, tree: string, parents: string[]) { return this.newCommit(tree, parents); }
  async updateRef(_b: string, sha: string) {
    if (this.commits.get(sha)!.parents[0] !== this.head) throw new GitHubError(422, 'not a fast forward');
    this.head = sha;
  }
}

const put = (ws: Workspace, p: string, t: string) => ws.put(p, encodeText(t));

describe('Workspace.save', () => {
  it('commits edits, additions, deletions and renames in one commit', async () => {
    const git = new FakeGit({ 'P/main.tex': 'a', 'P/old.tex': 'o', 'P/gone.tex': 'g' });
    const ws = new Workspace(git, 'main');
    await ws.load();
    put(ws, 'P/main.tex', 'A');
    put(ws, 'P/new.tex', 'n');
    ws.remove('P/gone.tex');
    ws.rename('P/old.tex', 'P/moved.tex');
    await ws.save('m');
    expect([git.text('P/main.tex'), git.text('P/new.tex'), git.text('P/gone.tex'), git.text('P/old.tex'), git.text('P/moved.tex')])
      .toEqual(['A', 'n', null, null, 'o']);
    expect(ws.dirty).toBe(false);
    expect(ws.baseCommit).toBe(git.head);
  });

  it('rebases automatically when others changed different files', async () => {
    const git = new FakeGit({ 'P/a.tex': 'a', 'P/b.tex': 'b' });
    const ws = new Workspace(git, 'main');
    await ws.load();
    put(ws, 'P/a.tex', 'mine');
    git.push({ 'P/b.tex': 'theirs' });
    await ws.save('m');
    expect([git.text('P/a.tex'), git.text('P/b.tex')]).toEqual(['mine', 'theirs']);
  });

  it('reports a conflict on the same file and never overwrites silently', async () => {
    const git = new FakeGit({ 'P/a.tex': 'a' });
    const ws = new Workspace(git, 'main');
    await ws.load();
    put(ws, 'P/a.tex', 'mine');
    git.push({ 'P/a.tex': 'theirs' });
    await expect(ws.save('m')).rejects.toBeInstanceOf(ConflictError);
    expect(git.text('P/a.tex')).toBe('theirs');
    await ws.save('m', ['P/a.tex']); // user chose "keep mine"
    expect(git.text('P/a.tex')).toBe('mine');
  });

  it('detects conflicts for drafts restored after a refresh', async () => {
    const git = new FakeGit({ 'P/a.tex': 'a' });
    const ws1 = new Workspace(git, 'main');
    await ws1.load();
    const base = ws1.files.get('P/a.tex')!.sha;
    git.push({ 'P/a.tex': 'theirs' });
    const ws2 = new Workspace(git, 'main'); // e.g. the page was reloaded later
    await ws2.load();
    ws2.restore('P/a.tex', encodeText('draft'), base);
    await expect(ws2.save('m')).rejects.toBeInstanceOf(ConflictError);
  });

  it('tolerates a file deleted on both sides', async () => {
    const git = new FakeGit({ 'P/a.tex': 'a', 'P/b.tex': 'b' });
    const ws = new Workspace(git, 'main');
    await ws.load();
    ws.remove('P/a.tex');
    put(ws, 'P/b.tex', 'B');
    git.push({ 'P/a.tex': null });
    await ws.save('m');
    expect([git.text('P/a.tex'), git.text('P/b.tex')]).toEqual([null, 'B']);
  });
});
