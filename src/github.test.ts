import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHub, GitHubError } from './github';

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });

afterEach(() => vi.unstubAllGlobals());

describe('GitHub client', () => {
  it('detects classic tokens by the X-OAuth-Scopes header and sends the token only in Authorization', async () => {
    const fetchMock = vi.fn(async () => json({ private: true, default_branch: 'main', permissions: { push: true } }, { headers: { 'x-oauth-scopes': 'repo, workflow' } }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await new GitHub('tok_secret', 'o', 'r').checkToken();
    expect(r.classicScopes).toBe('repo, workflow');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/o/r');
    expect(url).not.toContain('tok_secret'); // never in the URL
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_secret');
    expect(init.cache).toBe('no-store');
    vi.stubGlobal('fetch', vi.fn(async () => json({ private: true, default_branch: 'main' })));
    expect((await new GitHub('t', 'o', 'r').checkToken()).classicScopes).toBeNull(); // fine-grained token
  });

  it('caches only content-addressed requests', async () => {
    const fetchMock = vi.fn(async () => json({ tree: { sha: 'abc' } }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitHub('t', 'o', 'r').getCommitTree('deadbeef');
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].cache).toBe('default');
  });

  it('escapes owner, repo and paths in URLs', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);
    await new GitHub('t', 'a/b', 'c d').getFileAt('dir/we ird#.tex', 'abc');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.github.com/repos/a%2Fb/c%20d/contents/dir/we%20ird%23.tex?ref=abc');
  });

  it('turns HTTP errors into helpful GitHubError messages, and a missing file into null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'Bad credentials' }, { status: 401 })));
    await expect(new GitHub('t', 'o', 'r').getRepo()).rejects.toMatchObject({ status: 401, message: expect.stringContaining('token invalid or expired') });
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'Not Found' }, { status: 404 })));
    expect(await new GitHub('t', 'o', 'r').getFileAt('x.tex', 'abc')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(new GitHub('t', 'o', 'r').getRepo()).rejects.toBeInstanceOf(GitHubError);
  });
});
