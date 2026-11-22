// LaTeX auto-completion: commands with argument blanks, environments (with automatic \end), \ref labels,
// \cite keys (searchable by author, title and year), packages, file names, math symbols and ready-made blocks.
// Both "\cite" and "/cite" work: a slash after a space is turned into a backslash when you pick a command.

import { snippet, snippetCompletion, startCompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';

export interface CiteEntry { key: string; detail?: string; info?: string }

export interface CompletionData {
  labels(): string[];
  cites(): CiteEntry[];
  files(): string[]; // paths relative to the main file's folder
}

export const ENVIRONMENTS = [
  'document', 'abstract', 'itemize', 'enumerate', 'description', 'figure', 'figure*', 'table', 'table*', 'tabular', 'tabularx',
  'longtable', 'center', 'flushleft', 'flushright', 'quote', 'quotation', 'verse', 'verbatim', 'equation', 'equation*', 'align',
  'align*', 'alignat', 'gather', 'gather*', 'multline', 'split', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'array',
  'theorem', 'lemma', 'proposition', 'proof', 'definition', 'corollary', 'remark', 'example', 'minipage', 'tikzpicture', 'axis',
  'lstlisting', 'minted', 'algorithm', 'algorithmic', 'thebibliography', 'frame', 'columns', 'column', 'block', 'appendices',
  'subfigure', 'wrapfigure', 'otherlanguage', 'sloppypar', 'titlepage', 'landscape', 'multicols', 'filecontents', 'tcolorbox',
  'exercise', 'solution', 'notation', 'conjecture', 'claim', 'note',
];

export const PACKAGES = [
  'amsmath', 'amssymb', 'amsthm', 'mathtools', 'physics', 'siunitx', 'graphicx', 'xcolor', 'color', 'tikz', 'pgfplots',
  'pgfplotstable', 'hyperref', 'cleveref', 'url', 'biblatex', 'natbib', 'babel', 'polyglossia', 'fontspec', 'unicode-math',
  'inputenc', 'fontenc', 'lmodern', 'times', 'mathptmx', 'newtxtext', 'newtxmath', 'microtype', 'geometry', 'fancyhdr', 'setspace',
  'titlesec', 'titling', 'tocloft', 'enumitem', 'booktabs', 'tabularx', 'longtable', 'multirow', 'multicol', 'array', 'makecell',
  'caption', 'subcaption', 'float', 'wrapfig', 'placeins', 'rotating', 'pdfpages', 'lipsum', 'blindtext', 'csquotes', 'listings',
  'minted', 'algorithm', 'algorithmic', 'algorithm2e', 'algpseudocode', 'tcolorbox', 'framed', 'mdframed', 'xspace', 'etoolbox',
  'xparse', 'ifthen', 'calc', 'verbatim', 'comment', 'footmisc', 'appendix', 'glossaries', 'makeidx', 'imakeidx',
  'nomencl', 'todonotes', 'soul', 'ulem', 'cancel', 'bm', 'braket', 'chemfig', 'mhchem', 'beamer',
  'animate', 'epstopdf', 'adjustbox', 'varioref', 'bookmark', 'authblk', 'abstract', 'epigraph', 'textcomp', 'eurosym',
  'lastpage', 'changepage', 'parskip', 'indentfirst', 'upgreek', 'stmaryrd', 'dsfont', 'bbm', 'mathrsfs', 'pifont',
  'pgf', 'tikz-cd', 'circuitikz', 'forest', 'qtree', 'tikz-3dplot', 'pgfgantt', 'import', 'subfiles', 'standalone',
  'fontawesome5', 'ragged2e', 'enumerate', 'paralist', 'showkeys', 'cite', 'overpic',
];

export const DOCUMENT_CLASSES = [
  'article', 'report', 'book', 'letter', 'beamer', 'memoir', 'scrartcl', 'scrreprt', 'scrbook', 'amsart', 'amsbook', 'IEEEtran',
  'elsarticle', 'llncs', 'revtex4-2', 'standalone', 'minimal', 'extarticle', 'extreport', 'moderncv', 'tufte-handout',
];

export const BIB_STYLES = [
  'plain', 'unsrt', 'alpha', 'abbrv', 'apalike', 'ieeetr', 'acm', 'siam', 'plainnat', 'abbrvnat', 'unsrtnat', 'IEEEtran', 'chicago',
  'amsplain', 'amsalpha', 'elsarticle-num', 'elsarticle-harv', 'splncs04',
];

export const TIKZ_LIBRARIES = [
  'arrows.meta', 'calc', 'positioning', 'shapes.geometric', 'shapes.misc', 'decorations.pathmorphing', 'decorations.markings',
  'fit', 'backgrounds', 'patterns', 'matrix', 'trees', 'intersections', 'through', 'shadows', 'automata', 'angles', 'quotes',
  'mindmap', 'petri', 'chains', 'external', 'plotmarks', 'fadings', 'spy', '3d', 'perspective', 'math',
];

type NextList = 'pkg' | 'class' | 'bibstyle' | 'tikzlib' | 'label' | 'cite' | 'env' | 'file' | 'bib';
/** [name, argument template ('' when none), detail, suggestion list opened right after insertion] */
type Cmd = [string, string, string?, NextList?];

const COMMAND_TABLE: Cmd[] = [
  // preamble and structure
  ['documentclass', '{${}}', 'document class', 'class'],
  ['usepackage', '{${}}', 'load a package', 'pkg'],
  ['RequirePackage', '{${}}', 'load a package', 'pkg'],
  ['usetikzlibrary', '{${}}', 'TikZ library', 'tikzlib'],
  ['usepgfplotslibrary', '{${library}}', 'PGFPlots library'],
  ['begin', '{${}}', 'open an environment', 'env'],
  ['end', '{${}}', 'close an environment', 'env'],
  ['title', '{${title}}', 'document title'], ['author', '{${name}}', 'author'], ['date', '{${\\today}}', 'date'],
  ['maketitle', '', 'print the title'], ['tableofcontents', '', 'table of contents'], ['listoffigures', '', 'list of figures'],
  ['listoftables', '', 'list of tables'], ['appendix', '', 'start the appendix'], ['frontmatter', ''], ['mainmatter', ''], ['backmatter', ''],
  ['part', '{${title}}'], ['chapter', '{${title}}'], ['section', '{${title}}'], ['subsection', '{${title}}'], ['subsubsection', '{${title}}'],
  ['paragraph', '{${title}}'], ['subparagraph', '{${title}}'],
  ['chapter*', '{${title}}', 'unnumbered chapter'], ['section*', '{${title}}', 'unnumbered section'], ['subsection*', '{${title}}', 'unnumbered subsection'],
  ['label', '{${key}}', 'label for \\ref'],
  // references
  ['ref', '{${}}', 'reference', 'label'], ['eqref', '{${}}', 'equation reference', 'label'], ['pageref', '{${}}', 'page of a label', 'label'],
  ['autoref', '{${}}', 'named reference', 'label'], ['cref', '{${}}', 'clever reference', 'label'], ['Cref', '{${}}', 'clever reference (capital)', 'label'],
  ['nameref', '{${}}', 'name of a label', 'label'], ['vref', '{${}}', 'reference with page', 'label'],
  ['cite', '{${}}', 'citation', 'cite'], ['citep', '{${}}', 'citation in parentheses (natbib)', 'cite'], ['citet', '{${}}', 'citation in text (natbib)', 'cite'],
  ['citeauthor', '{${}}', 'author of a source', 'cite'], ['citeyear', '{${}}', 'year of a source', 'cite'], ['parencite', '{${}}', 'citation (biblatex)', 'cite'],
  ['textcite', '{${}}', 'citation in text (biblatex)', 'cite'], ['autocite', '{${}}', 'citation (biblatex)', 'cite'], ['footcite', '{${}}', 'citation in a footnote', 'cite'],
  ['nocite', '{${}}', 'add to the list without citing', 'cite'],
  ['bibliography', '{${}}', 'BibTeX file', 'bib'], ['bibliographystyle', '{${}}', 'BibTeX style', 'bibstyle'],
  ['addbibresource', '{${}}', 'BibLaTeX file', 'bib'], ['printbibliography', '', 'print the bibliography'],
  ['bibitem', '{${key}}', 'manual reference'], ['footnote', '{${text}}'], ['footnotetext', '{${text}}'], ['marginpar', '{${text}}'],
  // text
  ['textbf', '{${text}}', 'bold'], ['textit', '{${text}}', 'italic'], ['emph', '{${text}}', 'emphasis'], ['texttt', '{${text}}', 'monospace'],
  ['textsc', '{${text}}', 'small capitals'], ['textrm', '{${text}}'], ['textsf', '{${text}}'], ['underline', '{${text}}'], ['textsuperscript', '{${text}}'],
  ['textsubscript', '{${text}}'], ['textcolor', '{${red}}{${text}}', 'coloured text'], ['colorbox', '{${yellow}}{${text}}'], ['color', '{${red}}'],
  ['bfseries', ''], ['itshape', ''], ['ttfamily', ''], ['scshape', ''], ['sffamily', ''], ['rmfamily', ''], ['mdseries', ''], ['upshape', ''],
  ['tiny', ''], ['scriptsize', ''], ['footnotesize', ''], ['small', ''], ['normalsize', ''], ['large', ''], ['Large', ''], ['LARGE', ''], ['huge', ''], ['Huge', ''],
  ['centering', ''], ['raggedright', ''], ['raggedleft', ''], ['noindent', ''], ['indent', ''], ['item', '', 'list item'],
  ['url', '{${https://}}'], ['href', '{${https://}}{${text}}', 'link'], ['texorpdfstring', '{${TeX}}{${plain text}}'],
  ['foreignlanguage', '{${greek}}{${text}}'], ['selectlanguage', '{${english}}'], ['textgreek', '{${text}}'],
  ['today', ''], ['thanks', '{${text}}'], ['quad', ''], ['qquad', ''], ['ldots', ''], ['dots', ''], ['cdots', ''], ['vdots', ''], ['ddots', ''],
  ['hspace', '{${1em}}'], ['vspace', '{${1em}}'], ['hspace*', '{${1em}}'], ['vspace*', '{${1em}}'], ['hfill', ''], ['vfill', ''], ['smallskip', ''], ['medskip', ''], ['bigskip', ''],
  ['newline', ''], ['newpage', ''], ['clearpage', ''], ['cleardoublepage', ''], ['pagebreak', ''], ['linebreak', ''], ['nolinebreak', ''],
  ['phantom', '{${text}}'], ['hphantom', '{${text}}'], ['vphantom', '{${text}}'], ['mbox', '{${text}}'], ['makebox', '[${width}][${c}]{${text}}'],
  ['fbox', '{${text}}'], ['framebox', '[${width}][${c}]{${text}}'], ['parbox', '{${width}}{${text}}'], ['raisebox', '{${1ex}}{${text}}'], ['rule', '{${1cm}}{${1pt}}'],
  // floats, graphics, tables
  ['caption', '{${caption}}'], ['includegraphics', '[width=${0.8\\linewidth}]{${}}', 'insert an image', 'file'], ['input', '{${}}', 'include a file', 'file'],
  ['include', '{${}}', 'include a chapter file', 'file'], ['includeonly', '{${file}}'], ['subfile', '{${}}', 'include a subfile', 'file'], ['includepdf', '[pages=-]{${file.pdf}}'],
  ['hline', ''], ['cline', '{${2-3}}'], ['toprule', ''], ['midrule', ''], ['bottomrule', ''], ['cmidrule', '{${2-3}}'],
  ['multicolumn', '{${2}}{${c}}{${text}}'], ['multirow', '{${2}}{${*}}{${text}}'], ['resizebox', '{${\\textwidth}}{${!}}{${content}}'], ['scalebox', '{${0.8}}{${content}}'],
  ['rotatebox', '{${90}}{${content}}'], ['arraystretch', ''], ['tabcolsep', ''],
  // definitions and counters
  ['newcommand', '{${\\name}}[${1}]{${definition}}', 'new command'], ['renewcommand', '{${\\name}}[${1}]{${definition}}'], ['providecommand', '{${\\name}}[${1}]{${definition}}'],
  ['DeclareMathOperator', '{${\\name}}{${text}}'], ['newenvironment', '{${name}}{${begin}}{${end}}'], ['newtheorem', '{${theorem}}{${Theorem}}'],
  ['setlength', '{${\\length}}{${value}}'], ['addtolength', '{${\\length}}{${value}}'], ['newcounter', '{${name}}'], ['setcounter', '{${name}}{${0}}'],
  ['addtocounter', '{${name}}{${1}}'], ['stepcounter', '{${name}}'], ['arabic', '{${counter}}'], ['roman', '{${counter}}'], ['Roman', '{${counter}}'], ['alph', '{${counter}}'],
  ['geometry', '{${margin=2.5cm}}'], ['hypersetup', '{${colorlinks=true}}'], ['pagestyle', '{${plain}}'], ['thispagestyle', '{${empty}}'], ['pagenumbering', '{${arabic}}'],
  ['setmainfont', '{${Times New Roman}}'], ['setsansfont', '{${Arial}}'], ['setmonofont', '{${Courier New}}'], ['linespread', '{${1.25}}'], ['onehalfspacing', ''], ['doublespacing', ''],
  ['lstset', '{${language=Python}}'], ['definecolor', '{${name}}{${rgb}}{${0,0,0}}'], ['todo', '{${text}}'], ['printindex', ''], ['index', '{${term}}'],
  // math
  ['frac', '{${num}}{${den}}', 'fraction'], ['dfrac', '{${num}}{${den}}'], ['tfrac', '{${num}}{${den}}'], ['sqrt', '{${x}}', 'square root'], ['binom', '{${n}}{${k}}'],
  ['sum', '_{${i=1}}^{${n}}'], ['prod', '_{${i=1}}^{${n}}'], ['int', '_{${a}}^{${b}}'], ['oint', ''], ['lim', '_{${x\\to\\infty}}'], ['max', ''], ['min', ''], ['sup', ''], ['inf', ''],
  ['log', ''], ['ln', ''], ['exp', ''], ['sin', ''], ['cos', ''], ['tan', ''], ['arg', ''], ['det', ''], ['dim', ''], ['ker', ''], ['Pr', ''],
  ['mathbb', '{${R}}'], ['mathcal', '{${L}}'], ['mathbf', '{${x}}'], ['mathrm', '{${d}}'], ['mathit', '{${x}}'], ['mathsf', '{${x}}'], ['mathtt', '{${x}}'], ['mathfrak', '{${g}}'], ['boldsymbol', '{${x}}'], ['bm', '{${x}}'],
  ['operatorname', '{${name}}'], ['text', '{${text}}', 'text inside a formula'], ['left', '('], ['right', ')'], ['big', ''], ['Big', ''], ['bigg', ''], ['Bigg', ''],
  ['hat', '{${x}}'], ['widehat', '{${x}}'], ['tilde', '{${x}}'], ['widetilde', '{${x}}'], ['bar', '{${x}}'], ['overline', '{${x}}'], ['underbrace', '{${x}}_{${text}}'], ['overbrace', '{${x}}^{${text}}'],
  ['vec', '{${x}}'], ['dot', '{${x}}'], ['ddot', '{${x}}'], ['norm', '{${x}}'], ['abs', '{${x}}'], ['stackrel', '{${top}}{${base}}'], ['overset', '{${top}}{${base}}'], ['underset', '{${bottom}}{${base}}'],
  ['xrightarrow', '{${text}}'], ['xleftarrow', '{${text}}'], ['tag', '{${1}}'], ['nonumber', ''], ['notag', ''], ['displaystyle', ''], ['limits', ''], ['nolimits', ''],
  // TikZ and PGFPlots
  ['draw', '[${->}] (${0,0}) -- (${1,1});'], ['node', ' at (${0,0}) {${text}};'], ['fill', '[${blue}] (${0,0}) circle (${1});'], ['path', ''], ['addplot', '[${blue}] {${x^2}};'],
  ['coordinate', ' (${A}) at (${0,0});'], ['tikzset', '{${name}/.style={${}}}'], ['pgfplotsset', '{${compat=1.18}}'],
  // beamer
  ['frametitle', '{${title}}'], ['framesubtitle', '{${title}}'], ['pause', ''], ['only', '<${1}>{${text}}'], ['uncover', '<${1-}>{${text}}'], ['usetheme', '{${Madrid}}'], ['usecolortheme', '{${default}}'],
  ['institute', '{${institute}}'], ['subtitle', '{${subtitle}}'], ['alert', '{${text}}'], ['structure', '{${text}}'],
];

/** Greek letters, operators and relations, shown with their glyph. */
const SYMBOLS: [string, string][] = [
  ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ϵ'], ['varepsilon', 'ε'], ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'], ['vartheta', 'ϑ'],
  ['iota', 'ι'], ['kappa', 'κ'], ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['pi', 'π'], ['varpi', 'ϖ'], ['rho', 'ρ'], ['varrho', 'ϱ'], ['sigma', 'σ'],
  ['varsigma', 'ς'], ['tau', 'τ'], ['upsilon', 'υ'], ['phi', 'ϕ'], ['varphi', 'φ'], ['chi', 'χ'], ['psi', 'ψ'], ['omega', 'ω'], ['Gamma', 'Γ'], ['Delta', 'Δ'],
  ['Theta', 'Θ'], ['Lambda', 'Λ'], ['Xi', 'Ξ'], ['Pi', 'Π'], ['Sigma', 'Σ'], ['Upsilon', 'Υ'], ['Phi', 'Φ'], ['Psi', 'Ψ'], ['Omega', 'Ω'],
  ['infty', '∞'], ['partial', '∂'], ['nabla', '∇'], ['forall', '∀'], ['exists', '∃'], ['nexists', '∄'], ['emptyset', '∅'], ['varnothing', '∅'], ['in', '∈'], ['notin', '∉'],
  ['ni', '∋'], ['subset', '⊂'], ['subseteq', '⊆'], ['supset', '⊃'], ['supseteq', '⊇'], ['cup', '∪'], ['cap', '∩'], ['setminus', '∖'], ['bigcup', '⋃'], ['bigcap', '⋂'],
  ['land', '∧'], ['lor', '∨'], ['lnot', '¬'], ['neg', '¬'], ['wedge', '∧'], ['vee', '∨'], ['oplus', '⊕'], ['otimes', '⊗'], ['cdot', '·'], ['times', '×'], ['div', '÷'], ['pm', '±'], ['mp', '∓'],
  ['circ', '∘'], ['bullet', '•'], ['star', '⋆'], ['ast', '∗'], ['leq', '≤'], ['geq', '≥'], ['neq', '≠'], ['ll', '≪'], ['gg', '≫'], ['approx', '≈'], ['sim', '∼'], ['simeq', '≃'],
  ['cong', '≅'], ['equiv', '≡'], ['propto', '∝'], ['perp', '⊥'], ['parallel', '∥'], ['mid', '∣'], ['angle', '∠'], ['triangle', '△'], ['square', '□'], ['prime', '′'],
  ['to', '→'], ['rightarrow', '→'], ['leftarrow', '←'], ['leftrightarrow', '↔'], ['Rightarrow', '⇒'], ['Leftarrow', '⇐'], ['Leftrightarrow', '⇔'], ['mapsto', '↦'],
  ['uparrow', '↑'], ['downarrow', '↓'], ['implies', '⟹'], ['iff', '⟺'], ['longrightarrow', '⟶'], ['hookrightarrow', '↪'], ['langle', '⟨'], ['rangle', '⟩'],
  ['lfloor', '⌊'], ['rfloor', '⌋'], ['lceil', '⌈'], ['rceil', '⌉'], ['ell', 'ℓ'], ['hbar', 'ℏ'], ['Re', 'ℜ'], ['Im', 'ℑ'], ['aleph', 'ℵ'], ['wp', '℘'],
  ['dagger', '†'], ['ddagger', '‡'], ['S', '§'], ['P', '¶'], ['copyright', '©'], ['pounds', '£'],
];

