import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { gotoLine, openSearchPanel, searchKeymap } from '@codemirror/search';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';

function language(path) {
  const extension = path.toLowerCase().split('.').at(-1);
  if (['ts', 'tsx', 'mts', 'cts'].includes(extension)) return javascript({ typescript: true, jsx: extension === 'tsx' });
  if (['js', 'jsx', 'cjs', 'mjs'].includes(extension)) return javascript({ jsx: extension === 'jsx' });
  return ({ py: python, css, html, htm: html, json, md: markdown })[extension]?.() ?? [];
}

window.aliceEditor = {
  create(parent, file, onChange, onSave) {
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: file.text, extensions: [
        EditorView.cspNonce.of('alicecode-editor'), lineNumbers(), history(), drawSelection(),
        highlightActiveLine(), indentOnInput(), bracketMatching(), syntaxHighlighting(defaultHighlightStyle),
        EditorView.contentAttributes.of({ 'aria-label': 'Редактор кода', spellcheck: 'false' }),
        EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.sliceDoc()); }),
        EditorState.phrases.of({ Find: 'Найти', Replace: 'Заменить', next: 'Далее', previous: 'Назад',
          all: 'Все', 'match case': 'Регистр', regexp: 'Регулярное выражение', 'by word': 'Слово целиком',
          'replace': 'Заменить', 'replace all': 'Заменить все', 'close': 'Закрыть',
          'Go to line': 'Перейти к строке', go: 'Перейти' }),
        keymap.of([{ key: 'Mod-s', run: () => { onSave(); return true; } }, ...searchKeymap, ...historyKeymap,
          ...defaultKeymap, indentWithTab]),
        language(file.path),
      ] }),
    });
    return {
      focus: () => view.focus(),
      destroy: () => view.destroy(),
      search: () => openSearchPanel(view),
      go: () => gotoLine(view),
      line(number) {
        if (!Number.isInteger(number) || number < 1 || number > view.state.doc.lines) return;
        const line = view.state.doc.line(number);
        view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      },
    };
  },
};
