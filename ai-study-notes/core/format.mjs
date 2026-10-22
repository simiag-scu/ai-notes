export const MODES = new Set(['markdown', 'outline']);
export const cleanTitle = value => String(value || '未命名笔记').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || '未命名笔记';
export const normalizeText = value => String(value || '').replace(/\r\n?/g, '\n').trim();
export function normalizeBlocks(blocks, depth = 0) {
  if (!Array.isArray(blocks) || depth > 10) throw new Error('笔记内容需要有效的结构化内容块');
  return blocks.slice(0, 150).map(block => {
    if (!block || typeof block !== 'object') throw new Error('无效的笔记内容块');
    const heading = normalizeText(block.heading).replace(/\n/g, ' ').slice(0, 240);
    const content = normalizeText(block.content).slice(0, 50000);
    const children = normalizeBlocks(block.children || [], depth + 1);
    if (!heading && !content && !children.length) throw new Error('内容块不能为空');
    return { heading, content, children, sourceIds: Array.isArray(block.sourceIds) ? [...new Set(block.sourceIds.filter(x => typeof x === 'string'))].slice(0, 30) : [] };
  });
}

// Only the serializer controls outline markers; a model cannot accidentally mix formats.
export function outlineContent(markdown) {
  const lines = normalizeText(markdown).split('\n');
  const result = [];
  let inCode = false, fence = '', headers = null;
  for (let index = 0; index < lines.length; index++) {
    let raw = lines[index];
    // A display formula remains one outline node; list markers must never enter TeX.
    if (!inCode && (raw.match(/\$\$/g) || []).length % 2) {
      while (index + 1 < lines.length) { raw += ' ' + lines[++index].trim(); if ((raw.match(/\$\$/g) || []).length % 2 === 0) break; }
    }
    const line = raw.trim();
    if (!line) { headers = null; continue; }
    const code = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (code) {
      if (!inCode) { inCode = true; fence = code[1][0]; result.push({ level: 0, text: `代码${code[2] ? `（${code[2].trim()}）` : ''}` }); }
      else if (code[1][0] === fence) inCode = false;
      continue;
    }
    if (inCode) { const ticks = '`'.repeat(Math.max(1, ...[...raw.matchAll(/`+/g)].map(m => m[0].length + 1))); result.push({ level: 1, text: `${ticks}${raw || ' '}${ticks}` }); continue; }
    const nextCells = lines[index + 1]?.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(x => x.trim());
    const tableRow = headers || (line.startsWith('|') && line.endsWith('|')) || (nextCells?.length > 1 && nextCells.every(x => /^:?-{3,}:?$/.test(x)));
    if (!line.includes('$$') && tableRow && line.includes('|')) {
      const cells = line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(x => x.trim());
      if (cells.every(x => /^:?-+:?$/.test(x))) continue;
      if (!headers) { headers = cells; result.push({ level: 0, text: '表格' }); continue; }
      result.push({ level: 1, text: cells.map((x, i) => `${headers[i] || `列${i + 1}`}：${x}`).join('；') }); continue;
    }
    headers = null;
    const item = raw.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)(.*)$/);
    if (item) { result.push({ level: Math.min(10, Math.floor(item[1].replace(/\t/g, '  ').length / 2)), text: item[2].trim() || '（空节点）' }); continue; }
    const text = line.replace(/^#{1,6}\s+/, '').replace(/^>\s*\[![^\]]+\][+-]?\s*/, '').replace(/^>\s*/, '').replace(/^---+$/, '');
    if (text) result.push({ level: 0, text });
  }
  return result;
}

export function serializeBlocks(blocks, mode, { title = '', includeTitle = false } = {}) {
  if (!MODES.has(mode)) throw new Error('未知笔记模式');
  const nodes = normalizeBlocks(blocks), result = [];
  if (includeTitle && title) result.push(mode === 'outline' ? `- ${cleanTitle(title)}` : `# ${cleanTitle(title)}`);
  const base = mode === 'outline' && includeTitle ? 1 : 0;
  function visit(node, depth) {
    if (mode === 'outline') {
      if (node.heading) result.push(`${'  '.repeat(depth)}- ${node.heading}`);
      const contentDepth = depth + (node.heading ? 1 : 0);
      let previous = -1;
      for (const line of outlineContent(node.content)) { const level = Math.max(0, Math.min(line.level, previous + 1)); result.push(`${'  '.repeat(contentDepth + level)}- ${line.text}`); previous = level; }
      node.children.forEach(x => visit(x, depth + (node.heading ? 1 : 0)));
    } else {
      if (node.heading) result.push(`${'#'.repeat(Math.min(depth + 2, 6))} ${node.heading}`);
      if (node.content) result.push(node.content);
      node.children.forEach(x => visit(x, depth + (node.heading ? 1 : 0)));
    }
  }
  nodes.forEach(x => visit(x, base));
  const text = result.join(mode === 'outline' ? '\n' : '\n\n').trim() + '\n';
  if (mode === 'outline') validateOutline(text);
  return text;
}

export function validateOutline(text) {
  let previous = -1;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^( *)(- )\S/);
    if (!match || match[1].length % 2) throw new Error('大纲必须逐行使用 - 节点和两个空格的层级缩进');
    const depth = match[1].length / 2;
    if ((previous < 0 && depth !== 0) || depth > previous + 1) throw new Error('大纲层级不能跳级');
    previous = depth;
  }
  return true;
}

export function extractReferences(text) {
  return [...new Set([...String(text).matchAll(/!?\[\[[^\]\n]+\]\]|!?\[[^\]\n]*\]\([^\n)]+\)|\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\n]+\$(?!\$)/g)].map(x => x[0]))];
}

export function parseModelBlocks(text) {
  const stripped = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(stripped); } catch { throw new Error('AI 返回的结构不完整，草稿未保存，请重试'); }
  const blocks = normalizeBlocks(Array.isArray(parsed) ? parsed : parsed.blocks);
  if (!blocks.length) throw new Error('AI 未返回笔记内容，草稿未保存，请重试');
  return blocks;
}

export function estimateTokens(text) {
  const value = String(text || ''), cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  return Math.ceil(cjk * 1.5 + (value.length - cjk) / 3.5);
}
