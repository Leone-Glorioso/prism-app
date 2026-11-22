// CodeMirror 6 setup: one view, one EditorState per open file (keeps undo history per file).

import { basicSetup } from 'codemirror';
import { EditorSelection, EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { oneDark } from '@codemirror/theme-one-dark';
import type { CompletionSource } from '@codemirror/autocomplete';
import { isTexLike } from './util';
import { ACTIONS, cmKey } from './shortcuts';
import type { ActionId, ShortcutMap } from './shortcuts';

const texLanguage = StreamLanguage.define(stex);

export interface EditorHooks {
  onChange: (path: string, state: EditorState) => void;
  onCursor: (path: string, line: number) => void;
  onAction: (id: ActionId) => void;
}

export interface EditorEnv {
  dark: boolean;
  spellcheck: boolean;
  lang: string;
  complete: CompletionSource;
  keys: ShortcutMap;
  lineWrap: boolean;
  autoComplete: boolean;
}

/** Actions that edit the text around the selection (only in LaTeX files). */
const WRAPPERS: Partial<Record<ActionId, [string, string]>> = {
  bold: ['\\textbf{', '}'],
  italic: ['\\emph{', '}'],
  inlineMath: ['$', '$'],
};

export function createView(parent: HTMLElement): EditorView {
  return new EditorView({ parent });
}

/** Wraps every selection in `open` … `close`; with no selection it inserts both and puts the cursor between them. */
export function wrapSelection(view: EditorView, open: string, close: string): boolean {
  view.dispatch(view.state.changeByRange((range) => ({
    changes: [{ from: range.from, insert: open }, { from: range.to, insert: close }],
    range: EditorSelection.range(range.from + open.length, range.to + open.length),
  })));
  return true;
}

export function createState(path: string, text: string, hooks: EditorHooks, env: EditorEnv): EditorState {
  const tex = isTexLike(path);
  const extensions: Extension[] = [
    basicSetup,
    ...(env.lineWrap ? [EditorView.lineWrapping] : []),
    Prec.high(keymap.of(ACTIONS.flatMap((a) => {
      const key = cmKey(env.keys[a.id]);
      if (!key) return [];
      const wrap = WRAPPERS[a.id];
      return [{
        key,
        preventDefault: true,
        run: (v: EditorView) => {
          if (wrap) return tex ? wrapSelection(v, wrap[0], wrap[1]) : false;
          hooks.onAction(a.id);
          return true;
        },
      }];
    }))),
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
  if (tex) {
    extensions.push(texLanguage);
    // languageData instead of autocompletion({override}): basicSetup already configures autocompletion().
    if (env.autoComplete) extensions.push(EditorState.languageData.of(() => [{ autocomplete: env.complete }]));
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
