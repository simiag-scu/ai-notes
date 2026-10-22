export function stripColorSpans(text) {
  const stack = [];
  return text.replace(/<span\b[^>]*>|<\/span>/gi, tag => {
    if (/^<\//.test(tag)) return stack.pop() ? '' : tag;
    const color = /^<span\s+style="color:(?:#[a-fA-F0-9]{6}|var\(--text-normal\));?">$/.test(tag);
    stack.push(color); return color ? '' : tag;
  });
}
// Render only known Markdown and color spans. All other HTML remains text.
// Source offsets belong to the original Markdown, never to its rendered text.
export function createMarkdownRenderer({ element, noteURL, loadAsset }) {
  const positions = new WeakMap(), documents = new WeakMap();
  function text(parent, value, start, end = start + value.length, atomic = false) {
    if (!value) return;
    const node = document.createTextNode(value); parent.append(node); positions.set(node, { start, end, atomic });
  }
  function block(node, start, end) { node.dataset.mdStart = start; node.dataset.mdEnd = end; return node; }
  function closeSpan(value, start) {
    const tags = /<span\b[^>]*>|<\/span>/g; tags.lastIndex = start; let depth = 1, match;
    while ((match = tags.exec(value))) { depth += match[0] === '</span>' ? -1 : 1; if (!depth) return { start: match.index, end: tags.lastIndex }; }
    return null;
  }
  function inline(value, parent, base, depth = 0) {
    if (depth > 18) { text(parent, value, base); return; }
    const pattern = /<span\s+style="color:(?:#[a-fA-F0-9]{6}|var\(--text-normal\));?">|!?\[\[[^\]\n]+\]\]|!?\[[^\]\n]*\]\([^\n)]+\)|`[^`\n]+`|\*\*[^*]+\*\*|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\[\\`*{}\[\]()#+\-.!_|]/g;
    let cursor = 0, match;
    while ((match = pattern.exec(value))) {
      text(parent, value.slice(cursor, match.index), base + cursor);
      const token = match[0], start = base + match.index, end = start + token.length; cursor = pattern.lastIndex;
      if (token.startsWith('<span')) {
        const close = closeSpan(value, cursor);
        if (!close) { text(parent, token, start); continue; }
        const span = element('span'); span.style.color = token.match(/color:([^";]+)/)[1];
        inline(value.slice(cursor, close.start), span, base + cursor, depth + 1); parent.append(span); cursor = pattern.lastIndex = close.end;
      } else if (/^!?\[\[/.test(token)) {
        const image = token.startsWith('!'), content = token.slice(image ? 3 : 2, -2), [file, label] = content.split(/(?<!\\)\|/);
        if (image && /\.(png|jpe?g|webp|gif)$/i.test(file)) {
          const img = element('img'); img.alt = label || file; img.loading = 'lazy'; parent.append(img); loadAsset(file, img);
        } else { const link = element('a', 'wiki-link'); link.href = noteURL(file); text(link, label || file, start, end, true); parent.append(link); }
      } else if (/^!?\[/.test(token)) {
        const link = token.match(/^(!?)\[([^\]]*)\]\(([^)]+)\)$/), [, image, label, url] = link;
        if (image) text(parent, `图片：${label || url}`, start, end, true);
        else if (/^(https?:\/\/|obsidian:\/\/)/i.test(url)) { const a = element('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; text(a, label || url, start, end, true); parent.append(a); }
        else text(parent, token, start);
      } else if (token.startsWith('**')) { const strong = element('strong'); inline(token.slice(2, -2), strong, start + 2, depth + 1); parent.append(strong); }
      else if (token.startsWith('`')) { const code = element('code'); text(code, token.slice(1, -1), start, end, true); parent.append(code); }
      else if (token.startsWith('\\')) text(parent, token.slice(1), start, end, true);
      else text(parent, token, start, end, true);
    }
    text(parent, value.slice(cursor), base + cursor);
  }
  function cells(raw) {
    const parts = []; let start = 0, ticks = false;
    for (let i = 0; i <= raw.length; i++) {
      if (raw[i] === '`' && raw[i - 1] !== '\\') ticks = !ticks;
      if (i === raw.length || (raw[i] === '|' && raw[i - 1] !== '\\' && !ticks)) { const value = raw.slice(start, i); parts.push({ value: value.trim(), offset: start + value.length - value.trimStart().length }); start = i + 1; }
    }
    if (raw.trimStart().startsWith('|') && !parts[0].value) parts.shift();
    if (raw.trimEnd().endsWith('|') && !parts.at(-1).value) parts.pop();
    return parts;
  }
  function render(value, target) {
    if (documents.get(target) === value && target.childNodes.length) return;
    documents.set(target, value); target.replaceChildren();
    let offset = 0;
    const lines = value.split('\n').map(raw => { const line = { raw, start: offset, end: offset + raw.length }; offset += raw.length + 1; return line; });
    let paragraph = [], lists = [], code = null, fence = null;
    function flush() { if (!paragraph.length) return; const p = block(element('p'), paragraph[0].start, paragraph.at(-1).end); inline(paragraph.map(x => x.raw).join('\n'), p, paragraph[0].start); target.append(p); paragraph = []; }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], raw = line.raw, trimmed = raw.trim();
      if (code) {
        code.dataset.mdEnd = line.end;
        if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(trimmed)) { code = null; fence = null; }
        else text(code, raw + (i < lines.length - 1 ? '\n' : ''), line.start);
        continue;
      }
      const opening = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
      if (opening) { flush(); lists = []; code = block(element('pre'), line.start, line.end); code.dataset.mdCode = 'true'; fence = opening[1]; target.append(code); continue; }
      if (!trimmed) { flush(); lists = []; continue; }
      const separator = lines[i + 1] && cells(lines[i + 1].raw);
      if (raw.includes('|') && separator?.length && separator.every(x => /^:?-{3,}:?$/.test(x.value))) {
        flush(); lists = [];
        const rows = [{ line, cells: cells(raw) }]; let last = lines[i + 1]; i++;
        while (lines[i + 1]?.raw.trim() && lines[i + 1].raw.includes('|')) { last = lines[++i]; rows.push({ line: last, cells: cells(last.raw) }); }
        const width = Math.max(...rows.map(row => row.cells.length)), table = block(element('table'), line.start, last.end), head = element('thead'), body = element('tbody');
        rows.forEach((row, index) => {
          const tr = element('tr');
          for (let column = 0; column < width; column++) {
            const cell = row.cells[column], td = element(index ? 'td' : 'th');
            if (cell) inline(cell.value, td, row.line.start + cell.offset);
            else if (!index) td.append(document.createTextNode('（缺少表头）'));
            const align = separator[column]?.value; if (align?.startsWith(':') && align.endsWith(':')) td.style.textAlign = 'center'; else if (align?.endsWith(':')) td.style.textAlign = 'right';
            tr.append(td);
          }
          (index ? body : head).append(tr);
        });
        table.append(head, body); const wrap = element('div', 'table-scroll'); wrap.append(table); target.append(wrap); continue;
      }
      const heading = raw.match(/^\s*(#{1,6})\s+(.+)$/);
      if (heading) { flush(); lists = []; const h = block(element(`h${heading[1].length}`), line.start, line.end); inline(heading[2], h, line.start + raw.indexOf(heading[2], raw.indexOf('#') + heading[1].length)); target.append(h); continue; }
      const item = raw.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
      if (item) {
        flush(); const desired = Math.min(12, Math.floor(item[1].replace(/\t/g, '  ').length / 2));
        while (lists.length > desired + 1) lists.pop();
        while (lists.length < desired + 1) { const ul = element('ul'), parent = lists.at(-1); if (parent) { let li = parent.lastElementChild; if (!li) { li = element('li'); parent.append(li); } li.append(ul); } else target.append(ul); lists.push(ul); }
        for (const ul of lists.slice(0, -1)) if (ul.lastElementChild) ul.lastElementChild.dataset.mdEnd = line.end;
        const li = block(element('li'), line.start, line.end); inline(item[2], li, line.end - item[2].length); lists.at(-1).append(li); continue;
      }
      lists = [];
      if (trimmed.startsWith('>')) { flush(); const quote = block(element('blockquote'), line.start, line.end), content = raw.replace(/^\s*>\s?/, ''); inline(content, quote, line.end - content.length); target.append(quote); continue; }
      if (/^---+$/.test(trimmed)) { flush(); target.append(block(element('hr'), line.start, line.end)); continue; }
      paragraph.push(line);
    }
    flush();
  }
  function readSelection(root, range = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null) {
    if (!range || range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const source = documents.get(root); if (source == null) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), segments = [], blocks = []; let node, code = false;
    while ((node = walker.nextNode())) {
      const position = positions.get(node); if (!position || !range.intersectsNode(node)) continue;
      const from = range.startContainer === node ? range.startOffset : 0, to = range.endContainer === node ? range.endOffset : node.length;
      if (to <= from) continue;
      const start = position.atomic ? from === node.length ? position.end : position.start : position.start + from;
      const end = position.atomic ? to === 0 ? position.start : position.end : position.start + to;
      if (end <= start) continue;
      segments.push({ start, end, text: source.slice(start, end) });
      const parent = node.parentElement.closest('[data-md-start]'); if (parent) blocks.push(parent);
      code ||= !!node.parentElement.closest('[data-md-code]');
    }
    if (!segments.length) return null;
    const start = Math.min(...segments.map(x => x.start)), end = Math.max(...segments.map(x => x.end));
    return { start, end, text: source.slice(start, end), segments, code, block: blocks.length ? { start: Math.min(...blocks.map(x => Number(x.dataset.mdStart))), end: Math.max(...blocks.map(x => Number(x.dataset.mdEnd))) } : { start, end } };
  }
  function blockAt(root, target) {
    const node = target.closest('[data-md-start]');
    if (!node || !root.contains(node)) return null;
    const start = Number(node.dataset.mdStart), end = Number(node.dataset.mdEnd);
    return { start, end, text: documents.get(root).slice(start, end) };
  }
  return { render, readSelection, blockAt };
}
