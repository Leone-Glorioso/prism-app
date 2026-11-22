import { describe, expect, it } from 'vitest';
import { ACTIONS, comboOf, conflictFor, defaultShortcuts, formatCombo, overrides, sanitizeShortcuts, splitCombo, validateCombo } from './shortcuts';

describe('shortcuts', () => {
  it('turns key presses into combinations', () => {
    expect(comboOf({ key: 's', ctrlKey: true })).toBe('Mod-s');
    expect(comboOf({ key: 'S', metaKey: true, shiftKey: true })).toBe('Mod-Shift-s');
    expect(comboOf({ key: 'Enter', ctrlKey: true })).toBe('Mod-Enter');
    expect(comboOf({ key: 'j', ctrlKey: true, altKey: true })).toBe('Mod-Alt-j');
    expect(comboOf({ key: ' ', ctrlKey: true })).toBe('Mod-Space');
    expect(comboOf({ key: '/', ctrlKey: true, shiftKey: true })).toBe('Mod-/'); // Shift only changes the character
    expect(comboOf({ key: 'Control', ctrlKey: true })).toBeNull();
  });

  it('splits and formats combinations, including the minus key', () => {
    expect(splitCombo('Mod-Shift-f')).toEqual({ mods: ['Mod', 'Shift'], key: 'f' });
    expect(splitCombo('Mod--')).toEqual({ mods: ['Mod'], key: '-' });
    expect(formatCombo('Mod-Shift-f', false)).toBe('Ctrl+Shift+F');
    expect(formatCombo('Mod-Alt-j', true)).toBe('⌘⌥J');
    expect(formatCombo('', false)).toBe('—');
  });

  it('refuses keys the browser needs and keys without Ctrl/Alt', () => {
    expect(validateCombo('Mod-s')).toBeNull();
    expect(validateCombo('Mod-Alt-h')).toBeNull();
    expect(validateCombo('F2')).toBeNull();
    expect(validateCombo('Mod-w')).toMatch(/already uses/);
    expect(validateCombo('Mod-Space')).toMatch(/already uses/);
    expect(validateCombo('a')).toMatch(/Ctrl/);
    expect(validateCombo('Shift-a')).toMatch(/Ctrl/);
    expect(validateCombo('Mod-Foo')).toMatch(/cannot be used/);
  });

  it('finds a clash with another action', () => {
    const map = defaultShortcuts();
    expect(conflictFor(map, 'Mod-s', 'compile')?.id).toBe('save');
    expect(conflictFor(map, 'Mod-s', 'save')).toBeNull();
    expect(conflictFor(map, 'Mod-Alt-k', 'save')).toBeNull();
  });

  it('keeps only valid, unique stored overrides', () => {
    expect(sanitizeShortcuts(null)).toEqual(defaultShortcuts());
    const map = sanitizeShortcuts({ save: 'Mod-Shift-s', compile: 'Mod-Shift-s', bold: 'Mod-w', italic: 5 });
    expect(map.save).toBe('Mod-Shift-s');
    expect(map.compile).toBe('Mod-Enter');
    expect(map.bold).toBe('Mod-b');
    expect(overrides(map)).toEqual({ save: 'Mod-Shift-s' });
  });

  it('has unique, valid defaults', () => {
    const keys = ACTIONS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(validateCombo(k)).toBeNull();
  });
});
