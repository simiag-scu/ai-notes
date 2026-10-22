import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../server/index.mjs';
import { chatContext } from '../server/chat.mjs';
import { ModelClient, readDeepSeek } from '../server/model.mjs';
import { upstreamError } from '../server/upstream-errors.mjs';

const usage = { input: 80, output: 40, cached: 10, estimated: false };
async function fixture(t, chat) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'shiye-chat-'));
  const root = path.join(vault, 'ai-study-notes'), memory = new Map();
  const app = await createApplication({ root, vault, port: 0, testSecrets: { get: async key => memory.get(key), set: async (key, value) => memory.set(key, value), remove: async key => memory.delete(key) }, modelOverride: { chat } });
  t.after(async () => { await app.close(); await fs.rm(vault, { recursive: true, force: true }); });
  const api = async (route, data) => {
    const response = await fetch(app.baseURL + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${app.config.bridgeToken}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, ...await response.json() };
  };
  await api('/api/settings', { model: 'synthetic-test' });
  const conversation = await api('/api/chats', {});
  const wait = async () => { for (let i = 0; i < 150; i++) { if (!app.chats.jobs.size) return; await delay(10); } throw new Error('chat timeout'); };
  return { ...app, api, conversation, wait, root, vault };
}

test('聊天上下文只携带完整最近轮次，超预算明确拒绝，不剪断问题', () => {
  const messages = [];
  for (let i = 0; i < 10; i++) messages.push({ role: 'user', text: `问题${i}${'学'.repeat(200)}` }, { role: 'assistant', text: `回答${i}${'习'.repeat(200)}`, status: 'completed' });
  messages.push({ role: 'user', text: '失败问题' }, { role: 'assistant', text: '未完回答', status: 'failed' });
  const context = chatContext(messages, '新的问题', 1600);
  assert.ok(context.omittedTurns > 0); assert.equal(context.messages.at(-1).content, '新的问题');
  assert.ok(context.messages.some(x => x.content.startsWith('问题9'))); assert.ok(!JSON.stringify(context).includes('失败问题'));
  assert.throws(() => chatContext([], '超长问题'.repeat(3000), 1000), /超过上下文预算/);
});

