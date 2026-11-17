import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';

const decode = text => String(text ?? '').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, value => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  if (named[value]) return named[value];
  const point = value.startsWith('&#x') ? parseInt(value.slice(3), 16) : parseInt(value.slice(2), 10);
  return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : value;
});
const el = (tag, text) => { const node = document.createElement(tag); if (text != null) node.textContent = text; return node; };

export function renderMarkdown(text, { fileReference, copyText, openExternal } = {}) {
  function reference(value, label) {
    return fileReference?.(value, label);
  }
  function inline(parent, tokens = []) {
    for (const token of tokens) {
      let node;
      if (token.type === 'codespan') node = reference(decode(token.text)) ?? el('code', decode(token.text));
      else if (['strong', 'em', 'del'].includes(token.type)) {
        node = el(token.type); inline(node, token.tokens);
      } else if (token.type === 'link') {
        node = reference(token.href, token.text);
        if (!node && /^https?:\/\//i.test(token.href)) {
          node = el('button'); node.type = 'button'; node.className = 'markdown-link'; node.title = token.href;
          inline(node, token.tokens); node.addEventListener('click', () => openExternal?.(token.href));
        }
        if (!node) { node = el('span'); inline(node, token.tokens); }
      } else if (token.type === 'br') node = el('br');
      else if (token.type === 'text' && token.tokens) { node = el('span'); inline(node, token.tokens); }
      else node = document.createTextNode(decode(token.type === 'image' ? token.text : token.text ?? token.raw));
      parent.append(node);
    }
  }
  function blocks(parent, tokens) {
    for (const token of tokens) {
      let node;
      if (token.type === 'space' || token.type === 'def') continue;
      if (token.type === 'heading') { node = el('h' + token.depth); inline(node, token.tokens); }
      else if (token.type === 'paragraph' || token.type === 'text') {
        node = el('p'); inline(node, token.tokens ?? [{ type: 'text', text: token.text }]);
      } else if (token.type === 'code') {
        node = el('div'); node.className = 'markdown-code';
        const toolbar = el('div'); toolbar.className = 'code-toolbar';
        const lang = (token.lang ?? '').split(/\s/)[0];
        const copy = el('button', 'Копировать'); copy.type = 'button'; copy.className = 'quiet';
        copy.addEventListener('click', async () => {
          try { await copyText?.(token.text); copy.textContent = 'Скопировано'; }
          catch { copy.textContent = 'Не удалось скопировать'; }
        });
        toolbar.append(el('span', lang || 'Код'), copy);
        const pre = el('pre'), code = el('code');
        if (lang && hljs.getLanguage(lang) && token.text.length < 50000) {
          // Only the highlighter's escaped output is parsed as markup. Model HTML stays text.
          code.innerHTML = hljs.highlight(token.text, { language: lang, ignoreIllegals: true }).value;
        } else code.textContent = token.text;
        pre.append(code); node.append(toolbar, pre);
      } else if (token.type === 'blockquote') { node = el('blockquote'); blocks(node, token.tokens); }
      else if (token.type === 'list') {
        node = el(token.ordered ? 'ol' : 'ul');
        if (token.ordered) node.start = token.start;
        for (const item of token.items) {
          const li = el('li');
          if (item.task) { const check = el('input'); check.type = 'checkbox'; check.disabled = true; check.checked = item.checked; li.append(check); }
          blocks(li, item.tokens); node.append(li);
        }
      } else if (token.type === 'table') {
        node = el('div'); node.className = 'markdown-table';
        const table = el('table'), head = el('thead'), row = el('tr'), body = el('tbody');
        for (const cell of token.header) { const th = el('th'); inline(th, cell.tokens); row.append(th); }
        head.append(row);
        for (const cells of token.rows) {
          const tr = el('tr');
          for (const cell of cells) { const td = el('td'); inline(td, cell.tokens); tr.append(td); }
          body.append(tr);
        }
        table.append(head, body); node.append(table);
      } else if (token.type === 'hr') node = el('hr');
      else node = el('p', token.raw ?? token.text);
      parent.append(node);
    }
  }
  const root = el('div'); root.className = 'message-text markdown';
  blocks(root, marked.lexer(text, { gfm: true, breaks: true }));
  return root;
}

window.aliceMarkdown = { render: renderMarkdown };
