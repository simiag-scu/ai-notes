import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../server/index.mjs';
import { validateOutline } from '../core/format.mjs';
import http from 'node:http';

// fetch overwrites Sec-Fetch-Mode with "cors". Send browser metadata unchanged
// when checking navigation policy; a real browser regression covers the redirect.
function navigationGet(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    }).on('error', reject);
  });
}

async function fixture(t, override) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'shiye-test-'));
  const memory = new Map(); const secrets = { kind: '隔离测试凭据', get: async key => memory.get(key), set: async (key, value) => memory.set(key, value), remove: async key => memory.delete(key) };
  const model = override || { generate: async (instructions, input) => ({ blocks: [{ heading: '整理结果', content: '保留本次材料的条件与结论。', children: [], sourceIds: input.messages?.map(x => x.id) || [] }], usage: { input: 100, output: 40, cached: 0, estimated: false } }) };
  const app = await createApplication({ root: path.join(vault, 'ai-study-notes'), vault, port: 0, testSecrets: secrets, modelOverride: model });
  t.after(async () => { await app.close(); await fs.rm(vault, { recursive: true, force: true }); });
  const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(app.baseURL + route, { method, headers: { Authorization: `Bearer ${app.config.bridgeToken}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  async function idle() { for (let i = 0; i < 100; i++) { const result = await api('/api/state'); if (!result.data.jobs.length) return; await delay(10); } throw new Error('job timeout'); }
  return { ...app, api, idle, vault };
}
test('本地接口拒绝缺少授权、恶意来源与越界路径', async t => {
  const app = await fixture(t);
  assert.equal((await fetch(app.baseURL + '/api/state')).status, 401);
  assert.equal((await fetch(app.baseURL + '/api/health', { headers: { Origin: 'https://malicious.example' } })).status, 403);
  assert.equal((await app.api('/api/notes', { title: 'escape', existingPath: '../outside.md' })).status, 400);
  assert.equal((await app.api('/api/notes', { title: 'secret', existingPath: '.obsidian/config.md' })).status, 400);
  const settings = await app.api('/api/settings', { outputFolder: 'ok/../../outside' }); assert.equal(settings.status, 400);
});
test('允许授权后的跨站顶层返回，继续拒绝 iframe、子资源和跨站 API', async t => {
  const app = await fixture(t);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  for (const route of ['/?authFailed=1', '/?connected=1']) {
    const response = await navigationGet(app.baseURL + route, navigation);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  }
  for (const destination of ['iframe', 'image', 'empty']) assert.equal((await navigationGet(app.baseURL + '/?authFailed=1', { ...navigation, 'Sec-Fetch-Dest': destination })).status, 403);
  assert.equal((await navigationGet(app.baseURL + '/api/state', navigation)).status, 401);
  assert.equal((await navigationGet(app.baseURL + '/api/state', { ...navigation, Origin: 'https://evil.example', Authorization: `Bearer ${app.config.bridgeToken}` })).status, 403);
});
test('回调失败后可正常打开工作台并读取脱敏错误，原始回调参数不进入状态', async t => {
  const app = await fixture(t);
  const response = await fetch(app.baseURL + '/auth/callback?error=access_denied&state=secret-state&code=secret-code&error_description=secret-provider-body', { redirect: 'manual' });
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/?authFailed=1');
  const state = (await app.api('/api/state')).data;
  assert.equal(state.account.lastError.code, 'request_expired'); assert.match(state.account.lastError.message, /重新连接/);
  assert.doesNotMatch(JSON.stringify(state), /secret-state|secret-code|secret-provider-body/);
  const returned = await navigationGet(app.baseURL + response.headers.get('location'), { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
  assert.equal(returned.status, 200);
});
test('原文摘录直接进入真实文件；重复采集不会重复加入', async t => {
  const app = await fixture(t);
  const created = await app.api('/api/notes', { title: '课程一', mode: 'markdown' }); const id = created.data.id;
  const payload = { noteId: id, text: '原文与 [[另一篇笔记]]。', manual: true, url: 'https://chatgpt.com/c/test' };
  assert.equal((await app.api('/api/capture', payload)).status, 200); await app.api('/api/capture', payload);
  assert.equal((await app.api('/api/capture', { ...payload, url: 'https://chatgpt.com/c/other' })).status, 200);
  const detail = (await app.api(`/api/notes/${id}`)).data;
  assert.equal(detail.text.split('原文与').length - 1, 1); assert.match(detail.text, /\[\[另一篇笔记\]\]/);
  assert.equal(await fs.readFile(path.join(app.vault, created.data.path), 'utf8'), detail.text);
  assert.equal((await app.api('/api/state')).data.usage.calls, 0);
});
test('AI 草稿、批量采纳、版本冲突与撤销完整流程', async t => {
  const app = await fixture(t); const id = (await app.api('/api/notes', { title: '草稿流程' })).data.id;
  await app.api('/api/capture', { noteId: id, text: '学习材料，包含条件与例外。', manual: false, externalId: 'm1' });
  assert.equal((await app.api(`/api/notes/${id}/summarize`, {})).status, 202); await app.idle();
  const detail = (await app.api(`/api/notes/${id}`)).data; assert.equal(detail.drafts.length, 1); assert.doesNotMatch(detail.text, /整理结果/);
  const accepted = await app.api(`/api/notes/${id}/accept`, { ids: [detail.drafts[0].id], expectedHash: detail.hash }); assert.equal(accepted.status, 200); assert.match(accepted.data.text, /整理结果/);
  assert.equal((await app.api(`/api/notes/${id}/undo`, {})).status, 200);
  const restored = (await app.api(`/api/notes/${id}`)).data; assert.equal(restored.drafts[0].status, 'pending');
  const filename = path.join(app.vault, restored.path); await fs.appendFile(filename, '\n人工修改不能被覆盖。\n');
  assert.equal((await app.api(`/api/notes/${id}/accept`, { ids: [detail.drafts[0].id], expectedHash: restored.hash })).status, 409);
  assert.match(await fs.readFile(filename, 'utf8'), /人工修改不能被覆盖/);
});
test('忽略草稿后不重新加入；模型响应来源必须真实', async t => {
  let invalid = false;
  const model = { generate: async (instructions, input) => ({ blocks: [{ heading: '已忽略的要点', content: '同样内容', children: [], sourceIds: invalid ? ['invented'] : input.messages.map(x => x.id) }], usage: { input: 100, output: 30, cached: 0 } }) };
  const app = await fixture(t, model); const id = (await app.api('/api/notes', { title: '排除' })).data.id;
  for (let index = 0; index < 2; index++) { await app.api('/api/capture', { noteId: id, text: `材料${index}`, externalId: `m${index}` }); await app.api(`/api/notes/${id}/summarize`, {}); await app.idle(); if (index === 0) { const detail = (await app.api(`/api/notes/${id}`)).data; await app.api(`/api/notes/${id}/reject`, { ids: [detail.drafts[0].id] }); } }
  let detail = (await app.api(`/api/notes/${id}`)).data; assert.equal(detail.drafts.filter(x => x.status === 'pending').length, 0);
  invalid = true; await app.api('/api/capture', { noteId: id, text: '第三条', externalId: 'm3' }); await app.api(`/api/notes/${id}/summarize`, {}); await app.idle();
  detail = (await app.api(`/api/notes/${id}`)).data; assert.equal(detail.drafts.length, 1);
});
test('双模式 AI 转换另存，并补回缺失的原始引用', async t => {
  const app = await fixture(t); const id = (await app.api('/api/notes', { title: '转换章节' })).data.id;
  await app.api('/api/capture', { noteId: id, text: '公式 $a=b$ 与 [[知识点]]，![[示意.png]]', manual: true });
  const original = (await app.api(`/api/notes/${id}`)).data;
  assert.equal((await app.api(`/api/notes/${id}/convert`, { mode: 'outline' })).status, 202); await app.idle();
  const state = (await app.api('/api/state')).data; assert.equal(state.notes.length, 2);
  const converted = (await app.api(`/api/notes/${state.notes.find(x => x.id !== id).id}`)).data;
  assert.ok(validateOutline(converted.text)); for (const text of ['$a=b$', '[[知识点]]', '![[示意.png]]']) assert.ok(converted.text.includes(text));
  assert.equal((await app.api(`/api/notes/${id}`)).data.text, original.text);
  await app.api(`/api/notes/${converted.id}/convert`, { mode: 'markdown' }); await app.idle(); assert.equal((await app.api('/api/state')).data.notes.length, 3);
});
test('大纲追加与图片保存都保持格式，拒绝伪装图片', async t => {
  const app = await fixture(t); const id = (await app.api('/api/notes', { title: '图文大纲', mode: 'outline' })).data.id;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1cAAAAASUVORK5CYII=';
  assert.equal((await app.api('/api/capture', { noteId: id, manual: true, text: '图片说明', imageDataURL: png })).status, 200);
  const detail = (await app.api(`/api/notes/${id}`)).data; assert.ok(validateOutline(detail.text)); assert.match(detail.text, /!\[\[.*_attachments.*\.png\]\]/);
  assert.equal((await app.api('/api/capture', { noteId: id, manual: true, imageDataURL: 'data:image/png;base64,PGh0bWw+' })).status, 400);
});
test('笔记更新检测并拒绝符号链接输出', async t => {
  const app = await fixture(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'shiye-outside-')); t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(app.vault, 'linked'));
  assert.equal((await app.api('/api/settings', { outputFolder: 'linked' })).status, 400);
});
test('原生连接中断时阻止写入，显式切回本地模式后才恢复', async t => {
  const app = await fixture(t); const note = (await app.api('/api/notes', { title: '连接保护' })).data;
  const filename = path.join(app.vault, note.path); const original = await fs.readFile(filename, 'utf8');
  app.store.bridge = async () => { throw new Error('连接关闭'); };
  assert.equal((await app.api(`/api/notes/${note.id}`)).status, 503);
  assert.equal((await app.api(`/api/notes/${note.id}`, { text: '不能覆盖', expectedHash: 'wrong' }, 'PUT')).status, 503);
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  await app.api('/api/obsidian/disconnect', {});
  assert.equal((await app.api(`/api/notes/${note.id}`)).status, 200);
});
test('失败的 AI 请求也计入频率限制，避免错误后无限重试', async t => {
  let calls = 0; const app = await fixture(t, { generate: async () => { calls++; throw new Error('合成网络错误'); } });
  const note = (await app.api('/api/notes', { title: '失败预算保护' })).data;
  await app.api('/api/settings', { callsPerHour: 1 });
  await app.api('/api/capture', { noteId: note.id, text: '需要整理的材料', manual: false });
  await app.api(`/api/notes/${note.id}/summarize`, {}); await app.idle();
  await app.api(`/api/notes/${note.id}/summarize`, {}); await app.idle();
  assert.equal(calls, 1); const state = (await app.api('/api/state')).data;
  assert.equal(state.usage.calls, 1); assert.equal(state.usage.estimated, true);
  assert.equal((await app.api(`/api/notes/${note.id}`)).data.drafts.length, 0);
});
