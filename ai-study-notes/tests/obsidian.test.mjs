import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const code = await fs.readFile(new URL('../obsidian/main.cjs', import.meta.url), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
function pluginFixture({ open = true } = {}) {
  const module = { exports: {} };
  const api = { Plugin: class {}, PluginSettingTab: class {}, ItemView: class {} };
  vm.runInNewContext(code, { module, require: name => name === 'obsidian' ? api : require(name), Buffer, console, setTimeout, clearTimeout, setInterval });
  const plugin = new module.exports(); plugin.secret = 'test-secret';
  let disk = '# 磁盘版本\n', buffer = '# 尚未落盘的手动修改\n', changes = [];
  const file = { path: '课程.md' };
  const editor = { getValue: () => buffer, offsetToPos: offset => ({ line: 0, ch: offset }), transaction: change => { changes.push(change); const edit = change.changes[0]; buffer = buffer.slice(0, edit.from.ch) + edit.text + buffer.slice(edit.to.ch); } };
  plugin.app = { vault: { getAbstractFileByPath: () => file, read: async () => disk, process: async (target, transform) => { disk = transform(disk); } }, workspace: { getLeavesOfType: () => open ? [{ view: { file, editor } }] : [] } };
  async function send(operation, payload) {
    const req = Readable.from([JSON.stringify({ path: file.path, ...payload })]); req.url = `/${operation}`; req.method = 'POST'; req.headers = { authorization: `Bearer ${plugin.secret}` };
    let status, result;
    const res = { headersSent: false, writeHead: value => { status = value; }, end: body => { result = JSON.parse(body); } };
    await plugin.handle(req, res); return { status, data: result };
  }
  return { plugin, send, get buffer() { return buffer; }, get disk() { return disk; }, changes };
}
test('原生适配读取打开编辑器中的内容，并通过最小修改追加', async () => {
  const f = pluginFixture(); const read = await f.send('read');
  assert.equal(read.data.text, f.buffer); assert.notEqual(read.data.text, f.disk);
  const text = f.buffer + '\n## 新采纳的内容\n';
  const write = await f.send('write', { text, expectedHash: read.data.hash });
  assert.equal(write.status, 200); assert.equal(f.buffer, text); assert.equal(f.disk, '# 磁盘版本\n');
  assert.equal(f.changes[0].changes[0].text, '\n## 新采纳的内容\n');
  assert.equal((await f.send('write', { text: '覆盖', expectedHash: 'stale' })).status, 409);
  assert.equal(f.buffer, text);
});
test('关闭的笔记经 Vault.process 写入，且检测读取后的并发修改', async () => {
  const f = pluginFixture({ open: false }); const read = await f.send('read');
  await f.send('write', { text: read.data.text + '新内容', expectedHash: read.data.hash });
  assert.match(f.disk, /新内容/);
  f.plugin.app.vault.process = async (file, transform) => transform('其他窗口刚写入');
  await assert.rejects(f.send('write', { text: '不能覆盖', expectedHash: hash(f.disk) }), /同时发生修改/);
});
