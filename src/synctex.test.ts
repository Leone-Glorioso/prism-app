import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { forward, inverse, mapInputs, parseSynctex, parseSynctexFile } from './synctex';

// A tiny file in the real format (values copied in structure from a pdfLaTeX/XeLaTeX build).
// Offsets are 1 inch = 4736287 sp, so a box at (0, 0) sits at (72 bp, 72 bp).
const SAMPLE = [
  'SyncTeX Version:1',
  'Input:1:/work/Proj A/./main.tex',
  'Input:2:/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls',
  'Input:3:/work/Proj A/chapters/./one.tex',
  'Output:pdf',
  'Magnification:1000',
  'Unit:1',
  'X Offset:4736287',
  'Y Offset:4736287',
  'Content:',
  '!100',
  '{1',
  '[1,5:0,9868200:32891000,9868200,0', // page-sized vbox of main.tex line 5 (must not win)
  '(3,10:0,1000000:32891000,657000,131000', // line 10 of one.tex: x 72, y = (1000000-657000+4736287)/65781.76
  'k3,10:100,1000000:50000',
  '(3,11:0,2000000:32891000,657000,131000',
  '(1,7:0,3000000:6578176,657000,131000',
  '(2,99:0,4000000:6578176,657000,131000', // class file box: must be ignored by inverse
  ']',
  '!10',
  '}1',
  '{2',
  '(3,40:0,1000000:32891000,657000,131000',
  '}2',
  'Postamble:',
  'Input:4:/work/Proj A/main.aux',
  'Count:3',
].join('\n');

describe('parseSynctex', () => {
  const st = parseSynctex(SAMPLE);
  it('reads inputs, sheets and box geometry in bp from the top-left', () => {
    expect(st.inputs.get(3)).toBe('/work/Proj A/chapters/./one.tex');
    expect(st.inputs.size).toBe(4); // also inputs listed after the content
    expect(st.pages).toHaveLength(2);
    const b = st.pages[0].find((x) => x.line === 10)!;
    expect(b.x).toBeCloseTo(72, 1);
    expect(b.y).toBeCloseTo((1000000 - 657000 + 4736287) / 65781.76, 3);
    expect(b.w).toBeCloseTo(32891000 / 65781.76, 3);
    expect(b.h).toBeCloseTo((657000 + 131000) / 65781.76, 3);
  });
  it('reads gzip data', () => {
    const gz = parseSynctexFile(gzipSync(new TextEncoder().encode(SAMPLE)));
    expect(gz.pages).toHaveLength(2);
  });
});

describe('mapInputs', () => {
  it('maps container paths and relative paths, ignores system files', () => {
    const st = parseSynctex(SAMPLE);
    const repo = new Set(['Proj A/main.tex', 'Proj A/chapters/one.tex', 'Proj A/main.aux']);
    const m = mapInputs(st.inputs, 'Proj A', 'Proj A', repo);
    expect(m.get(1)).toBe('Proj A/main.tex');
    expect(m.get(3)).toBe('Proj A/chapters/one.tex');
    expect(m.has(2)).toBe(false);
    expect(mapInputs(new Map([[1, './sub/x.tex'], [2, 'C:\\Users\\me\\Proj A\\y.tex']]), 'Proj A', 'Proj A', new Set(['Proj A/sub/x.tex', 'Proj A/y.tex'])))
      .toEqual(new Map([[1, 'Proj A/sub/x.tex'], [2, 'Proj A/y.tex']]));
  });
});

describe('forward / inverse', () => {
  const st = parseSynctex(SAMPLE);
  it('finds the page and innermost rectangle for a line', () => {
    const f = forward(st, new Set([3]), 10)!;
    expect(f.page).toBe(1);
    expect(f.exact).toBe(true);
    expect(f.rects).toHaveLength(1);
    expect(f.rects[0].x).toBeCloseTo(72, 1);
  });
  it('uses the nearest line that produced output', () => {
    const f = forward(st, new Set([3]), 12)!; // 11 and 40 exist; 11 is nearest
    expect(f.exact).toBe(false);
    expect(f.page).toBe(1);
    expect(forward(st, new Set([3]), 38)!.page).toBe(2); // 40 is nearer than 11
    expect(forward(st, new Set([9]), 1)).toBeNull();
  });
  it('maps a click back to the smallest usable box', () => {
    const usable = (t: number) => t === 1 || t === 3;
    const f = forward(st, new Set([3]), 11)!.rects[0];
    expect(inverse(st, 1, f.x + 5, f.y + f.h / 2, usable)).toEqual({ tag: 3, line: 11 });
    // a point inside the page-sized vbox but outside any line box falls back to the closest line, not the big box
    const far = inverse(st, 1, 300, 700, usable);
    expect(far === null || far.line !== 99).toBe(true);
    // the class-file box (tag 2) is never returned
    expect(inverse(st, 1, 80, (4000000 - 657000 + 4736287) / 65781.76 + 3, usable)?.tag).not.toBe(2);
    expect(inverse(st, 9, 1, 1, usable)).toBeNull();
  });
});