function hasArgumentAhead(view: EditorView, to: number): boolean {
  const next = view.state.sliceDoc(to, to + 1);
  return next === '{' || next === '[';
}

/** Inserts the command with blanks to fill (Tab moves between them); opens the next suggestion list when one is named. */
function applyCommand(label: string, args: string, next?: NextList) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    if (hasArgumentAhead(view, to)) { // editing an existing command: only complete its name
      view.dispatch({ changes: { from, to, insert: label }, selection: { anchor: from + label.length } });
      return;
    }
    snippet(`${label}${args}`)(view, completion, from, to);
    if (next) setTimeout(() => startCompletion(view), 0);
  };
}

const ALL_COMMANDS: Completion[] = [];
{
  const seen = new Set<string>();
  for (const [name, args, detail, next] of COMMAND_TABLE) {
    const label = `\\${name}`;
    if (seen.has(label)) continue;
    seen.add(label);
    ALL_COMMANDS.push({
      label, type: 'function',
      detail: detail ?? (args ? args.replace(/\$\{([^}]*)\}/g, '$1').slice(0, 28) : undefined),
      apply: args ? applyCommand(label, args, next) : undefined,
    });
  }
  for (const [name, glyph] of SYMBOLS) {
    const label = `\\${name}`;
    if (seen.has(label)) continue;
    seen.add(label);
    ALL_COMMANDS.push({ label, type: 'text', detail: glyph, boost: -2 });
  }
}

