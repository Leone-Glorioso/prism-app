import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { bibEntries, citeOptions, completionSource, openEnvironments } from './complete';

const bib = String.raw`@article{smith2020,
  author = {Smith, Jane and Doe, John and Roe, Rick},
  title = {Deep {Learning} for \emph{Greek} Texts},
  year = {2020}
}
@book{knuth84, author = "Donald E. Knuth", title = "The {TeXbook}", date = {1984-01-01}}
@comment{ignored}`;

describe('completion: bibliography, slash, environments', () => {
  const entries = bibEntries(bib);
  const src = completionSource(() => ({ labels: () => [], cites: () => entries, files: () => ['refs.bib', 'img/a.png', 'ch/one.tex'] }));
  const run = (doc: string, explicit = false) => src(new CompletionContext(EditorState.create({ doc }), doc.length, explicit));
  const labels = (doc: string) => run(doc)?.options.map((o) => o.displayLabel ?? o.label);

  it('reads author, year and title from a .bib file', () => {
    expect(entries.map((e) => e.key)).toEqual(['smith2020', 'knuth84']);
    expect(entries[0].detail).toBe('Smith et al. 2020');
    expect(entries[0].info).toContain('Deep Learning for emphGreek Texts');
    expect(entries[1].detail).toBe('Knuth 1984');
  });

  it('lists every source, searchable by key, author, year and title', () => {
    const r = run('\\cite{')!;
    expect(r.options.map((o) => o.displayLabel)).toEqual(['knuth84', 'smith2020']);
    expect(r.options[0].label).toBe('knuth84 Knuth 1984 The TeXbook');
    expect(r.options[1].label).toBe('smith2020 Smith et al. 2020 Deep Learning for emphGreek Texts');
    expect(r.options[1].apply).toBe('smith2020'); // picking inserts only the key
    expect(r.validFor).toBeDefined(); // the editor narrows the list instantly while typing
    expect(run('\\citep[p.~3]{kn')!.from).toBe('\\citep[p.~3]{'.length);
    expect(run('\\cite{smith2020,kn')!.from).toBe('\\cite{smith2020,'.length);
  });

  it('accepts a slash like a backslash', () => {
    const r = run('as shown /cit')!;
    expect(r.options.map((o) => o.label)).toContain('\\cite');
    expect(r.from).toBe(9);
    expect(run('and/or')).toBeNull();
    expect(run('see /etcx')).toBeNull();
    expect(run('https://example')).toBeNull();
    expect(run('a /ci')).toBeNull(); // fewer than three letters
  });

  it('offers packages, bibliography files, images and the open environment', () => {
    expect(labels(String.raw`\usepackage{amsm`)).toContain('amsmath');
    expect(labels(String.raw`\bibliography{`)).toEqual(['refs']);
    expect(labels(String.raw`\addbibresource{`)).toEqual(['refs.bib']);
    expect(labels(String.raw`\includegraphics{`)).toEqual(['img/a.png']);
    expect(labels(String.raw`\input{`)).toEqual(['ch/one.tex']);
    const doc = String.raw`\begin{itemize}
\begin{enumerate}
\end{enumerate}
\end{`;
    expect(run(doc)?.options[0].label).toBe('itemize');
    expect(openEnvironments(String.raw`\begin{a}\begin{b}\end{b}`)).toEqual(['a']);
  });

  it('has a large command list including math symbols', () => {
    const all = run('\\', true)!.options.map((o) => o.label);
    expect(all.length).toBeGreaterThan(400);
    for (const l of ['\\cite', '\\frac', '\\usepackage', '\\alpha', '\\textbf', '\\includegraphics']) expect(all).toContain(l);
    expect(new Set(all).size).toBe(all.length);
  });
});
