// Repository-wide compiler settings, stored in prism-compiler.json and read by the compile workflow.
// The workflow validates the same values again, so a hand-edited file cannot select anything else.

export const COMPILER_FILE = 'prism-compiler.json';
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = 40;

export interface CompilerConfig {
  /** "latest" or a TeX Live year (the official texlive/texlive image of that year). */
  texlive: string;
  timeoutMinutes: number;
}

export const defaultCompilerConfig: CompilerConfig = { texlive: 'latest', timeoutMinutes: DEFAULT_TIMEOUT_MINUTES };

/** Years that exist as frozen images (TL<year>-historic). 2013..2025 at the time of writing. */
export const TEXLIVE_YEARS: string[] = Array.from({ length: 13 }, (_, i) => String(2025 - i));

export const isTexliveChoice = (v: unknown): v is string => v === 'latest' || (typeof v === 'string' && /^20(1[3-9]|2[0-9])$/.test(v));

export function parseCompilerConfig(text: string | null | undefined): CompilerConfig {
  const cfg = { ...defaultCompilerConfig };
  if (!text) return cfg;
  try {
    const j = JSON.parse(text.replace(/^﻿/, '')) as { texlive?: unknown; timeoutMinutes?: unknown };
    const tl = j.texlive === undefined || j.texlive === null ? undefined : String(j.texlive);
    if (tl !== undefined && isTexliveChoice(tl)) cfg.texlive = tl;
    const m = Number(j.timeoutMinutes);
    if (Number.isInteger(m) && m >= 1 && m <= MAX_TIMEOUT_MINUTES) cfg.timeoutMinutes = m;
  } catch { /* an unreadable file means defaults */ }
  return cfg;
}

export function serializeCompilerConfig(cfg: CompilerConfig): string {
  const safe = parseCompilerConfig(JSON.stringify(cfg));
  return JSON.stringify(safe, null, 2) + '\n';
}

export const isDefaultConfig = (c: CompilerConfig) => c.texlive === defaultCompilerConfig.texlive && c.timeoutMinutes === defaultCompilerConfig.timeoutMinutes;

/** Extra latexmk options: plain words only (same rule as compile.sh). */
export function validLatexmkArgs(s: string): boolean {
  return s.length <= 300 && /^[A-Za-z0-9 _=.,:+/@%-]*$/.test(s);
}

/** "2026" from the first lines of a TeX log: "... (TeX Live 2026) ..." or "(TeX Live 2019/Debian)". */
export function texliveFromLog(log: string): string | null {
  const m = /\(TeX Live (\d{4})[^)]*\)/.exec(log.slice(0, 4000));
  return m ? m[1] : null;
}