/** Ready-made blocks: type a backslash and the name (for example \figure), pick it, then Tab through the blanks. */
const snip = (label: string, detail: string, template: string) => snippetCompletion(template, { label, detail, type: 'snippet', boost: -1 });
export const SNIPPETS: Completion[] = [
  snip('\\figure', 'figure with image and caption', '\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${file}}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}'),
  snip('\\table', 'table with caption', '\\begin{table}[htbp]\n\t\\centering\n\t\\caption{${caption}}\n\t\\label{tab:${label}}\n\t\\begin{tabular}{lcc}\n\t\t\\toprule\n\t\t${A} & ${B} & ${C} \\\\\n\t\t\\midrule\n\t\t${} & ${} & ${} \\\\\n\t\t\\bottomrule\n\t\\end{tabular}\n\\end{table}'),
  snip('\\equation', 'numbered equation', '\\begin{equation}\n\t${}\n\t\\label{eq:${label}}\n\\end{equation}'),
  snip('\\align', 'aligned equations', '\\begin{align}\n\t${a} &= ${b} \\\\\n\t&= ${c}\n\\end{align}'),
  snip('\\itemize', 'bullet list', '\\begin{itemize}\n\t\\item ${}\n\t\\item ${}\n\\end{itemize}'),
  snip('\\enumerate', 'numbered list', '\\begin{enumerate}\n\t\\item ${}\n\t\\item ${}\n\\end{enumerate}'),
  snip('\\frame', 'Beamer slide', '\\begin{frame}{${title}}\n\t${}\n\\end{frame}'),
  snip('\\tikz', 'TikZ drawing', '\\begin{tikzpicture}\n\t\\draw[->] (0,0) -- (${2},${1});\n\\end{tikzpicture}'),
  snip('\\plot', 'PGFPlots function plot', '\\begin{tikzpicture}\n\t\\begin{axis}[xlabel=$x$, ylabel=$y$]\n\t\t\\addplot[domain=${-2}:${2}, samples=50] {${x^2}};\n\t\\end{axis}\n\\end{tikzpicture}'),
  snip('\\code', 'highlighted code (minted)', '\\begin{minted}[linenos]{${python}}\n${}\n\\end{minted}'),
  snip('\\theorem', 'theorem and proof', '\\begin{theorem}\\label{thm:${label}}\n\t${}\n\\end{theorem}\n\\begin{proof}\n\t${}\n\\end{proof}'),
];

