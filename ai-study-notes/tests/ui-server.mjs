// Browser checks run with synthetic data and a synthetic model in an isolated vault.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server/index.mjs';
import { NetworkManager } from '../server/network.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { upstreamError } from '../server/upstream-errors.mjs';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vault = path.join(project, '.test-vault'); await fs.rm(vault, { recursive: true, force: true }); await fs.mkdir(vault, { recursive: true });
const secrets = new Map();
const network = await new NetworkManager(path.join(vault, 'ai-study-notes'), { environment: {}, systemProxy: async () => null }).init();
const app = await createApplication({ root: path.join(vault, 'ai-study-notes'), vault, port: 17862,
  network,
  testSecrets: { kind: '隔离测试', get: async key => secrets.get(key), set: async (key, value) => secrets.set(key, value), remove: async key => secrets.delete(key) },
  modelOverride: {
    chat: async (instructions, messages, signal, onDelta) => {
      if (instructions.includes('你是学习笔记编辑')) {
        const original = messages.at(-1).content;
        await delay(350, undefined, { signal });
        const text = instructions.includes('精简重复') ? '精简要点：理解概念，并保留适用条件。' : original.includes('| 项目') ? original.replace(/\| -- \| -- \|/g, '| --- | --- |') : `## 排版后的要点\n\n${original}`;
        return { text, usage: { input: 65, output: 35, cached: 0, estimated: false } };
      }
      if (messages.at(-1).content.includes('模拟网络断开')) throw upstreamError(new TypeError('fetch failed', { cause: Object.assign(new Error('synthetic connection closed'), { code: 'UND_ERR_SOCKET' }) }), { provider: 'deepseek' });
      let text = '';
      const parts = ['## 概念与联系\n\n', '这是隔离模型的流式回答。', '先理解概念，再核对适用条件。\n\n', '- 条件与例外需要保留。\n', '- 可以把这一段选入笔记。'];
      for (const part of parts) { await delay(messages.at(-1).content.includes('停止') ? 1000 : 160, undefined, { signal }); text += part; onDelta(text.length, part); }
      return { text, usage: { input: 80, output: 60, cached: 0, estimated: false } };
    },
    generate: async (instructions, input) => ({ blocks: [{ heading: '理解与联系', content: '这是隔离测试模型生成的草稿。条件与例外应保留，采纳前可以检查。', children: [{ heading: '学习方法', content: '- 理解概念\n- 对照来源\n- 回顾与应用', children: [], sourceIds: input.messages?.map(x => x.id) || [] }], sourceIds: input.messages?.map(x => x.id) || [] }], usage: { input: 120, output: 80, cached: 0, estimated: false } })
  }
});
console.log(`隔离浏览器测试服务 ${app.baseURL}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