test('ChatGPT 与 DeepSeek 发送多轮消息，流式解析并返回真实 usage', async t => {
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  const frames = values => new Response(values.map(x => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`).join(''));
  const messages = [{ role: 'user', content: '一问' }, { role: 'assistant', content: '一答' }, { role: 'user', content: '再问' }];
  let payload, endpoint;
  globalThis.fetch = async (url, options) => { endpoint = url; payload = JSON.parse(options.body); return frames([{ type: 'response.output_text.delta', delta: '答案' }, { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 4 } } }]); };
  const client = new ModelClient({ auth: { accessToken: async () => 'synthetic' }, secrets: { get: async () => ({ key: 'synthetic' }) }, settings: { provider: 'chatgpt', model: 'test' } });
  const deltas = []; const result = await client.chat('学习助手', messages, undefined, (length, delta) => deltas.push(delta));
  assert.match(endpoint, /responses$/); assert.deepEqual(payload.input, messages); assert.equal(payload.store, false); assert.equal(payload.stream, true); assert.equal(payload.instructions, '学习助手'); assert.ok(!('max_output_tokens' in payload));
  assert.equal(result.text, '答案'); assert.deepEqual(deltas, ['答案']); assert.equal(result.usage.input, 10);
  globalThis.fetch = async (url, options) => { endpoint = url; payload = JSON.parse(options.body); return frames([{ choices: [{ delta: { reasoning_content: '不进入笔记的内部思考' } }] }, { choices: [{ delta: { content: 'DeepSeek回答' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 15, completion_tokens: 8, prompt_cache_hit_tokens: 3 } }, '[DONE]']); };
  client.settings = { provider: 'deepseek', model: 'deepseek-flash' };
  const ds = await client.chat('学习助手', messages);
  assert.match(endpoint, /deepseek.*completions$/); assert.deepEqual(payload.messages.slice(1), messages); assert.equal(payload.thinking.type, 'disabled'); assert.equal(ds.text, 'DeepSeek回答'); assert.equal(ds.usage.cached, 3);
});

test('DeepSeek 流跨字节边界正常解析，截断和长度结束不当作成功', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"汉字"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  async function* split() { for (const byte of bytes) yield new Uint8Array([byte]); }
  assert.equal((await readDeepSeek(split())).text, '汉字');
  async function* short() { yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"不完整"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'); }
  await assert.rejects(readDeepSeek(short()), /长度限制/);
});

test('流式聊天、并发重复请求去重、绑定笔记来源、多轮续聊及持久保存', async t => {
  let calls = 0, seen, release, started;
  const gate = new Promise(resolve => release = resolve);
  const streaming = new Promise(resolve => started = resolve);
  const app = await fixture(t, async (instructions, messages, signal, onDelta) => {
    calls++; seen = messages; onDelta(2, '你好'); started();
    if (calls === 1) await new Promise((resolve, reject) => { const stop = () => reject(new Error('stopped')); signal.addEventListener('abort', stop, { once: true }); gate.then(() => { signal.removeEventListener('abort', stop); resolve(); }); });
    return { text: '你好，学习回答', usage };
  });
  const note = await app.api('/api/notes', { title: '独立笔记秘密，不该发送到聊天' });
  const url = `/api/chats/${app.conversation.id}`, payload = { text: '解释一个概念', requestId: 'first-request', noteId: note.id };
  const replies = await Promise.all([app.api(url + '/send', payload), app.api(url + '/send', payload)]);
  assert.equal(replies[0].messageId, replies[1].messageId);
  await streaming;
  const during = await app.api(url); assert.equal(during.running, true); assert.equal(during.messages.at(-1).text, '你好');
  assert.equal((await app.api(url + '/send', { ...payload, requestId: 'second-request' })).status, 409);
  release(); await app.wait(); assert.equal(calls, 1);
  const detail = await app.api(`/api/notes/${note.id}`); assert.equal(detail.sources.length, 2); assert.equal(detail.sources[1].conversationId, app.conversation.id); assert.doesNotMatch(detail.text, /学习回答/);
  assert.equal((await app.api(url + '/collect', { noteId: note.id })).count, 0);
  await app.api(url + '/send', { text: '接着解释', requestId: 'third-request', noteId: note.id }); await app.wait();
  assert.deepEqual(seen.map(x => x.role), ['user', 'assistant', 'user']); assert.ok(!JSON.stringify(seen).includes('秘密'));
  const saved = JSON.parse(await fs.readFile(path.join(app.root, '.data/state.json'), 'utf8'));
  assert.equal(saved.chats[0].messages.length, 4); assert.equal(saved.chats[0].messages.at(-1).status, 'completed');
  assert.equal((await app.api('/api/state')).usage.calls, 2);
});

test('停止和失败保留部分回答，不加入整理；重试不重复用户问题，额度限制共用', async t => {
  let calls = 0;
  const app = await fixture(t, async (instructions, messages, signal, onDelta) => {
    calls++; onDelta(4, '部分回答');
    if (calls === 1) await delay(10000, undefined, { signal });
    if (calls === 2) throw new Error('合成网络失败');
    return { text: '完整回答', usage };
  });
  const note = await app.api('/api/notes', { title: '停止保护' }), url = `/api/chats/${app.conversation.id}`;
  await app.api(url + '/send', { text: '要停止的提问', requestId: 'stop-request', noteId: note.id });
  await delay(20); await app.api(url + '/stop', {}); await app.wait();
  let chat = await app.api(url); assert.equal(chat.messages.at(-1).status, 'stopped'); assert.equal(chat.messages.at(-1).text, '部分回答');
  assert.equal((await app.api(`/api/notes/${note.id}`)).sources.length, 0);
  await app.api(url + '/send', { retry: true, requestId: 'retry-request', noteId: note.id }); await app.wait();
  chat = await app.api(url); assert.equal(chat.messages.length, 2); assert.equal(chat.messages.at(-1).status, 'failed');
  await app.api(url + '/send', { retry: true, requestId: 'final-request', noteId: note.id }); await app.wait();
  chat = await app.api(url); assert.equal(chat.messages.length, 2); assert.equal(chat.messages.at(-1).text, '完整回答');
  await app.api('/api/settings', { callsPerHour: 3 });
  await app.api(url + '/send', { text: '第四次应被限制', requestId: 'limit-request' }); await app.wait();
  assert.equal(calls, 3); assert.match((await app.api(url)).messages.at(-1).error, /每小时/);
});

test('服务重启后恢复未完成状态，允许重试并保留既有笔记', async t => {
  const app = await fixture(t, async () => ({ text: '完整回答', usage }));
  await app.store.transact(() => { app.store.state.chats[0].messages = [{ role: 'user', id: 'u1', text: '重启前的问题', status: 'completed' }, { role: 'assistant', id: 'a1', text: '', status: 'streaming' }]; });
  const { NoteStore } = await import('../server/store.mjs');
  const restored = await new NoteStore(app.root, app.vault).init();
  assert.equal(restored.state.chats[0].messages[1].status, 'interrupted');
});

test('聊天持久保存脱敏的网络原因，失败回答可重试且不写入笔记来源', async t => {
  const app = await fixture(t, async () => { throw upstreamError(new TypeError('fetch failed', { cause: Object.assign(new Error('private-node-password'), { code: 'UND_ERR_SOCKET' }) })); });
  const note = await app.api('/api/notes', { title: '连接保护' });
  await app.api(`/api/chats/${app.conversation.id}/send`, { text: '合成连接问题', requestId: 'network-test', noteId: note.id }); await app.wait();
  const result = await app.api(`/api/chats/${app.conversation.id}`), answer = result.messages.at(-1);
  assert.equal(answer.status, 'failed'); assert.equal(answer.diagnostic.code, 'UND_ERR_SOCKET'); assert.match(answer.error, /检查代理/); assert.doesNotMatch(JSON.stringify(result), /private-node-password|fetch failed/);
  assert.equal((await app.api(`/api/notes/${note.id}`)).sources.length, 0);
});