/** `\begin{name}` followed by an automatic `\end{name}` (only when nothing else follows on the line). */
function beginEnvironment(name: string): Completion {
  return {
    label: name, type: 'keyword',
    apply: (view, completion, from, to) => {
      const line = view.state.doc.lineAt(to);
      const closing = view.state.sliceDoc(to, to + 1) === '}' ? 1 : 0; // the brace the editor already added
      if (line.text.slice(to - line.from + closing).trim() !== '') {
        view.dispatch({ changes: { from, to: to + closing, insert: `${name}}` }, selection: { anchor: from + name.length + 1 } });
        return;
      }
      snippet(`${name}}\n\t\${}\n\\end{${name}}`)(view, completion, from, to + closing);
    },
  };
}

const opt = (label: string, type: string): Completion => ({ label, type });
const uniq = (xs: string[]) => [...new Set(xs)];

/** Environments opened but not yet closed in the text, innermost last. */
export function openEnvironments(text: string): string[] {
  const stack: string[] = [];
  for (const m of text.matchAll(/\\(begin|end)\{([^}\n]+)\}/g)) {
    if (m[1] === 'begin') stack.push(m[2]);
    else { const i = stack.lastIndexOf(m[2]); if (i >= 0) stack.splice(i, 1); }
  }
  return stack;
}

