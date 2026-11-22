import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { execSync } from 'node:child_process';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { citeKeysIn, completionSource, labelsIn } from './complete';
import { diffLines } from './diff';
import { cleanTitle, parseOutline, projectOutline, stripComment, wordCount } from './outline';
import { searchTexts } from './search';
import { SETUP_FILES, gitBlobSha, setupStatus } from './setup';
import { deriveKey, isSealed, newSalt, seal, unlock, unseal, WrongPassphrase } from './vault';
import { sanitize, defaultPrefs } from './prefs';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) (globalThis as { crypto: unknown }).crypto = webcrypto;
});

describe('outline', () => {
  const main = [
    '\\documentclass{book}',
    '\\chapter{Intro \\label{ch:intro}}',
    '% \\section{Commented out}',
    '\\input{chapters/two}',
    '\\section*{Last \\textbf{one}} % trailing comment',
    '\\begin{verbatim}',
    '\\section{Inside verbatim}',
    '\\end{verbatim}',
  ].join('\n');
  const two = '\\chapter[Short]{Second \\emph{part}}\n\\section{A}\n\\include{chapters/three}';
  it('parses sections, skips comments and verbatim', () => {
    const { entries } = parseOutline(main, 'P/main.tex');
    const titles = entries.filter((e) => e.kind === 'item').map((e) => (e.kind === 'item' ? e.item.title : ''));
    expect(titles).toEqual(['Intro', 'Last one']);
    expect(entries.find((e) => e.kind === 'include')).toMatchObject({ target: 'chapters/two', line: 4 });
  });
  it('expands includes at their position and survives cycles', () => {
    const files: Record<string, string> = { 'P/main.tex': main, 'P/chapters/two.tex': two, 'P/chapters/three.tex': '\\section{Three}\n\\input{../main}' };
    const out = projectOutline('P/main.tex', (p) => files[p]);
    expect(out.map((o) => o.title)).toEqual(['Intro', 'Second part', 'A', 'Three', 'Last one']);
    expect(out[1]).toMatchObject({ file: 'P/chapters/two.tex', line: 1, level: 1 });
  });
  it('cleans titles and strips comments', () => {
    expect(cleanTitle('\\texorpdfstring{$x$}{x} and \\textbf{bold}')).toBe('x and bold');
    expect(stripComment('50\\% of it % note')).toBe('50\\% of it ');
  });
  it('counts words in prose only', () => {
    expect(wordCount('Hello \\textbf{brave} world. % hidden words here\n$x^2 + y$ and \\begin{equation}a=b\\end{equation} done')).toBe(5);
    expect(wordCount('Καλημέρα κόσμε')).toBe(2);
  });
});

describe('searchTexts', () => {
  const texts = new Map([['a.tex', 'Alpha beta\nbeta BETA'], ['b.tex', 'nothing']]);
  it('finds plain, case-insensitive matches with positions', () => {
    const r = searchTexts(texts, 'beta', { regex: false, caseSensitive: false, max: 10 });
    expect(r.hits.map((h) => [h.file, h.line, h.col])).toEqual([['a.tex', 1, 6], ['a.tex', 2, 0], ['a.tex', 2, 5]]);
  });
  it('supports case, regex, limits and bad patterns', () => {
    expect(searchTexts(texts, 'BETA', { regex: false, caseSensitive: true, max: 10 }).hits).toHaveLength(1);
    expect(searchTexts(texts, 'b.t[a]', { regex: true, caseSensitive: false, max: 10 }).hits).toHaveLength(3);
    expect(searchTexts(texts, 'beta', { regex: false, caseSensitive: false, max: 2 })).toMatchObject({ truncated: true });
    expect(searchTexts(texts, '(', { regex: true, caseSensitive: false, max: 5 }).error).toBeTruthy();
    expect(searchTexts(texts, 'a*', { regex: true, caseSensitive: false, max: 50 }).hits.length).toBeGreaterThan(0); // empty matches do not hang
    expect(searchTexts(texts, '.', { regex: false, caseSensitive: false, max: 50 }).hits).toHaveLength(0); // "." is literal
  });
});

describe('diffLines', () => {
  it('marks added and removed lines', () => {
    const d = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])!;
    expect(d.map((l) => `${l.type}:${l.text}`)).toEqual(['eq:a', 'del:b', 'add:x', 'eq:c', 'eq:d', 'add:e']);
  });
  it('handles empty sides and refuses huge diffs', () => {
    expect(diffLines([], ['a'])!.map((l) => l.type)).toEqual(['add']);
    expect(diffLines(['a'], [])!.map((l) => l.type)).toEqual(['del']);
    expect(diffLines(Array(3000).fill('x').map((_, i) => `a${i}`), Array(3000).fill('y').map((_, i) => `b${i}`))).toBeNull();
  });
});

