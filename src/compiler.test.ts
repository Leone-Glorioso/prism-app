import { describe, expect, it } from 'vitest';
import { COMPILER_FILE, defaultCompilerConfig, isDefaultConfig, parseCompilerConfig, serializeCompilerConfig, TEXLIVE_YEARS, texliveFromLog, validLatexmkArgs } from './compiler';

describe('compiler settings file', () => {
  it('reads valid values and falls back to defaults for anything else', () => {
    expect(COMPILER_FILE).toBe('prism-compiler.json');
    expect(parseCompilerConfig(null)).toEqual(defaultCompilerConfig);
    expect(parseCompilerConfig('{"texlive":"2024","timeoutMinutes":15}')).toEqual({ texlive: '2024', timeoutMinutes: 15 });
    expect(parseCompilerConfig('{"texlive":2023}')).toMatchObject({ texlive: '2023' }); // a number is fine too
    expect(parseCompilerConfig('{"texlive":"evil/image:tag","timeoutMinutes":9999}')).toEqual(defaultCompilerConfig);
    expect(parseCompilerConfig('{"texlive":"2012","timeoutMinutes":0}')).toEqual(defaultCompilerConfig);
    expect(parseCompilerConfig('{"timeoutMinutes":"abc"}')).toEqual(defaultCompilerConfig);
    expect(parseCompilerConfig('not json at all')).toEqual(defaultCompilerConfig);
    expect(parseCompilerConfig('﻿{"texlive":"2025"}').texlive).toBe('2025');
  });
  it('writes only validated values, as readable JSON ending in a newline', () => {
    const text = serializeCompilerConfig({ texlive: '2024', timeoutMinutes: 20 });
    expect(JSON.parse(text)).toEqual({ texlive: '2024', timeoutMinutes: 20 });
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(serializeCompilerConfig({ texlive: '$(rm -rf /)', timeoutMinutes: -5 }))).toEqual(defaultCompilerConfig);
    expect(isDefaultConfig(defaultCompilerConfig)).toBe(true);
    expect(isDefaultConfig({ texlive: '2024', timeoutMinutes: 30 })).toBe(false);
  });
  it('offers the frozen years newest first', () => {
    expect(TEXLIVE_YEARS[0]).toBe('2025');
    expect(TEXLIVE_YEARS.at(-1)).toBe('2013');
    expect(TEXLIVE_YEARS).toHaveLength(13);
  });
});

describe('extra latexmk options', () => {
  it('allows plain words and rejects anything a shell or Perl could interpret', () => {
    expect(validLatexmkArgs('')).toBe(true);
    expect(validLatexmkArgs('-g -time')).toBe(true);
    expect(validLatexmkArgs('-bibtex- -pdflatex=lualatex')).toBe(true);
    for (const bad of ['-e $x=1', '; rm -rf /', '`id`', '$(id)', '-e "x"', "a'b", 'a|b', 'a&b', 'a>b', 'a\nb', '\\x']) expect(validLatexmkArgs(bad), bad).toBe(false);
    expect(validLatexmkArgs('a'.repeat(301))).toBe(false);
  });
});

describe('texliveFromLog', () => {
  it('finds the TeX Live year', () => {
    expect(texliveFromLog('This is XeTeX, Version 3.14 (TeX Live 2026) (preloaded format=xelatex)')).toBe('2026');
    expect(texliveFromLog('This is pdfTeX (TeX Live 2019/Debian) (preloaded)')).toBe('2019');
    expect(texliveFromLog('This is pdfTeX, Version 3.14 (MiKTeX 22.10)')).toBeNull();
    expect(texliveFromLog('')).toBeNull();
  });
});
