// CodeMirror 6 setup: one view, one EditorState per open file (keeps undo history per file).

import { basicSetup } from 'codemirror';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { oneDark } from '@codemirror/theme-one-dark';
import type { CompletionSource } from '@codemirror/autocomplete';
import { isTexLike } from './util';

const texLanguage = StreamLanguage.define(stex);

export interface EditorHooks {
  onChange: (path: string, state: EditorState) => void;
  onCursor: (path: string, line: number) => void;
  onSave: () => void;
  onCompile: () => void;
  onForward: () => void;
}

export interface EditorEnv {
  dark: boolean;
  spellcheck: boolean;
  lang: string;
  complete: CompletionSource;
}

export function createView(parent: HTMLElement): EditorView {
  return new EditorView({ parent });
}

export function createState(path: string, text: string, hooks: EditorHooks, env: EditorEnv): EditorState {
  const extensions: Extension[] = [
    basicSetup,
    EditorView.lineWrapping,
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { hooks.onSave(); return true; } },
      { key: 'Mod-Enter', preventDefault: true, run: () => { hooks.onCompile(); return true; } },
      { key: 'Mod-Alt-j', preventDefault: true, run: () => { hooks.onForward(); return true; } },
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) hooks.onChange(path, u.state);
      else if (u.selectionSet) hooks.onCursor(path, u.state.doc.lineAt(u.state.selection.main.head).number);
    }),
    EditorView.contentAttributes.of({
      'aria-label': `Editor: ${path}`,
      spellcheck: env.spellcheck ? 'true' : 'false',
      lang: env.lang,
      autocorrect: 'off',
      autocapitalize: 'off',
    }),
  ];
  if (isTexLike(path)) {
    extensions.push(texLanguage);
    // languageData instead of autocompletion({override}): basicSetup already configures autocompletion().
    extensions.push(EditorState.languageData.of(() => [{ autocomplete: env.complete }]));
  }
  if (env.dark) extensions.push(oneDark);
  return EditorState.create({ doc: text, extensions });
}

export function goToLine(view: EditorView, line: number) {
  const n = Math.min(Math.max(1, line), view.state.doc.lines);
  const pos = view.state.doc.line(n).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
}

export function currentLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number;
}
