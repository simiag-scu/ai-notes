import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../server/index.mjs';
import { validateOutline } from '../core/format.mjs';
import { prepareEdit, colorize } from '../core/edits.mjs';
import { stripColorSpans } from '../web/markdown.js';

async function fixture(t, handler = async (instructions, input) => input.at(-1).content) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'shiye-edit-')), memory = new Map(), calls = [];
  const app = await createApplication({ root: path.join(vault, 'ai-study-notes'), vault, port: 0, testSecrets: { get: async key => memory.get(key), set: async (key, value) => memory.set(key, value), remove: async key => memory.delete(key) }, modelOverride: { chat: async (instructions, input, signal) => { calls.push({ instructions, input }); return { text: await handler(instructions, input, signal), usage: { input: 100, output: 40, cached: 0, estimated: false } }; } } });
  t.after(async () => { await app.close(); await fs.rm(vault, { recursive: true, force: true }); });
  const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(app.baseURL + route, { method, headers: { Authorization: `Bearer ${app.config.bridgeToken}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { statusCode: response.status, ...await response.json() };
  };
  await api('/api/settings', { model: 'synthetic' });
  const wait = async id => { for (let i = 0; i < 120; i++) { const result = await api(`/api/edits/${id}`); if (result.status !== 'running') return result; await delay(10); } throw new Error('edit timeout'); };
  return { ...app, vault, api, wait, calls };
}
async function seedChat(app, text) {
  const chat = await app.api('/api/chats', {});
  await app.store.transact(() => app.chats.get(chat.id).messages.push({ id: 'answer', role: 'assistant', text, status: 'completed' }));
  return chat.id;
}

test('颜色按准确位置保存，重复文本和表格标记保持，支持撤销且不调用 AI', async t => {
  const app = await fixture(t), note = await app.api('/api/notes', { title: '颜色与表格', content: '# 颜色\n\n相同词 与 相同词\n\n| 项目 | 内容 |\n| --- | --- |\n| A | 数值 |\n' });
  const before = await app.api(`/api/notes/${note.id}`), start = before.text.lastIndexOf('相同词');
  const payload = { color: '#b4473d', expectedHash: before.hash, segments: [{ start, end: start + 3, text: '相同词' }] };
  assert.equal((await app.api(`/api/notes/${note.id}/color`, payload)).statusCode, 200);
  const after = await app.api(`/api/notes/${note.id}`); assert.match(after.text, /相同词 与 <span style="color:#b4473d">相同词<\/span>/); assert.ok(after.text.includes('| A | 数值 |'));
  assert.equal((await app.api(`/api/notes/${note.id}/color`, payload)).statusCode, 409);
  await app.api(`/api/notes/${note.id}/undo`, {}); assert.equal((await app.api(`/api/notes/${note.id}`)).text, before.text);
  assert.equal(app.calls.length, 0); assert.equal((await app.api('/api/state')).usage.calls, 0);
  assert.throws(() => colorize('原文', [{ start: 0, end: 2, text: '原文' }], 'red;position:fixed'), /菜单/);
});

test('左侧 AI 仅处理选区，预览后幂等加入，来源保留原始消息', async t => {
  const app = await fixture(t, async (instructions, input) => `## 排版结果\n\n${input.at(-1).content}`), note = await app.api('/api/notes', { title: '笔记隐私不发送' });
  const source = '不应发送的前缀。选中内容与 [[链接]]。不应发送的后缀。', original = '选中内容与 [[链接]]。', start = source.indexOf(original), conversationId = await seedChat(app, source);
  const request = { origin: 'chat', operation: 'format', noteId: note.id, conversationId, messageId: 'answer', start, end: start + original.length, text: original };
  const created = await app.api('/api/edits', request); assert.equal(created.statusCode, 202);
  const ready = await app.wait(created.id); assert.equal(ready.status, 'ready'); assert.equal(app.calls[0].input[0].content, original); assert.doesNotMatch(JSON.stringify(app.calls), /不应发送|笔记隐私/);
  assert.doesNotMatch((await app.api(`/api/notes/${note.id}`)).text, /排版结果/);
  assert.equal((await app.api(`/api/edits/${created.id}/apply`, { text: ready.text })).statusCode, 200);
  assert.equal((await app.api(`/api/edits/${created.id}/apply`, { text: ready.text })).duplicate, true);
  const after = await app.api(`/api/notes/${note.id}`); assert.equal(after.text.split('排版结果').length - 1, 1); assert.equal(after.sources[0].text, original); assert.equal(after.sources[0].conversationId, conversationId);
  const forged = await app.api('/api/edits', { ...request, text: '伪造选区' }); assert.equal(forged.statusCode, 400);
});

test('右侧 AI 只替换指定段落，外部修改时拒绝覆盖', async t => {
  const app = await fixture(t, async () => '修复后的第二段'), note = await app.api('/api/notes', { title: '局部替换', content: '# 标题\n\n重复段落\n\n重复段落\n\n结尾保留\n' });
  let current = await app.api(`/api/notes/${note.id}`); const start = current.text.lastIndexOf('重复段落');
  const data = { noteId: note.id, origin: 'note', operation: 'format', expectedHash: current.hash, start, end: start + 4, text: '重复段落' };
  let edit = await app.api('/api/edits', data), ready = await app.wait(edit.id); assert.equal(ready.status, 'ready');
  await app.api(`/api/edits/${edit.id}/apply`, { text: ready.text }); current = await app.api(`/api/notes/${note.id}`);
  assert.equal(current.text, '# 标题\n\n重复段落\n\n修复后的第二段\n\n结尾保留\n');
  const second = { ...data, expectedHash: current.hash, start: current.text.indexOf('重复段落'), end: current.text.indexOf('重复段落') + 4 };
  edit = await app.api('/api/edits', second); ready = await app.wait(edit.id);
  await fs.appendFile(path.join(app.vault, note.path), '\n外部人工编辑\n');
  assert.equal((await app.api(`/api/edits/${edit.id}/apply`, { text: ready.text })).statusCode, 409);
  assert.match((await app.api(`/api/notes/${note.id}`)).text, /外部人工编辑/);
});

test('大纲局部重排保留层级，AI 精简可加入大纲并保留别名链接和公式', async t => {
  const app = await fixture(t, async (instructions, input) => instructions.includes('精简重复') ? '精简：[[知识|别名]] 与 $a=b$' : '- 修改后的节点\n  - 适用条件'), note = await app.api('/api/notes', { title: '层级', mode: 'outline', content: '- 根\n  - 原节点\n    - 原条件\n  - 邻居\n' });
  const current = await app.api(`/api/notes/${note.id}`), original = '  - 原节点\n    - 原条件', start = current.text.indexOf(original);
  let edit = await app.api('/api/edits', { noteId: note.id, origin: 'note', operation: 'format', start, end: start + original.length, text: original, expectedHash: current.hash }); let ready = await app.wait(edit.id);
  assert.equal(ready.text, '  - 修改后的节点\n    - 适用条件'); await app.api(`/api/edits/${edit.id}/apply`, { text: ready.text });
  assert.equal((await app.api(`/api/notes/${note.id}`)).text, '- 根\n  - 修改后的节点\n    - 适用条件\n  - 邻居\n');
  const source = '原文 [[知识|别名]] 与 $a=b$', conversationId = await seedChat(app, source);
  edit = await app.api('/api/edits', { noteId: note.id, origin: 'chat', operation: 'simplify', conversationId, messageId: 'answer', start: 0, end: source.length, text: source }); ready = await app.wait(edit.id);
  assert.equal(ready.status, 'ready'); await app.api(`/api/edits/${edit.id}/apply`, { text: ready.text });
  const result = await app.api(`/api/notes/${note.id}`); assert.ok(validateOutline(result.text)); assert.ok(result.text.includes('[[知识|别名]]')); assert.ok(result.text.includes('$a=b$'));
});

test('取消、遗漏引用、预算不足和无效颜色均不会改写笔记', async t => {
  let slow = true;
  const app = await fixture(t, async (instructions, input, signal) => { if (slow) await delay(5000, undefined, { signal }); return '遗漏引用的结果'; }), note = await app.api('/api/notes', { title: '保留', content: '# 保留\n\n[[链接]] 与公式 $x=y$\n' });
  const current = await app.api(`/api/notes/${note.id}`), data = { noteId: note.id, origin: 'note', operation: 'format', expectedHash: current.hash, start: 0, end: current.text.length, text: current.text };
  let edit = await app.api('/api/edits', data); await app.api(`/api/edits/${edit.id}/stop`, {}); assert.equal((await app.wait(edit.id)).status, 'cancelled');
  slow = false; edit = await app.api('/api/edits', data); assert.equal((await app.wait(edit.id)).status, 'failed');
  assert.equal((await app.api(`/api/notes/${note.id}`)).text, current.text);
  assert.equal((await app.api(`/api/notes/${note.id}/color`, { expectedHash: current.hash, color: 'javascript:bad', segments: [{ start: 0, end: 1, text: '#' }] })).statusCode, 400);
  assert.throws(() => prepareEdit('无引用', { original: '[[链接]]', mode: 'markdown', origin: 'note' }), /遗漏/);
  await app.api('/api/settings', { contextBudget: 1000 });
  const long = await app.api('/api/notes', { title: '预算', content: '超长资料'.repeat(1000) }), large = await app.api(`/api/notes/${long.id}`), beforeCalls = app.calls.length;
  assert.equal((await app.api('/api/edits', { noteId: long.id, origin: 'note', operation: 'format', text: large.text, start: 0, end: large.text.length, expectedHash: large.hash })).statusCode, 400);
  assert.equal(app.calls.length, beforeCalls);
});

test('复制到幕布去除嵌套颜色，保留大纲层级、链接和其他 span', () => {
  const source = '- 根\n  - <span style="color:#b4473d">重点 <span style="color:var(--text-normal)">[[知识|别名]]</span></span>\n  - <span class="other">保留</span>\n';
  assert.equal(stripColorSpans(source), '- 根\n  - 重点 [[知识|别名]]\n  - <span class="other">保留</span>\n');
});
