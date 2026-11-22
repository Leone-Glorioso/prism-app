// Starting points for new projects. Every template is compiled on real GitHub runners before release.

export interface Template {
  id: string;
  name: string;
  description: string;
  engine: 'pdflatex' | 'xelatex' | 'lualatex';
  bibliography: 'none' | 'biber' | 'bibtex';
  /** Files relative to the project folder; main.tex is the main file. */
  files: Record<string, string>;
  shellEscape?: boolean;
  latexmkrc?: boolean;
}

export const TEMPLATES: Template[] = [
  {
    id: 'article', name: 'Article', description: 'Short paper or report with sections, figures and links.', engine: 'pdflatex', bibliography: 'none',
    files: { 'main.tex': String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[margin=2.5cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[hidelinks]{hyperref}

\title{Title of the article}
\author{Author Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
A short summary of the work.
\end{abstract}

\section{Introduction}
Write here. A formula: \( E = mc^2 \), and a displayed one:
\begin{equation}
  \int_0^1 x^2\,dx = \frac{1}{3}.
\end{equation}

\section{Method}
Text.

\section{Conclusion}
Text.

\end{document}
` },
  },
  {
    id: 'article-biblatex', name: 'Article with bibliography', description: 'Article using BibLaTeX and Biber, with a sample references.bib.', engine: 'pdflatex', bibliography: 'biber',
    files: {
      'main.tex': String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[margin=2.5cm]{geometry}
\usepackage[backend=biber,style=numeric,sorting=nyt]{biblatex}
\addbibresource{references.bib}
\usepackage[hidelinks]{hyperref}

\title{Article with references}
\author{Author Name}

\begin{document}
\maketitle

\section{Introduction}
Cite a book \cite{knuth1984} or an article \cite{lamport1994}.

\printbibliography
\end{document}
`,
      'references.bib': String.raw`@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {TeXbook}},
  publisher = {Addison-Wesley},
  year      = {1984}
}

@book{lamport1994,
  author    = {Leslie Lamport},
  title     = {{LaTeX}: A Document Preparation System},
  publisher = {Addison-Wesley},
  year      = {1994}
}
`,
    },
  },
  {
    id: 'book', name: 'Report or thesis (book)', description: 'Chapters in separate files, table of contents and appendix.', engine: 'pdflatex', bibliography: 'none',
    files: {
      'main.tex': String.raw`\documentclass[11pt,a4paper,openany]{book}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[margin=3cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[hidelinks]{hyperref}

\title{Title of the thesis}
\author{Author Name}
\date{\today}

\begin{document}
\frontmatter
\maketitle
\tableofcontents

\mainmatter
\input{chapters/introduction}
\input{chapters/background}

\appendix
\chapter{Additional material}
Text.

\end{document}
`,
      'chapters/introduction.tex': String.raw`\chapter{Introduction}
\label{ch:intro}
Motivation and goals. See Chapter~\ref{ch:background}.
`,
      'chapters/background.tex': String.raw`\chapter{Background}
\label{ch:background}
\section{Related work}
Text.
`,
    },
  },
  {
    id: 'beamer', name: 'Presentation (Beamer)', description: 'Slides with a title frame and bullet points.', engine: 'pdflatex', bibliography: 'none',
    files: { 'main.tex': String.raw`\documentclass[aspectratio=169]{beamer}
\usetheme{Madrid}
\usecolortheme{default}

\title{Presentation title}
\author{Author Name}
\institute{Institution}
\date{\today}

\begin{document}
\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{Outline}
  \tableofcontents
\end{frame}

\section{First part}
\begin{frame}{A slide}
  \begin{itemize}
    \item First point
    \item Second point
  \end{itemize}
\end{frame}

\end{document}
` },
  },
  {
    id: 'letter', name: 'Letter', description: 'A formal letter.', engine: 'pdflatex', bibliography: 'none',
    files: { 'main.tex': String.raw`\documentclass[11pt]{letter}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[a4paper,margin=2.5cm]{geometry}
\signature{Your Name}
\address{Your Street 1 \\ 12345 City}

\begin{document}
\begin{letter}{Recipient Name \\ Recipient Street 2 \\ 54321 Town}
\opening{Dear Sir or Madam,}

Write the letter here.

\closing{Yours faithfully,}
\end{letter}
\end{document}
` },
  },
  {
    id: 'greek', name: 'Greek article (XeLaTeX)', description: 'Greek text with English parts, using Unicode fonts.', engine: 'xelatex', bibliography: 'none',
    files: { 'main.tex': String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[margin=2.5cm]{geometry}
\usepackage{fontspec}
\usepackage{polyglossia}
\setmainlanguage{greek}
\setotherlanguage{english}
\setmainfont{CMU Serif}
\setsansfont{CMU Sans Serif}

\title{Τίτλος εργασίας}
\author{Όνομα Συγγραφέα}
\date{\today}

\begin{document}
\maketitle

\section{Εισαγωγή}
Γράψτε εδώ το κείμενο. \textenglish{English text can be mixed in.}

\end{document}
` },
  },
  {
    id: 'tikz', name: 'Figures and plots (TikZ + PGFPlots)', description: 'Drawings and function plots written directly in LaTeX.', engine: 'pdflatex', bibliography: 'none',
    files: { 'main.tex': String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[margin=2.5cm]{geometry}
\usepackage{tikz}
\usepackage{pgfplots}
\pgfplotsset{compat=1.17}

\begin{document}
\section*{A drawing}
\begin{center}
\begin{tikzpicture}
  \draw[->] (0,0) -- (3,0) node[right] {$x$};
  \draw[->] (0,0) -- (0,2) node[above] {$y$};
  \draw[thick,blue] (0,0) -- (2,1.5) node[above right] {A};
\end{tikzpicture}
\end{center}

\section*{A plot}
\begin{center}
\begin{tikzpicture}
  \begin{axis}[xlabel=$x$, ylabel=$y$, width=8cm, height=6cm, grid=major]
    \addplot[domain=-2:2, samples=50, thick] {x^2};
  \end{axis}
\end{tikzpicture}
\end{center}
\end{document}
` },
  },
  {
    id: 'code', name: 'Document with code listings', description: 'Highlighted source code with the minted package.', engine: 'pdflatex', bibliography: 'none',
    files: { 'main.tex': String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[margin=2.5cm]{geometry}
\usepackage{minted}

\begin{document}
\section*{Code}
\begin{minted}[linenos,frame=lines]{python}
def square(x):
    return x * x

print(square(7))
\end{minted}
\end{document}
` },
  },
  {
    id: 'blank', name: 'Blank', description: 'Only the minimal skeleton.', engine: 'pdflatex', bibliography: 'none',
    files: { 'main.tex': String.raw`\documentclass{article}

\begin{document}
% Write your document here. (\null makes sure the empty page still produces a PDF.)
\null
\end{document}
` },
  },
];

export const templateById = (id: string): Template => TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
