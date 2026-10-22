import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceStore, inspectLegacy, safeExternalURL } from '../desktop/workspaces.mjs';
import { createApplication } from '../server/index.mjs';
import { token, protectedJSON } from '../server/security.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'shiye-desktop-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const vault = path.join(base, 'vault'), legacy = path.join(vault, 'old-project'), userData = path.join(base, 'app-data');
  await fs.mkdir(path.join(legacy, '.data'), { recursive: true });
  await fs.writeFile(path.join(vault, '旧笔记.md'), '# 原来的内容\n');
  const connection = { bridgeToken: token(), instanceId: 'preserve-keychain-identity', hostId: 'preserve-oauth-client' };
  const state = { version: 1, settings: { outputFolder: '学习', provider: 'chatgpt', model: 'test', dailyTokenBudget: 100000, callsPerHour: 30 }, notes: [{ id: 'old-note', path: '旧笔记.md' }], chats: [{ id: 'old-chat', messages: [] }], usage: [], activity: [] };
  await protectedJSON(path.join(legacy, '.data/connection.json'), connection);
  await protectedJSON(path.join(legacy, '.data/state.json'), state);
  await protectedJSON(path.join(legacy, '.data/network.json'), { mode: 'manual', proxyUrl: 'http://127.0.0.1:7897/' });
  return { base, vault, legacy, userData, connection, state };
}
test('桌面导入保留账号身份与全部记录，原项目和笔记不改动；重复导入不覆盖', async t => {
  const f = await fixture(t), original = await fs.readFile(path.join(f.legacy, '.data/state.json'), 'utf8');
  const store = await new WorkspaceStore(f.userData).init();
  const imported = await store.prepare(f.vault, f.legacy);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(store.root(imported), '.data/connection.json'), 'utf8')), f.connection);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(store.root(imported), '.data/state.json'), 'utf8')), f.state);
  assert.equal(await fs.readFile(path.join(f.legacy, '.data/state.json'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(f.vault, '旧笔记.md'), 'utf8'), '# 原来的内容\n');
  assert.equal((await fs.stat(path.join(store.root(imported), '.data/state.json'))).mode & 0o777, 0o600);
  await assert.rejects(store.prepare(f.vault, f.legacy), /不能重复导入/);
  assert.equal((await store.prepare(f.vault)).id, imported.id);
  assert.equal((await new WorkspaceStore(f.userData).init()).active.id, imported.id);
});
test('仓库隔离保存，重新选择仓库恢复对应记录，程序目录不参与数据存储', async t => {
  const f = await fixture(t), store = await new WorkspaceStore(f.userData).init();
  const a = await store.prepare(f.vault, f.legacy);
  const other = path.join(f.base, 'other-vault'); await fs.mkdir(other);
  const b = await store.prepare(other);
  assert.notEqual(a.id, b.id); assert.notEqual(store.root(a), store.root(b));
  assert.equal(store.active.id, b.id);
  assert.equal((await store.prepare(f.vault)).id, a.id);
  assert.equal((await new WorkspaceStore(f.userData).init()).active.id, a.id);
});
test('导入拒绝错误仓库、越界笔记和损坏数据，错误前不创建新记录', async t => {
  const f = await fixture(t), store = await new WorkspaceStore(f.userData).init();
  const other = path.join(f.base, 'empty'); await fs.mkdir(other);
  await assert.rejects(store.prepare(other, f.legacy), /找不到原笔记/);
  assert.equal(store.config.workspaces.length, 0);
  f.state.notes[0].path = '../outside.md'; await protectedJSON(path.join(f.legacy, '.data/state.json'), f.state);
  await assert.rejects(inspectLegacy(f.legacy, f.vault), /路径无效/);
  await fs.writeFile(path.join(f.legacy, '.data/state.json'), 'broken');
  await assert.rejects(inspectLegacy(f.legacy, f.vault), /无法读取/);
  assert.equal(store.config.workspaces.length, 0);
});
test('损坏的桌面设置不能静默覆盖，外部跳转限制为网页和 Obsidian 打开笔记', async t => {
  const f = await fixture(t); await fs.mkdir(f.userData); const filename = path.join(f.userData, 'desktop.json');
  await fs.writeFile(filename, 'bad data'); await assert.rejects(new WorkspaceStore(f.userData).init(), /无法读取/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'bad data');
  for (const value of ['https://auth.openai.com/login', 'http://example.org', 'obsidian://open?vault=Study&file=A.md']) assert.equal(safeExternalURL(value), true);
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'terminal://run', 'obsidian://advanced-uri?vault=Study&command=run', 'https://user:secret@example.org', 'obsidian://open?command=delete&vault=A']) assert.equal(safeExternalURL(value), false);
});
test('桌面 OAuth 返回显示完成页并通知应用，不在浏览器打开另一份工作台', async t => {
  const f = await fixture(t), results = [];
  const secrets = { kind: '隔离测试', get: async () => null, set: async () => {}, remove: async () => {} };
  const application = await createApplication({ root: f.userData, vault: f.vault, port: 0, testSecrets: secrets, onAuthComplete: result => results.push(result) });
  t.after(() => application.close());
  application.auth.callback = async () => {};
  const successful = await fetch(`${application.baseURL}/auth/callback?code=never-expose&state=secret`);
  const html = await successful.text(); assert.equal(successful.status, 200); assert.match(html, /账号已连接/); assert.doesNotMatch(html, /never-expose|secret/); assert.deepEqual(results, [{ ok: true }]);
  application.auth.callback = async () => { throw new Error('secret provider failure'); };
  const failed = await fetch(`${application.baseURL}/auth/callback`); assert.match(await failed.text(), /本次连接未完成/); assert.deepEqual(results.at(-1), { ok: false });
});
