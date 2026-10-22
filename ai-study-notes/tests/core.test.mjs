import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { normalizeBlocks, serializeBlocks, validateOutline, extractReferences, parseModelBlocks } from '../core/format.mjs';
import { selectContext } from '../core/context.mjs';
import { validateIDToken } from '../server/security.mjs';
import { readResponses } from '../server/model.mjs';

test('双模式保留链接、公式、图像引用；大纲只含合法节点', () => {
  const blocks = [{ heading: '概念', content: '参见 [[章节#概念]]，公式 $a=b$。\n![[附件/示意图.png]]', children: [{ heading: '过程', content: '- 条件\n  - 结果', children: [], sourceIds: ['one'] }], sourceIds: ['one'] }];
  const normal = serializeBlocks(blocks, 'markdown', { title: '学习', includeTitle: true });
  const outline = serializeBlocks(blocks, 'outline', { title: '学习', includeTitle: true });
  assert.match(normal, /^# 学习/); assert.ok(validateOutline(outline));
  for (const reference of extractReferences(normal)) assert.ok(outline.includes(reference));
  assert.ok(outline.split('\n').every(line => !line || /^(?:  )*- \S/.test(line)));
});
test('表格和代码进入大纲时保留文字，纠正源列表跳级', () => {
  const text = serializeBlocks([{ heading: '例子', content: '| 名称 | 数值 |\n| --- | --- |\n| A | 3 |\n\n```js\nconst a = 3;\n```\n\n        - 深层节点', children: [] }], 'outline');
  assert.ok(validateOutline(text)); assert.match(text, /名称：A；数值：3/); assert.match(text, /const a = 3/); assert.match(text, /深层节点/);
  const equation = serializeBlocks([{ content: '$$\na=b+c\n$$', children: [] }], 'outline');
  assert.equal(equation.trim(), '- $$ a=b+c $$'); assert.ok(validateOutline(equation));
});
test('拒绝不符合大纲约束的文本和无效模型结构', () => {
  for (const input of ['# 标题', '- 根\n   - 三个空格', '- 根\n    - 跳级']) assert.throws(() => validateOutline(input));
  assert.throws(() => normalizeBlocks([{}])); assert.throws(() => parseModelBlocks('{unfinished'));
  assert.throws(() => parseModelBlocks('{"blocks":[]}'), /未返回/);
  assert.equal(parseModelBlocks('```json\n{"blocks":[{"heading":"概念","content":"内容","children":[]}]}\n```').length, 1);
});
test('上下文按待处理顺序推进，不反复发送完整原笔记', () => {
  const sources = Array.from({ length: 40 }, (_, i) => ({ id: String(i), text: `本次知识点${i}`, role: 'assistant' }));
  const note = { excluded: [] };
  const context = selectContext(note, sources, '# 无关旧知识\n' + '很长的旧笔记'.repeat(5000), 2000);
  assert.equal(context.messages[0].id, '0'); assert.equal(context.messages.length, 16); assert.ok(context.estimatedTokens < 2000);
  assert.throws(() => selectContext(note, [{ id: 'long', text: '超大'.repeat(10000) }], '', 1000));
});
test('官方登录身份验证必须校验签名、nonce、受众和有效期', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig' };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
  const claims = { iss: 'https://auth.openai.com', aud: 'issued-client', sub: 'test-account', exp: 2000, nonce: 'random' };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'); const input = `${header}.${payload}`;
  const jwt = `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  const options = { issuer: claims.iss, audience: 'issued-client', nonce: 'random', now: 1000 };
  assert.equal(validateIDToken(jwt, { keys: [jwk] }, options).sub, 'test-account');
  assert.throws(() => validateIDToken(jwt, { keys: [jwk] }, { ...options, nonce: 'wrong' }));
  assert.throws(() => validateIDToken(jwt, { keys: [jwk] }, { ...options, audience: 'other' }));
  assert.throws(() => validateIDToken(jwt, { keys: [jwk] }, { ...options, now: 3000 }));
});
test('模型流必须完整完成；中断与额度错误不能写入草稿', async () => {
  const encode = text => new TextEncoder().encode(text);
  async function* complete() { yield encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'); yield encode('data: {"type":"response.completed","response":{"usage":{"input_tokens":10}}}\n\n'); }
  assert.equal((await readResponses(complete())).text, 'hello');
  async function* interrupted() { yield encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'); }
  await assert.rejects(readResponses(interrupted()), /中断/);
  async function* limited() { yield encode('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n'); }
  await assert.rejects(readResponses(limited()), /额度不足/);
});
