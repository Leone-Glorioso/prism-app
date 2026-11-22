import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { guessEngine, nameFromFile, pickMainFile, readZip, timeAgo, uniqueName } from './projects';
import { TEMPLATES, templateById } from './templates';
import { completionSource, SNIPPETS } from './complete';
import { Workspace } from './workspace';
import { GitHubError } from './github';
import { encodeText } from './util';

const enc = (s: string) => new TextEncoder().encode(s);

describe('project names', () => {
  it('makes names unique without clashing case-insensitively', () => {
    expect(uniqueName('Thesis', ['Notes'])).toBe('Thesis');
    expect(uniqueName('Thesis', ['thesis'])).toBe('Thesis 2');
    expect(uniqueName('Thesis', ['Thesis', 'THESIS 2'])).toBe('Thesis 3');
    expect(uniqueName('a/b\\c', [])).toBe('a b c');
    expect(uniqueName('   ', [])).toBe('Project');
    expect(nameFromFile('My_Final Thesis.v2.zip')).toBe('My Final Thesis.v2');
  });
});

describe('engine and main file detection', () => {
  it('guesses the engine from packages, ignoring comments', () => {
    expect(guessEngine('\\documentclass{article}\n\\usepackage{amsmath}')).toBe('pdflatex');
    expect(guessEngine('\\usepackage{fontspec}')).toBe('xelatex');
    expect(guessEngine('\\usepackage[greek]{babel}\n\\setmainfont{CMU Serif}')).toBe('xelatex');
    expect(guessEngine('\\directlua{tex.print(1)}')).toBe('lualatex');
    expect(guessEngine('% \\usepackage{fontspec}\n\\documentclass{article}')).toBe('pdflatex');
  });
  it('picks the real main file', () => {
    const files = ['chapters/a.tex', 'main.tex', 'refs.bib', 'sections/intro.tex', 'appendix.tex'];
    const text: Record<string, string> = { 'main.tex': '\\documentclass{book}', 'appendix.tex': '\\chapter{A}', 'chapters/a.tex': '\\chapter{B}', 'sections/intro.tex': '% \\documentclass{x}' };
    expect(pickMainFile(files, (p) => text[p])).toBe('main.tex');
    expect(pickMainFile(['x/y/paper.tex', 'thesis.tex'], (p) => (p === 'thesis.tex' ? '\\documentclass{a}' : '\\documentclass{b}'))).toBe('thesis.tex'); // shallower wins
    expect(pickMainFile(['a.bib'], () => '')).toBeNull();
    expect(pickMainFile(['only.tex'], () => 'no class')).toBe('only.tex');
  });
});

describe('readZip', () => {
  it('removes a wrapper folder and skips junk and unsafe paths', () => {
    const zip = zipSync({
      'Thesis/main.tex': enc('x'), 'Thesis/img/a.png': new Uint8Array([1, 2, 3]), 'Thesis/': new Uint8Array(),
      '__MACOSX/Thesis/._main.tex': enc('junk'), 'Thesis/.DS_Store': enc('junk'), 'Thesis/.git/config': enc('junk'),
    });
    const r = readZip(zip);
    expect([...r.files.keys()].sort()).toEqual(['img/a.png', 'main.tex']);
  });
  it('keeps the structure when there is no single wrapper, and rejects path traversal', () => {
    const r = readZip(zipSync({ 'main.tex': enc('a'), 'chapters/one.tex': enc('b'), '../evil.tex': enc('c'), '/abs.tex': enc('d'), 'a/../../x.tex': enc('e') }));
    // "/abs.tex" loses its leading slash and stays inside the project folder (harmless); ".." paths are skipped.
    expect([...r.files.keys()].sort()).toEqual(['abs.tex', 'chapters/one.tex', 'main.tex']);
    expect(r.skipped.length).toBe(2);
  });
  it('rejects non-ZIP data with a clear message', () => {
    expect(() => readZip(enc('this is not a zip file at all'))).toThrow(/not a valid ZIP/);
  });
});

describe('timeAgo', () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  it('words recent and old times', () => {
    expect(timeAgo(now - 10_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(timeAgo(now - 86_400_000, now)).toBe('yesterday');
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe('3 days ago');
    expect(timeAgo(now - 40 * 86_400_000, now)).toMatch(/month|weeks/);
  });
});

describe('templates', () => {
  it('are complete and well formed', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) {
      expect(Object.keys(t.files), t.id).toContain('main.tex');
      expect(['pdflatex', 'xelatex', 'lualatex']).toContain(t.engine);
      const main = t.files['main.tex'];
      expect(main, t.id).toMatch(/\\documentclass/);
      // every \begin{x} has an \end{x}
      const begins = [...main.matchAll(/\\begin\{([^}]+)\}/g)].map((m) => m[1]).sort();
      const ends = [...main.matchAll(/\\end\{([^}]+)\}/g)].map((m) => m[1]).sort();
      expect(begins, t.id).toEqual(ends);
      // the chosen engine matches the packages used
      if (/fontspec|polyglossia/.test(main)) expect(t.engine, t.id).toBe('xelatex');
      for (const [f, text] of Object.entries(t.files)) expect(text.includes('\r'), `${t.id}/${f} has CR`).toBe(false);
    }
    expect(templateById('nope').id).toBe(TEMPLATES[0].id);
    expect(templateById('article-biblatex').bibliography).toBe('biber');
    expect(Object.keys(templateById('article-biblatex').files)).toContain('references.bib');
  });
});

describe('snippets', () => {
  const src = completionSource(() => ({ labels: () => [], cites: () => [], files: () => [] }));
  it('are offered after a backslash', () => {
    const doc = '\\fig';
    const r = src(new CompletionContext(EditorState.create({ doc }), doc.length, false))!;
    expect(r.options.map((o) => o.label)).toContain('\\figure');
    expect(SNIPPETS.length).toBeGreaterThanOrEqual(10);
    for (const s of SNIPPETS) expect(s.label.startsWith('\\')).toBe(true);
  });
});

describe('Workspace.copy', () => {
  // A tiny fake repository: one committed file.
  const api = {
    getRefSha: async () => 'c1', getCommitTree: async () => 't1',
    getTree: async () => [{ path: 'A/a.tex', mode: '100644', type: 'blob' as const, sha: 's1' }],
    getBlob: async () => enc('hello'), createBlob: async () => 'sx', createTree: async () => 't2', createCommit: async () => 'c2', updateRef: async () => undefined,
  };
  it('copies committed, edited and copied files, keeps the source, refuses clashes and missing files', async () => {
    const ws = new Workspace(api, 'main');
    await ws.load();
    ws.copy('A/a.tex', 'B/a.tex');
    expect(ws.exists('A/a.tex') && ws.exists('B/a.tex')).toBe(true);
    expect(ws.changes.get('B/a.tex')).toMatchObject({ kind: 'copy', sha: 's1', base: null });
    ws.put('A/a.tex', encodeText('edited'));
    ws.copy('A/a.tex', 'C/a.tex');
    expect(new TextDecoder().decode(await ws.read('C/a.tex'))).toBe('edited');
    ws.copy('B/a.tex', 'D/a.tex'); // a copy of a copy
    expect(ws.changes.get('D/a.tex')).toMatchObject({ kind: 'copy', sha: 's1' });
    expect(() => ws.copy('A/a.tex', 'B/a.tex')).toThrow(/Already exists/);
    expect(() => ws.copy('A/missing.tex', 'E/x.tex')).toThrow(/No such file/);
    expect(new GitHubError(0, 'x')).toBeInstanceOf(Error); // keep the import used
  });
});
