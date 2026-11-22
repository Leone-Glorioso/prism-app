import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { applyEol, buildBranch, bytesToBase64, cleanPath, decodeText, detectEol, encodeText, parseLog, resolveLogPath } from './util';

if (!globalThis.crypto) (globalThis as { crypto: unknown }).crypto = webcrypto; // Node 18

describe('buildBranch', () => {
  // Vectors from: printf '%s' "<name>" | sha1sum | cut -c1-12  (same command as compile.yml)
  it('matches the workflow for ASCII and Greek names', async () => {
    expect(await buildBranch('MSc Thesis 3.0')).toBe('builds/f09147dd6060');
    expect(await buildBranch('Εργασία 1')).toBe('builds/fa6c15bc262a');
  });
});

describe('text round trip', () => {
  it('keeps BOM, Greek text and CRLF exactly', () => {
    const original = '﻿\\section{Εισαγωγή}\r\nline 2\r\n';
    const bytes = encodeText(original);
    const text = decodeText(bytes)!;
    expect(text).toBe(original);
    const eol = detectEol(text);
    expect(eol).toBe('\r\n');
    const lf = text.replace(/\r\n/g, '\n');
    expect(encodeText(applyEol(lf, eol))).toEqual(bytes);
  });
  it('rejects binary and invalid UTF-8', () => {
    expect(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toBeNull();
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
  it('base64-encodes large buffers', () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(Buffer.from(bytesToBase64(big), 'base64').equals(Buffer.from(big))).toBe(true);
  });
});

describe('cleanPath', () => {
  it('normalises and rejects unsafe paths', () => {
    expect(cleanPath(' A/b\\c.tex ')).toEqual({ path: 'A/b/c.tex' });
    expect(cleanPath('A/../x')).toHaveProperty('error');
    expect(cleanPath('.github/workflows/x.yml')).toHaveProperty('error');
    expect(cleanPath('')).toHaveProperty('error');
  });
});

describe('log parsing', () => {
  const log = [
    './chapters/01_introduction.tex:12: Undefined control sequence.',
    'l.12 \\foo',
    '! LaTeX Error: File `missing.sty\' not found.',
    '',
    'l.5 \\usepackage',
    'LaTeX Warning: Citation `x\' on page 3 undefined on input line 42.',
    'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
    '(hyperref)                removing `math shift\' on input line 7.',
  ].join('\n');
  it('finds errors with locations and warnings', () => {
    const issues = parseLog(log);
    expect(issues[0]).toEqual({ kind: 'error', file: './chapters/01_introduction.tex', line: 12, message: 'Undefined control sequence.' });
    expect(issues[1]).toMatchObject({ kind: 'error', line: 5 });
    expect(issues[2]).toMatchObject({ kind: 'warning', line: 42 });
    expect(issues[3]).toMatchObject({ kind: 'warning', line: 7 });
    expect(issues).toHaveLength(4);
  });
  it('resolves log paths against the main file folder', () => {
    expect(resolveLogPath('P/src', './chapters/a.tex')).toBe('P/src/chapters/a.tex');
    expect(resolveLogPath('P/src', '../b.tex')).toBe('P/b.tex');
    expect(resolveLogPath('P', '/usr/local/texlive/x.sty')).toBeNull();
  });
});
