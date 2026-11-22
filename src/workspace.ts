// In-memory working copy of one branch: the committed tree plus local changes, saved as one commit.

import { GitHub, GitHubError, TreeEntry } from './github';

export type Api = Pick<GitHub, 'getRefSha' | 'getCommitTree' | 'getTree' | 'getBlob' | 'createBlob' | 'createTree' | 'createCommit' | 'updateRef'>;

/** `base` = blob SHA the change was made against (null: the file did not exist). Used to detect conflicts. */
export type Change = { base: string | null } & (
  | { kind: 'put'; bytes: Uint8Array; mode?: string }
  | { kind: 'copy'; sha: string; mode: string } // rename/move without re-uploading
  | { kind: 'delete' }
);

export class ConflictError extends Error {
  constructor(public paths: string[]) {
    super(`Changed elsewhere since you started editing: ${paths.join(', ')}`);
  }
}

type FileMap = Map<string, TreeEntry>;

export class Workspace {
  baseCommit = '';
  baseTree = '';
  files: FileMap = new Map(); // committed blobs by path
  changes = new Map<string, Change>();
  private blobCache = new Map<string, Uint8Array>();

  constructor(private api: Api, public branch: string) {}

  async load(): Promise<void> {
    const head = await this.api.getRefSha(this.branch);
    if (!head) throw new GitHubError(404, `Branch "${this.branch}" not found.`);
    await this.setBase(head);
  }

  private async fetchFiles(commit: string): Promise<{ tree: string; files: FileMap }> {
    const tree = await this.api.getCommitTree(commit);
    const entries = await this.api.getTree(tree, true);
    return { tree, files: new Map(entries.filter((e) => e.type === 'blob').map((e) => [e.path, e])) };
  }

  private async setBase(commit: string) {
    const { tree, files } = await this.fetchFiles(commit);
    this.baseCommit = commit;
    this.baseTree = tree;
    this.files = files;
  }

  exists(path: string): boolean {
    const c = this.changes.get(path);
    return c ? c.kind !== 'delete' : this.files.has(path);
  }

  paths(): string[] {
    const all = new Set<string>();
    for (const p of this.files.keys()) if (this.changes.get(p)?.kind !== 'delete') all.add(p);
    for (const [p, c] of this.changes) if (c.kind !== 'delete') all.add(p);
    return [...all].sort();
  }

  async read(path: string): Promise<Uint8Array> {
    const c = this.changes.get(path);
    if (c?.kind === 'put') return c.bytes;
    if (c?.kind === 'delete') throw new Error(`Deleted: ${path}`);
    const sha = c?.kind === 'copy' ? c.sha : this.files.get(path)?.sha;
    if (!sha) throw new Error(`No such file: ${path}`);
    return this.readBlob(sha);
  }

  /** Committed content, ignoring local changes. Null if the path is not committed. */
  async readCommitted(path: string): Promise<Uint8Array | null> {
    const sha = this.files.get(path)?.sha;
    return sha ? this.readBlob(sha) : null;
  }

  private async readBlob(sha: string): Promise<Uint8Array> {
    let b = this.blobCache.get(sha);
    if (!b) {
      b = await this.api.getBlob(sha);
      this.blobCache.set(sha, b);
    }
    return b;
  }

  /** Base of a new change: keep the base of an existing change, else the committed version. */
  private baseOf(path: string): string | null {
    const c = this.changes.get(path);
    return c ? c.base : this.files.get(path)?.sha ?? null;
  }

  put(path: string, bytes: Uint8Array) {
    this.changes.set(path, { kind: 'put', bytes, mode: this.files.get(path)?.mode, base: this.baseOf(path) });
  }

  /** Restores a saved draft made against `base`. */
  restore(path: string, bytes: Uint8Array, base: string | null) {
    this.changes.set(path, { kind: 'put', bytes, mode: this.files.get(path)?.mode, base });
  }

