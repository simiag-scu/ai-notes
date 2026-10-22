// Run against the packaged app, using only disposable study content and a
// separate application-data directory. No provider calls or personal data.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { NoteStore } from '../server/store.mjs';
import { token, protectedJSON } from '../server/security.mjs';

const { _electron: electron } = await import(pathToFileURL(process.env.SHIYE_PLAYWRIGHT || '/private/tmp/shiye-playwright/playwright/driver/package/index.mjs'));
async function until(check, description) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(description); }
function expect(locator) { return { toBeVisible: () => locator.waitFor({ state: 'visible' }), toHaveText: text => until(async () => (await locator.textContent()) === text, `等待文字：${text}`), toContainText: text => until(async () => (await locator.textContent())?.includes(text), `等待内容：${text}`) }; }
expect.poll = operation => ({ toBe: expected => until(async () => (await operation()) === expected, '等待桌面操作完成') });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let executablePath = process.env.SHIYE_APP_BINARY || '/private/tmp/shiye-desktop-toolchain/release/mac-arm64/拾页.app/Contents/MacOS/拾页';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'shiye-app-test-'));
const vault = path.join(temporary, '学习仓库'), legacy = path.join(vault, 'ai-study-notes'), data = path.join(temporary, 'app-data');
await fs.mkdir(legacy, { recursive: true });
const store = await new NoteStore(legacy, vault).init();
const note = await store.create({ title: '桌面导入示例' });
await store.save(note.id, '# 桌面导入示例\n\n选中文字，留下理解。\n\n| 概念 | 说明 |\n| --- | --- |\n| 本机 | 自己保存 |\n', (await store.read(note)).hash);
const identity = { bridgeToken: token(), instanceId: randomUUID(), hostId: `urn:uuid:${randomUUID()}` };
await protectedJSON(path.join(legacy, '.data/connection.json'), identity);
const now = new Date().toISOString();
await store.transact(() => { store.state.chats.push({ id: randomUUID(), title: '独立应用示例对话', updatedAt: now, noteId: null, messages: [{ id: randomUUID(), role: 'user', text: '如何记笔记？', status: 'completed', at: now }, { id: randomUUID(), role: 'assistant', text: '先理解，再用自己的话记录。', status: 'completed', at: now, provider: 'chatgpt', model: 'offline' }] }); });
const errors = [], passed = [], sockets = new Set();
const record = passed.push.bind(passed); passed.push = value => { console.log(`通过：${value}`); return record(value); };
let application;
async function launch() {
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHIYE_APP_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath, env, timeout: 30000 });
  const page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  return page;
}
async function patchDialogs(folder) { await application.evaluate(({ dialog, shell }, selectedFolder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedFolder] }); globalThis.__desktopTestExternal = []; shell.openExternal = async url => { globalThis.__desktopTestExternal.push(url); }; }, folder); }
async function api(page, endpoint, method = 'GET', body) { return page.evaluate(async ({ endpoint, method, body }) => { const result = await fetch(endpoint, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); const data = await result.json(); if (!result.ok) throw new Error(data.error); return data; }, { endpoint, method, body }); }
try {
  let page = await launch();
  await expect(page.locator('h2')).toHaveText('给笔记找个家。');
  await page.waitForSelector('#choose-vault');
  await page.screenshot({ path: path.join(root, '.artifacts/14-mac-onboarding.png') }); passed.push('独立运行时启动与首次设置');
  assert.equal(await page.evaluate(() => typeof require), 'undefined'); passed.push('渲染页面隔离 Node.js');
  await patchDialogs(vault); await page.locator('#choose-vault').click();
  await expect(page.locator('#legacy-card')).toBeVisible(); await page.locator('#import-legacy').check();
  await page.locator('#start').click(); await page.waitForURL('http://127.0.0.1:*/');
  await expect(page.locator('#note-title')).toHaveText('桌面导入示例');
  await expect(page.locator('#preview table')).toBeVisible();
  await expect(page.locator('#chat-messages')).toContainText('先理解，再用自己的话记录。');
  passed.push('旧版笔记与聊天记录导入');
  const config = JSON.parse(await fs.readFile(path.join(data, 'desktop.json'), 'utf8'));
  const copied = JSON.parse(await fs.readFile(path.join(data, 'workspaces', config.activeWorkspaceId, '.data/connection.json'), 'utf8'));
  assert.deepEqual(copied, identity); passed.push('账号连接标识沿用');
  await page.evaluate(() => window.open('https://example.org/reference', '_blank'));
  await expect.poll(() => application.evaluate(() => globalThis.__desktopTestExternal.length)).toBe(1);
  assert.equal(application.windows().length, 1); passed.push('外部网页进入系统浏览器，应用保持独立窗口');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('shiye:command', 'settings'));
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('[data-settings=connection]').click();
  await expect(page.locator('.desktop-preferences')).toContainText('Mac 应用');
  await page.getByRole('button', { name: '安装可选 Obsidian 插件', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('插件已安装');
  await fs.access(path.join(vault, '.obsidian/plugins/shiye-study-notes/main.js')); passed.push('应用内安装可选插件');
  await page.locator('#settings-dialog [data-close]').click();
  await page.locator('#source-tab').click();
  const text = await page.locator('#editor').inputValue();
  await page.locator('#editor').fill(text + '\n更新应用后也要保留的内容。\n');
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.evaluate(() => window.shiyeDesktop.manage());
  assert.match(page.url(), /^http:/); passed.push('未保存修改阻止切换仓库');
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(x => x.label === '文件').submenu.items.find(x => x.label === '保存笔记').click());
  await expect(page.locator('#toast')).toContainText('修改已保存');
  assert.match(await fs.readFile(path.join(vault, note.path), 'utf8'), /更新应用后也要保留/); passed.push('Mac 菜单保存真实 Markdown');
  const originalLegacy = JSON.parse(await fs.readFile(path.join(legacy, '.data/state.json'), 'utf8'));
  assert.equal(originalLegacy.notes.length, 1); assert.doesNotMatch(originalLegacy.notes[0].history.at(-1).text, /更新应用后也要保留/); passed.push('导入保留旧项目数据原样');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); }); passed.push('关闭隐藏、窗口恢复');
  await page.locator('#preview-tab').click(); await page.screenshot({ path: path.join(root, '.artifacts/15-mac-workspace.png') });
  const serviceURL = page.url();
  const callback = await fetch(new URL('/auth/callback?state=invalid&code=not-a-real-code', serviceURL));
  assert.match(await callback.text(), /返回「拾页」应用/);
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#settings-dialog [data-close]').click(); passed.push('授权返回应用并显示错误原因');
  const local = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"via":"desktop-proxy"}'); });
  const proxied = [];
  const proxy = http.createServer((req, res) => { proxied.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end('{"via":"desktop-proxy"}'); });
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); return socket; };
  local.on('connection', track); proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => { proxied.push(req.url); const upstream = track(net.connect(local.address().port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); })); upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); });
  await Promise.all([new Promise(resolve => local.listen(0, '127.0.0.1', resolve)), new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))]);
  try {
    await api(page, '/api/network', 'POST', { mode: 'manual', proxyUrl: `http://127.0.0.1:${proxy.address().port}` });
    const response = await application.evaluate(async () => fetch('http://shiye-desktop.invalid/check', { signal: AbortSignal.timeout(5000) }).then(r => r.json())).catch(error => { console.error('隔离代理收到的请求：', proxied); throw error; });
    assert.equal(response.via, 'desktop-proxy'); assert.equal(proxied.length, 1);
    await api(page, '/api/network', 'POST', { mode: 'auto' }); passed.push('内置运行时通过 HTTP 代理联网、本机请求绕过代理');
  } finally { for (const socket of sockets) socket.destroy(); proxy.close(); local.close(); }
  if (process.env.SHIYE_CHECK_PUBLIC_NETWORK === '1') {
    const check = await api(page, '/api/network/check', 'POST', {});
    await fs.writeFile(path.join(root, '.artifacts/desktop-public-network.json'), JSON.stringify(check, null, 2));
    assert.equal(check.ok, true, '内置运行时需要通过系统代理连接公开登录及模型接口');
    passed.push('实际系统代理下公开登录与模型主机可达（无凭据、无推理额度）');
  }
  const connection = await api(page, '/api/connection');
  await application.close(); application = null;
  await assert.rejects(fetch(new URL('/api/health', serviceURL), { signal: AbortSignal.timeout(2000) })); passed.push('退出后停止本机服务');
  const replacement = path.join(temporary, 'replacement', '拾页.app');
  await promisify(execFile)('/usr/bin/ditto', ['--noextattr', '--norsrc', path.resolve(path.dirname(executablePath), '../..'), replacement]);
  executablePath = path.join(replacement, 'Contents/MacOS/拾页');
  page = await launch(); await page.waitForSelector('#note-title');
  await expect(page.locator('#preview')).toContainText('更新应用后也要保留的内容。');
  assert.equal((await api(page, '/api/connection')).token, connection.token); passed.push('替换到另一份应用后恢复笔记、聊天和连接码');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(root, '.artifacts/desktop-check.json'), JSON.stringify({ passed, errors, runtime: await application.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node, arch: process.arch })), appData: 'isolated temporary directory', realModelCalls: 0 }, null, 2));
  console.log(`${passed.length} 项桌面安装版检查通过。`);
} finally { await application?.close(); await fs.rm(temporary, { recursive: true, force: true }); }
