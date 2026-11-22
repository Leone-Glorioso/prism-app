import { describe, expect, it } from 'vitest';
import { daysLeft, expiryState, EXPIRY_WARNING_DAYS } from './expiry';
import { replaceInTexts } from './search';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 15, 30); // local afternoon

describe('token expiry reminder', () => {
  it('warns from 10 days before, not earlier', () => {
    expect(EXPIRY_WARNING_DAYS).toBe(10);
    const exp = '2027-03-20';
    expect(daysLeft(exp, day(2027, 3, 10))).toBe(10);
    expect(expiryState(exp, day(2027, 3, 10))).toMatchObject({ level: 'soon' });
    expect(expiryState(exp, day(2027, 3, 9))).toBeNull(); // 11 days left
    expect(expiryState(exp, day(2026, 11, 22))).toBeNull(); // months away
  });
  it('words the warning for tomorrow, today and expired', () => {
    expect(expiryState('2027-03-20', day(2027, 3, 19))!.text).toContain('tomorrow');
    expect(expiryState('2027-03-20', day(2027, 3, 20))!.text).toContain('today');
    expect(expiryState('2027-03-20', day(2027, 3, 21))).toMatchObject({ level: 'expired' });
    expect(expiryState('2027-03-20', day(2027, 3, 15))!.text).toContain('in 5 days');
  });
  it('ignores missing or invalid dates', () => {
    expect(daysLeft(undefined)).toBeNull();
    expect(daysLeft('')).toBeNull();
    expect(daysLeft('20-03-2027')).toBeNull();
    expect(daysLeft('2027-02-31')).toBeNull();
    expect(expiryState('nonsense')).toBeNull();
  });
  it('counts across month and year ends and leap days', () => {
    expect(daysLeft('2027-01-05', day(2026, 12, 30))).toBe(6);
    expect(daysLeft('2028-03-01', day(2028, 2, 27))).toBe(3); // 2028 is a leap year
  });
});

describe('replaceInTexts', () => {
  const texts = new Map([
    ['a.tex', 'Cat sat.\r\nThe cat purred. CAT!\r\n'],
    ['b.tex', 'no match here\nsecond line\n'],
    ['c.bib', '﻿catalog entry cat\n'],
  ]);
  it('replaces literally, case-insensitively, and keeps line endings and a BOM', () => {
    const r = replaceInTexts(texts, 'cat', 'dog', { regex: false, caseSensitive: false });
    expect(r.total).toBe(5); // Cat, cat, CAT in a.tex; the "cat" in "catalog" and the last one in c.bib
    expect(r.changed.get('a.tex')!.text).toBe('dog sat.\r\nThe dog purred. dog!\r\n');
    expect(r.changed.get('c.bib')!.text).toBe('﻿dogalog entry dog\n');
    expect(r.changed.has('b.tex')).toBe(false);
  });
  it('treats the replacement literally in plain mode ($& stays text) and supports groups in regex mode', () => {
    expect(replaceInTexts(texts, 'cat', '[$&]', { regex: false, caseSensitive: true }).changed.get('a.tex')!.text).toBe('Cat sat.\r\nThe [$&] purred. CAT!\r\n');
    const r = replaceInTexts(new Map([['x.tex', 'foo-1 foo-22']]), 'foo-(\\d+)', 'bar_$1 [$&] $$ $9', { regex: true, caseSensitive: true });
    expect(r.changed.get('x.tex')!.text).toBe('bar_1 [foo-1] $ $9 bar_22 [foo-22] $ $9');
  });
  it('never replaces empty matches, and reports bad patterns and empty queries', () => {
    const r = replaceInTexts(new Map([['x.tex', 'abc']]), 'x*', 'Z', { regex: true, caseSensitive: true });
    expect(r.total).toBe(0);
    expect(r.changed.size).toBe(0);
    expect(replaceInTexts(texts, '(', 'x', { regex: true, caseSensitive: false }).error).toBeTruthy();
    expect(replaceInTexts(texts, '', 'x', { regex: false, caseSensitive: false })).toMatchObject({ total: 0 });
  });
  it('counts the same matches as the search does', () => {
    // search finds matches per line, replace works per line too: a pattern spanning a line break matches neither
    const t = new Map([['x.tex', 'ab\ncd\n']]);
    expect(replaceInTexts(t, 'b\\nc', '-', { regex: true, caseSensitive: true }).total).toBe(0);
  });
});