  /** Drops a local change so the committed version shows again. */
  revert(path: string) {
    this.changes.delete(path);
  }

  remove(path: string) {
    const base = this.baseOf(path);
    if (base !== null) this.changes.set(path, { kind: 'delete', base });
    else this.changes.delete(path); // never committed: just forget it
  }

  rename(from: string, to: string) {
    if (this.exists(to)) throw new Error(`Already exists: ${to}`);
    const c = this.changes.get(from);
    const committed = this.files.get(from);
    const base = this.baseOf(to);
    if (c?.kind === 'put') this.changes.set(to, { kind: 'put', bytes: c.bytes, mode: c.mode, base });
    else if (c?.kind === 'copy') this.changes.set(to, { ...c, base });
    else if (committed && !c) this.changes.set(to, { kind: 'copy', sha: committed.sha, mode: committed.mode, base });
    else throw new Error(`No such file: ${from}`);
    this.remove(from);
  }

  get dirty(): boolean {
    return this.changes.size > 0;
  }

  /** Changed paths whose committed version at `files` differs from what the change was based on. */
  conflictsWith(files: FileMap): string[] {
    return [...this.changes].filter(([p, c]) => {
      const now = files.get(p)?.sha ?? null;
      if (c.kind === 'delete' && now === null) return false; // deleted on both sides
      return c.base !== now;
    }).map(([p]) => p);
  }

  /**
   * Commits all changes as one commit (fast-forward only). If the branch moved, rebases onto the new head
   * when no changed path was touched there; otherwise throws ConflictError, unless `overwrite` lists them.
   */
  async save(message: string, overwrite: string[] = []): Promise<string> {
    if (!this.dirty) return this.baseCommit;
    const entries: { path: string; mode: string; type: 'blob'; sha: string | null }[] = [];
    const uploaded = new Map<string, Uint8Array>();
    for (const [path, c] of this.changes) {
      if (c.kind === 'delete') entries.push({ path, mode: '100644', type: 'blob', sha: null });
      else if (c.kind === 'copy') entries.push({ path, mode: c.mode, type: 'blob', sha: c.sha });
      else {
        const sha = await this.api.createBlob(c.bytes);
        uploaded.set(sha, c.bytes);
        entries.push({ path, mode: c.mode ?? '100644', type: 'blob', sha });
      }
    }
    let base = { commit: this.baseCommit, tree: this.baseTree, files: this.files };
    for (let attempt = 0; attempt < 4; attempt++) {
      const conflicts = this.conflictsWith(base.files).filter((p) => !overwrite.includes(p));
      if (conflicts.length) throw new ConflictError(conflicts);
      // Deleting a path that is already gone would make GitHub reject the tree.
      const live = entries.filter((e) => e.sha !== null || base.files.has(e.path));
      const tree = await this.api.createTree(base.tree, live);
      const commit = await this.api.createCommit(message, tree, [base.commit]);
      try {
        await this.api.updateRef(this.branch, commit);
      } catch (e) {
        if (!(e instanceof GitHubError) || e.status !== 422) throw e;
        const head = await this.api.getRefSha(this.branch);
        if (!head) throw e;
        const next = await this.fetchFiles(head);
        base = { commit: head, ...next };
        continue;
      }
      for (const [sha, bytes] of uploaded) this.blobCache.set(sha, bytes);
      this.changes.clear();
      await this.setBase(commit);
      return commit;
    }
    throw new Error('The branch kept changing while saving. Try again.');
  }

  /** Re-reads the branch head, keeping local changes. Returns paths whose committed version changed. */
  async refresh(): Promise<string[]> {
    const old = this.files;
    const head = await this.api.getRefSha(this.branch);
    if (!head) throw new GitHubError(404, `Branch "${this.branch}" not found.`);
    if (head === this.baseCommit) return [];
    await this.setBase(head);
    return [...new Set([...old.keys(), ...this.files.keys()])].filter((p) => old.get(p)?.sha !== this.files.get(p)?.sha);
  }
}
