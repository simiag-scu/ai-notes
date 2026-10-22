import test from 'node:test';
import assert from 'node:assert/strict';
import { upstreamError } from '../server/upstream-errors.mjs';
import { ModelClient } from '../server/model.mjs';
import { NetworkManager } from '../server/network.mjs';

test('网络错误保留已知原因，嵌套及 AggregateError 可读，不暴露敏感异常正文', () => {
  const detail = Object.assign(new Error('private-token and private-node-url'), { code: 'ECONNREFUSED' });
  const error = upstreamError(new TypeError('fetch failed', { cause: new AggregateError([detail]) }));
  assert.match(error.message, /ChatGPT.*连接被拒绝.*ECONNREFUSED/);
  assert.deepEqual({ kind: error.diagnostic.kind, code: error.diagnostic.code, phase: error.diagnostic.phase }, { kind: 'network', code: 'ECONNREFUSED', phase: 'request' });
  assert.doesNotMatch(JSON.stringify(error), /private-token|private-node-url/);
  const timeout = upstreamError(new DOMException('private', 'TimeoutError'), { provider: 'deepseek', phase: 'stream' });
  assert.match(timeout.message, /DeepSeek 接收回答失败.*超时/);
  const abort = new DOMException('stop', 'AbortError'); assert.equal(upstreamError(abort), abort);
  const validation = new Error('模型 JSON 不合法'); assert.equal(upstreamError(validation), validation);
});

test('模型请求失败与流中断显示明确阶段，POST 不自动重发', async t => {
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  const client = new ModelClient({ auth: { accessToken: async () => 'synthetic-only' }, secrets: {}, settings: { provider: 'chatgpt', model: 'test' } });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed', { cause: Object.assign(new Error('private-details'), { code: 'ECONNRESET' }) }); };
  await assert.rejects(client.chat('学习', [{ role: 'user', content: '合成问题' }]), error => error.diagnostic.phase === 'request' && /网络连接被中断/.test(error.message));
  assert.equal(calls, 1);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"部分"}\n\n')); }, pull(controller) { controller.error(new TypeError('terminated', { cause: Object.assign(new Error('private-socket'), { code: 'UND_ERR_SOCKET' }) })); } }));
  await assert.rejects(client.chat('学习', [{ role: 'user', content: '合成问题' }]), error => error.diagnostic.phase === 'stream' && error.diagnostic.code === 'UND_ERR_SOCKET');
});

test('网络检查覆盖实际模型主机，按服务选择，不传凭据且不调用推理', async t => {
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push(url); assert.equal(options.headers.Authorization, undefined); assert.equal(options.method, undefined);
    return url.includes('/models') ? new Response('{"error":{"message":"Unauthorized"}}', { status: 401 }) : new Response(url.includes('jwks') ? '{"keys":[]}' : '{"issuer":"https://auth.openai.com"}');
  };
  const network = new NetworkManager('/unused');
  const openai = await network.check(); assert.equal(openai.ok, true); assert.equal(openai.results.length, 3); assert.ok(seen.includes('https://api.openai.com/v1/models'));
  seen.length = 0;
  const deepseek = await network.check({ provider: 'deepseek' }); assert.equal(deepseek.ok, true); assert.deepEqual(seen, ['https://api.deepseek.com/models']);
  globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('private-proxy-url'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); };
  const failed = await network.check(); assert.equal(failed.ok, false); assert.ok(failed.results.every(x => x.code === 'UND_ERR_CONNECT_TIMEOUT')); assert.doesNotMatch(JSON.stringify(failed), /private-proxy-url/);
});