describe('completion', () => {
  const src = completionSource(() => ({ labels: () => ['fig:one', 'sec:intro'], cites: () => ['knuth84', 'lamport94'], files: () => ['chapters/a.tex'] }));
  const run = (doc: string, explicit = false) => src(new CompletionContext(EditorState.create({ doc }), doc.length, explicit));
  it('completes labels, cite keys (after a comma), files and environments', () => {
    expect(run('see \\ref{fi')?.options.map((o) => o.label)).toEqual(['fig:one', 'sec:intro']);
    expect(run('see \\ref{fi')?.from).toBe(9);
    expect(run('\\cite{knuth84,la')?.from).toBe(14);
    expect(run('\\cite[p.~3]{kn')?.options.map((o) => o.label)).toContain('lamport94');
    expect(run('\\input{ch')?.options[0].label).toBe('chapters/a.tex');
    expect(run('\\begin{ite')?.options.map((o) => o.label)).toContain('itemize');
  });
  it('completes commands after a backslash only', () => {
    expect(run('\\sec')?.options.map((o) => o.label)).toContain('\\section');
    expect(run('plain text')).toBeNull();
    expect(run('a \\')).toBeNull(); // a lone backslash is not a request
    expect(run('a \\', true)).not.toBeNull();
  });
  it('extracts labels and cite keys', () => {
    expect(labelsIn('\\label{a} text \\label{b:c}')).toEqual(['a', 'b:c']);
    expect(citeKeysIn('@article{k1,\n title={x}}\n@comment{no,}\n@book{ k2 ,\n}\n\\bibitem{k3} text')).toEqual(['k1', 'k2', 'k3']);
  });
});

describe('setup files', () => {
  it('git blob ids match git', async () => {
    expect(await gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a'); // git hash-object of "hello\n"
    expect(await gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'); // the empty blob
  });
  it('bundled files hash exactly like git (so the up-to-date check is reliable)', async () => {
    for (const text of Object.values(SETUP_FILES)) {
      expect(await gitBlobSha(text)).toBe(execSync('git hash-object --stdin', { input: text, encoding: 'utf8' }).trim());
    }
  });
  it('reports missing and outdated files', async () => {
    const none = await setupStatus(new Map());
    expect(none).toMatchObject({ needed: true, missing: ['.github/workflows/compile.yml', '.github/scripts/compile.sh', 'prism-projects.json'] });
    const files = new Map<string, { sha: string }>([
      ['.github/workflows/compile.yml', { sha: await gitBlobSha(SETUP_FILES['.github/workflows/compile.yml']) }],
      ['.github/scripts/compile.sh', { sha: 'deadbeef' }],
      ['prism-projects.json', { sha: 'x' }],
    ]);
    const st = await setupStatus(files);
    expect(st).toMatchObject({ needed: true, missing: [], outdated: ['.github/scripts/compile.sh'] });
    files.set('.github/scripts/compile.sh', { sha: await gitBlobSha(SETUP_FILES['.github/scripts/compile.sh']) });
    expect((await setupStatus(files)).needed).toBe(false);
  });
  it('bundles the hardened workflow', () => {
    const wf = SETUP_FILES['.github/workflows/compile.yml'];
    expect(wf).toContain('--network none');
    expect(wf).toContain('--cap-drop ALL');
    expect(wf).toContain('persist-credentials: false');
    expect(wf).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(SETUP_FILES['.github/scripts/compile.sh']).not.toContain('\r');
  });
});

describe('vault', () => {
  it('round-trips with the right passphrase and rejects a wrong one or tampering', async () => {
    const salt = newSalt();
    const key = await deriveKey('correct horse battery', salt);
    const sealed = await seal(key, salt, { token: 'github_pat_secret' });
    expect(isSealed(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain('github_pat_secret');
    expect(((await unlock('correct horse battery', sealed)).data as { token: string }).token).toBe('github_pat_secret');
    await expect(unlock('wrong passphrase', sealed)).rejects.toBeInstanceOf(WrongPassphrase);
    const tampered = { ...sealed, ct: sealed.ct.slice(0, -4) + (sealed.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    await expect(unseal(key, tampered)).rejects.toBeInstanceOf(WrongPassphrase);
  });
  it('uses a fresh IV for every write', async () => {
    const salt = newSalt();
    const key = await deriveKey('another passphrase', salt);
    const a = await seal(key, salt, { x: 1 });
    const b = await seal(key, salt, { x: 1 });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe('prefs', () => {
  it('sanitises stored values', () => {
    expect(sanitize({ ...defaultPrefs, fontSize: 999, theme: 'x' as never, spellLang: '<script>', pdfJump: 'nope' as never }))
      .toMatchObject({ fontSize: 28, theme: 'auto', spellLang: 'en', pdfJump: 'double' });
    expect(sanitize({ ...defaultPrefs, fontSize: NaN as never }).fontSize).toBe(14);
  });
});