/**
 * One list entry per cited source. The matching text (label) holds key, author, year and title so that the editor's
 * own instant filtering finds a source by any of them; displayLabel shows only the key.
 */
export function citeOptions(entries: CiteEntry[]): Completion[] {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const e of [...entries].sort((a, b) => a.key.localeCompare(b.key))) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    const title = e.info?.split('\n')[0];
    out.push({
      label: [e.key, e.detail, title].filter(Boolean).join(' ').slice(0, 190),
      displayLabel: e.key, detail: e.detail, info: e.info, type: 'constant', apply: e.key,
    });
  }
  return out;
}

export function completionSource(data: () => CompletionData) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const inBraces = (items: string[], typed: string, type: string): CompletionResult => ({
      from: ctx.pos - typed.length,
      options: uniq(items).map((x) => opt(x, type)),
      validFor: /^[^,{}\s]*$/,
    });
    let m: RegExpExecArray | null;
    if ((m = /\\begin\{([A-Za-z*]*)$/.exec(before))) {
      return { from: ctx.pos - m[1].length, options: ENVIRONMENTS.map(beginEnvironment), validFor: /^[A-Za-z*]*$/ };
    }
    if ((m = /\\end\{([A-Za-z*]*)$/.exec(before))) {
      const open = openEnvironments(ctx.state.sliceDoc(0, ctx.pos - m[0].length)).reverse();
      return {
        from: ctx.pos - m[1].length,
        options: [
          ...open.map((e, i) => ({ label: e, type: 'keyword', detail: 'open', boost: 99 - i })),
          ...ENVIRONMENTS.filter((e) => !open.includes(e)).map((e) => opt(e, 'keyword')),
        ],
        validFor: /^[A-Za-z*]*$/,
      };
    }
    if ((m = /\\(?:eqref|autoref|cref|Cref|pageref|nameref|vref|ref)\{([^}]*)$/.exec(before))) return inBraces(data().labels(), m[1].split(',').pop()!.trimStart(), 'variable');
    if ((m = /\\(?:cite[a-zA-Z]*|parencite|textcite|autocite|footcite|nocite|smartcite|supercite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/.exec(before))) {
      const typed = m[1].split(',').pop()!.trimStart();
      return { from: ctx.pos - typed.length, options: citeOptions(data().cites()), validFor: /^[^,{}]*$/ };
    }
    if ((m = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) return inBraces(PACKAGES, m[1].split(',').pop()!.trimStart(), 'namespace');
    if ((m = /\\documentclass(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) return inBraces(DOCUMENT_CLASSES, m[1], 'namespace');
    if ((m = /\\bibliographystyle\{([^}]*)$/.exec(before))) return inBraces(BIB_STYLES, m[1], 'namespace');
    if ((m = /\\usetikzlibrary\{([^}]*)$/.exec(before))) return inBraces(TIKZ_LIBRARIES, m[1].split(',').pop()!.trimStart(), 'namespace');
    if ((m = /\\(bibliography|addbibresource)(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) {
      const bibs = data().files().filter((f) => /\.bib$/i.test(f)).map((f) => (m![1] === 'bibliography' ? f.replace(/\.bib$/i, '') : f));
      return inBraces(bibs, m[2].split(',').pop()!.trimStart(), 'text');
    }
    if ((m = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) {
      return inBraces(data().files().filter((f) => /\.(png|jpe?g|pdf|svg|eps|gif|tiff?)$/i.test(f)), m[1], 'text');
    }
    if ((m = /\\(?:input|include|subfile|import)(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) {
      return inBraces(data().files().filter((f) => /\.(tex|ltx|tikz|sty)$/i.test(f)), m[1], 'text');
    }
    // "/cite" works like "\cite" when the slash starts a word and at least three letters follow.
    if ((m = /(?:^|[\s({])(\/[a-zA-Z]{3,})$/.exec(before))) {
      const typed = m[1].slice(1).toLowerCase();
      const options = [...ALL_COMMANDS, ...SNIPPETS].filter((c) => c.label.slice(1).toLowerCase().startsWith(typed));
      if (options.length === 0) return null;
      return { from: ctx.pos - m[1].length, options, filter: false };
    }
    if ((m = /\\[a-zA-Z]*$/.exec(before)) && (m[0].length > 1 || ctx.explicit)) {
      return { from: ctx.pos - m[0].length, options: [...ALL_COMMANDS, ...SNIPPETS], validFor: /^\\[a-zA-Z]*$/ };
    }
    return null;
  };
}

export const labelsIn = (text: string): string[] => [...text.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]);

/** Keys of BibTeX/BibLaTeX entries and \bibitem lines. */
export const citeKeysIn = (text: string): string[] => [
  ...[...text.matchAll(/^\s*@(?!comment|string|preamble)[A-Za-z]+\s*[{(]\s*([^,\s]+)\s*,/gim)].map((m) => m[1]),
  ...[...text.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((m) => m[1]),
];

/** Value of a BibTeX field: {braced (nested)}, "quoted" or a bare word/number. */
function bibField(body: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*`, 'i').exec(body);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  let out = '';
  if (body[i] === '{') {
    let depth = 0;
    for (; i < body.length; i++) {
      if (body[i] === '{') { depth++; if (depth === 1) continue; }
      else if (body[i] === '}') { depth--; if (depth === 0) break; }
      out += body[i];
    }
  } else if (body[i] === '"') {
    for (i++; i < body.length && body[i] !== '"'; i++) out += body[i];
  } else {
    out = /^[A-Za-z0-9_:.-]+/.exec(body.slice(i))?.[0] ?? '';
  }
  return out.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim() || undefined;
}

/** Entries of a .bib file: "Author (Year)" as the short description and the title in the side panel. */
export function bibEntries(text: string): CiteEntry[] {
  const out: CiteEntry[] = [];
  const starts = [...text.matchAll(/^\s*@(?!comment|string|preamble)([A-Za-z]+)\s*[{(]\s*([^,\s]+)\s*,/gim)];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const body = text.slice(s.index! + s[0].length, i + 1 < starts.length ? starts[i + 1].index : undefined);
    const authors = (bibField(body, 'author') ?? bibField(body, 'editor') ?? '').split(/\s+and\s+/).filter(Boolean);
    const lastName = (a: string) => (a.includes(',') ? a.split(',')[0] : a.split(' ').pop() ?? a).trim();
    const who = authors.length === 0 ? '' : authors.length > 2 ? `${lastName(authors[0])} et al.` : authors.map(lastName).join(' & ');
    const year = bibField(body, 'year') ?? /^\d{4}/.exec(bibField(body, 'date') ?? '')?.[0] ?? '';
    const title = bibField(body, 'title') ?? bibField(body, 'booktitle');
    out.push({
      key: s[2],
      detail: [who, year].filter(Boolean).join(' ') || s[1].toLowerCase(),
      info: [title, authors.join('; '), [s[1].toLowerCase(), year].filter(Boolean).join(', ')].filter(Boolean).join('\n'),
    });
  }
  return out;
}

/** Entries for the completion list from one project file (.bib with descriptions, other sources with keys only). */
export function citeEntriesIn(path: string, text: string): CiteEntry[] {
  return /\.bib$/i.test(path) ? bibEntries(text) : citeKeysIn(text).map((key) => ({ key }));
}
