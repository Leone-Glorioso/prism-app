// LaTeX auto-completion: commands, environments, \ref labels, \cite keys and file names.

import { snippetCompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';

export interface CompletionData {
  labels(): string[];
  cites(): string[];
  files(): string[]; // paths relative to the main file's folder
}

const ENVIRONMENTS = [
  'document', 'abstract', 'itemize', 'enumerate', 'description', 'figure', 'figure*', 'table', 'table*', 'tabular', 'tabularx',
  'center', 'flushleft', 'flushright', 'quote', 'quotation', 'verbatim', 'equation', 'equation*', 'align', 'align*', 'gather',
  'gather*', 'multline', 'split', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'array', 'theorem', 'lemma', 'proof', 'definition',
  'corollary', 'remark', 'example', 'minipage', 'tikzpicture', 'lstlisting', 'algorithm', 'algorithmic', 'thebibliography',
  'frame', 'columns', 'column', 'appendices', 'subfigure', 'wrapfigure', 'otherlanguage', 'sloppypar',
];

const COMMANDS = [
  'documentclass', 'usepackage', 'begin', 'end', 'title', 'author', 'date', 'maketitle', 'tableofcontents', 'listoffigures',
  'listoftables', 'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'appendix',
  'label', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'nameref', 'cite', 'citep', 'citet', 'parencite', 'textcite',
  'autocite', 'nocite', 'bibliography', 'bibliographystyle', 'printbibliography', 'bibitem', 'footnote', 'textbf', 'textit',
  'texttt', 'textsc', 'textrm', 'textsf', 'emph', 'underline', 'bfseries', 'itshape', 'ttfamily', 'item', 'caption',
  'centering', 'includegraphics', 'input', 'include', 'includeonly', 'newcommand', 'renewcommand', 'providecommand',
  'newenvironment', 'newtheorem', 'setlength', 'addtolength', 'newcounter', 'setcounter', 'addtocounter', 'hspace', 'vspace',
  'hfill', 'vfill', 'noindent', 'indent', 'newline', 'newpage', 'clearpage', 'cleardoublepage', 'pagebreak', 'linebreak',
  'hline', 'cline', 'multicolumn', 'multirow', 'toprule', 'midrule', 'bottomrule', 'frac', 'sqrt', 'sum', 'prod', 'int',
  'lim', 'infty', 'partial', 'nabla', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'theta', 'lambda', 'mu',
  'pi', 'sigma', 'phi', 'omega', 'Gamma', 'Delta', 'Sigma', 'Omega', 'cdot', 'times', 'leq', 'geq', 'neq', 'approx',
  'mathbb', 'mathcal', 'mathbf', 'mathrm', 'mathit', 'operatorname', 'left', 'right', 'big', 'Big', 'text', 'url', 'href',
  'texorpdfstring', 'foreignlanguage', 'selectlanguage', 'setmainfont', 'setsansfont', 'setmonofont', 'geometry',
  'hypersetup', 'color', 'textcolor', 'colorbox', 'todo', 'quad', 'qquad', 'ldots', 'dots', 'today', 'thanks', 'tiny',
  'small', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'normalsize',
].map((c) => `\\${c}`);

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

const opt = (label: string, type: string): Completion => ({ label, type });
const uniq = (xs: string[]) => [...new Set(xs)];

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
    if ((m = /\\(?:begin|end)\{([A-Za-z*]*)$/.exec(before))) return inBraces(ENVIRONMENTS, m[1], 'keyword');
    if ((m = /\\(?:eqref|autoref|cref|Cref|pageref|nameref|vref|ref)\{([^}]*)$/.exec(before))) return inBraces(data().labels(), m[1].split(',').pop()!.trimStart(), 'variable');
    if ((m = /\\(?:cite[a-zA-Z]*|parencite|textcite|autocite|footcite|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/.exec(before))) return inBraces(data().cites(), m[1].split(',').pop()!.trimStart(), 'constant');
    if ((m = /\\(?:input|include|includegraphics)(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) return inBraces(data().files(), m[1], 'text');
    if ((m = /\\[a-zA-Z]*$/.exec(before)) && (m[0].length > 1 || ctx.explicit)) {
      return { from: ctx.pos - m[0].length, options: [...COMMANDS.map((c) => opt(c, 'function')), ...SNIPPETS], validFor: /^\\[a-zA-Z]*$/ };
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
