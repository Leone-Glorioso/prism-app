# Third-party software

The published app bundles the runtime packages below (generated from `package-lock.json`: production dependencies, without optional Node-only add-ons such as the `@napi-rs/canvas` binaries of pdf.js, which are not part of the web bundle).
Their licences are in each package; the main ones are MIT (CodeMirror, fflate) and Apache-2.0 (pdf.js).

| Package | Version | Licence |
|---|---|---|
| @codemirror/autocomplete (direct) | 6.20.4 | MIT |
| @codemirror/commands | 6.11.1 | MIT |
| @codemirror/language (direct) | 6.13.1 | MIT |
| @codemirror/legacy-modes (direct) | 6.5.5 | MIT |
| @codemirror/lint | 6.9.8 | MIT |
| @codemirror/search | 6.7.2 | MIT |
| @codemirror/state (direct) | 6.7.6 | MIT |
| @codemirror/streamparser | 6.0.0 | MIT |
| @codemirror/theme-one-dark (direct) | 6.1.3 | MIT |
| @codemirror/view (direct) | 6.43.15 | MIT |
| @lezer/common | 1.5.6 | MIT |
| @lezer/highlight | 1.2.5 | MIT |
| @lezer/lr | 1.4.12 | MIT |
| @marijn/find-cluster-break | 1.0.4 | MIT |
| codemirror (direct) | 6.0.2 | MIT |
| crelt | 1.0.7 | MIT |
| fflate (direct) | 0.8.3 | MIT |
| pdfjs-dist (direct) | 4.10.38 | Apache-2.0 |
| style-mod | 4.1.5 | MIT |
| w3c-keyname | 2.2.8 | MIT |

The compile container uses the official `texlive/texlive` Docker images (TeX Live, under the licences of its individual packages).
