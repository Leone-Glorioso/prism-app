// Minimal GitHub REST client for the browser. All calls go to api.github.com with the user's token.

import { bytesToBase64 } from './util';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface WorkflowRun {
  id: number;
  status: string; // queued | in_progress | completed | ...
  conclusion: string | null; // success | failure | cancelled | ...
  display_title: string;
  html_url: string;
  created_at: string;
}

const seg = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export class GitHub {
  constructor(private token: string, public owner: string, public repo: string) {}

  private get base() {
    return `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  /**
   * immutable=true only for content addressed by SHA (blobs, trees, commits). Everything else bypasses the
   * browser cache: GitHub sends max-age=60, which would otherwise hide new commits and builds.
   */
  async request(method: string, path: string, opts: { body?: unknown; accept?: string; immutable?: boolean } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(path.startsWith('http') ? path : this.base + path, {
        method,
        cache: opts.immutable ? 'default' : 'no-store',
        headers: {
          Accept: opts.accept ?? 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw new GitHubError(0, `Network error talking to GitHub: ${(e as Error).message}`);
    }
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { /* not JSON */ }
      const msg = (body as { message?: string } | undefined)?.message ?? res.statusText;
      const hint = res.status === 401 ? ' (token invalid or expired)'
        : res.status === 403 ? ' (token lacks permission, or rate limit reached)'
        : res.status === 404 ? ' (not found, or the token cannot see this repository)' : '';
      throw new GitHubError(res.status, `GitHub ${res.status}: ${msg}${hint}`, body);
    }
    return res;
  }

  async json<T>(method: string, path: string, opts?: { body?: unknown; immutable?: boolean }): Promise<T> {
    return (await this.request(method, path, opts)).json() as Promise<T>;
  }

  getRepo() {
    return this.json<{ private: boolean; default_branch: string; permissions?: { push?: boolean } }>('GET', '');
  }

  async getRefSha(ref: string): Promise<string | null> {
    try {
      const r = await this.json<{ object: { sha: string } }>('GET', `/git/ref/heads/${seg(ref)}`);
      return r.object.sha;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  async getCommitTree(commitSha: string): Promise<string> {
    return (await this.json<{ tree: { sha: string } }>('GET', `/git/commits/${commitSha}`, { immutable: true })).tree.sha;
  }

  async getTree(treeSha: string, recursive: boolean): Promise<TreeEntry[]> {
    const r = await this.json<{ tree: TreeEntry[]; truncated: boolean }>(
      'GET', `/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`, { immutable: true });
    if (r.truncated) throw new GitHubError(0, 'Repository tree too large for one request (GitHub truncated it).');
    return r.tree;
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const res = await this.request('GET', `/git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json', immutable: true });
    return new Uint8Array(await res.arrayBuffer());
  }

  async createBlob(bytes: Uint8Array): Promise<string> {
    return (await this.json<{ sha: string }>('POST', '/git/blobs', { body: { content: bytesToBase64(bytes), encoding: 'base64' } })).sha;
  }

  async createTree(baseTree: string, entries: { path: string; mode: string; type: 'blob'; sha: string | null }[]): Promise<string> {
    return (await this.json<{ sha: string }>('POST', '/git/trees', { body: { base_tree: baseTree, tree: entries } })).sha;
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    return (await this.json<{ sha: string }>('POST', '/git/commits', { body: { message, tree, parents } })).sha;
  }

  /** Fast-forward only. Throws GitHubError 422 when the branch moved (someone else committed). */
  async updateRef(branch: string, sha: string): Promise<void> {
    await this.request('PATCH', `/git/refs/heads/${seg(branch)}`, { body: { sha, force: false } });
  }

  async dispatch(workflow: string, ref: string, inputs: Record<string, string>): Promise<void> {
    await this.request('POST', `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { body: { ref, inputs } });
  }

  async listDispatchRuns(workflow: string, createdSince: string): Promise<WorkflowRun[]> {
    const q = new URLSearchParams({ event: 'workflow_dispatch', per_page: '50', created: `>=${createdSince}` });
    const r = await this.json<{ workflow_runs: WorkflowRun[] }>('GET', `/actions/workflows/${encodeURIComponent(workflow)}/runs?${q}`);
    return r.workflow_runs;
  }

  getRun(id: number) {
    return this.json<WorkflowRun>('GET', `/actions/runs/${id}`);
  }

  /** Files at the top level of a branch, by name. Null when the branch does not exist. */
  async branchFiles(branch: string): Promise<Map<string, string> | null> {
    const sha = await this.getRefSha(branch);
    if (!sha) return null;
    const tree = await this.getTree(await this.getCommitTree(sha), false);
    return new Map(tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  }
}
