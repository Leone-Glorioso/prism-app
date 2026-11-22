// CodeMirror 6 setup: one view, one EditorState per open file (keeps undo history per file).

import { basicSetup } from 'codemirror';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { oneDark } from '@codemirror/theme-one-dark';
import { isTexLike } from './util';

const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const texLanguage = StreamLanguage.define(stex);

export interface EditorHooks {
  onChange: (path: string, state: EditorState) => void;
  onSave: () => void;
  onCompile: () => void;
}

export function createView(parent: HTMLElement): EditorView {
  return new EditorView({ parent });
}

export function createState(path: string, text: string, hooks: EditorHooks): EditorState {
  const extensions: Extension[] = [
    basicSetup,
    EditorView.lineWrapping,
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { hooks.onSave(); return true; } },
      { key: 'Mod-Enter', preventDefault: true, run: () => { hooks.onCompile(); return true; } },
    ]),
    EditorView.updateListener.of((u) => { if (u.docChanged) hooks.onChange(path, u.state); }),
    EditorView.contentAttributes.of({ 'aria-label': `Editor: ${path}` }),
  ];
  if (isTexLike(path)) extensions.push(texLanguage);
  if (dark) extensions.push(oneDark);
  return EditorState.create({ doc: text, extensions });
}

export function goToLine(view: EditorView, line: number) {
  const n = Math.min(Math.max(1, line), view.state.doc.lines);
  const pos = view.state.doc.line(n).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
}
