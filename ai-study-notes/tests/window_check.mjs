// Native macOS window regression, isolated from the user's study data.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const { _electron: electron } = await import(pathToFileURL(process.env.SHIYE_PLAYWRIGHT || '/private/tmp/shiye-playwright/playwright/driver/package/index.mjs'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.argv.includes('--baseline');
const executablePath = process.env.SHIYE_APP_BINARY || '/Applications/拾页.app/Contents/MacOS/拾页';
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'shiye-window-check-'));
const env = { ...process.env, SHIYE_APP_DATA: data, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }; delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ executablePath, env, timeout: 30000 });
const page = await application.firstWindow();
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const snapshot = () => application.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { fullScreen: w.isFullScreen(), visible: w.isVisible(), bounds: w.getBounds(), normalBounds: w.getNormalBounds(), minimum: w.getMinimumSize(), loading: w.webContents.isLoading(), destroyed: w.webContents.isDestroyed() }; });
async function waitFor(check, description) { for (let i = 0; i < 120; i++) { if (await check()) return; await pause(100); } throw new Error(description); }
const states = [], checks = [];
try {
  await page.waitForSelector('#choose-vault');
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]; globalThis.__windowEvents = [];
    for (const event of ['enter-full-screen', 'leave-full-screen', 'show', 'hide', 'resize', 'move', 'minimize', 'restore', 'close']) w.on(event, () => { globalThis.__windowEvents.push({ event, at: Date.now(), fullScreen: w.isFullScreen(), visible: w.isVisible(), bounds: w.getBounds() }); });
    w.setBounds({ x: 100, y: 80, width: 1100, height: 740 }); w.show(); w.focus();
  });
  await pause(300); states.push({ stage: 'normal', ...await snapshot() });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
  await waitFor(() => application.evaluate(() => globalThis.__windowEvents.some(x => x.event === 'enter-full-screen')), '未能进入 macOS 原生全屏');
  await pause(350); states.push({ stage: 'full-screen', ...await snapshot() });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitFor(async () => !(await snapshot()).visible, '关闭后未隐藏窗口');
  await pause(600); states.push({ stage: 'closed', ...await snapshot() });
  console.log(JSON.stringify({ stage: 'closed', state: states.at(-1) }));
  await application.evaluate(({ app }) => app.emit('activate', {}, false));
  await waitFor(async () => (await snapshot()).visible, 'Dock 激活未恢复窗口');
  await pause(800); states.push({ stage: 'reopened', ...await snapshot() });
  console.log(JSON.stringify({ stage: 'reopened', state: states.at(-1) }));
  if (!baseline) {
    assert.equal(states.find(x => x.stage === 'closed').fullScreen, false, '隐藏前必须完整退出全屏');
    const visible = states.at(-1); assert.equal(visible.fullScreen, false);
    assert.ok(visible.bounds.width >= 850 && visible.bounds.height >= 640, '恢复后不能成为微小窗口');
    assert.equal(visible.bounds.width, 1100); assert.equal(visible.bounds.height, 740);
    await page.locator('#choose-legacy').click();
    await waitFor(() => page.locator('#setup-error').isVisible(), '恢复后界面必须仍可交互');
    checks.push('全屏关闭完成退出后隐藏', 'Dock 恢复原尺寸且可操作');
    await page.evaluate(() => { globalThis.__windowDraft = '保留尚未提交的界面状态'; });
    for (let cycle = 0; cycle < 3; cycle++) {
      const previous = await application.evaluate(() => globalThis.__windowEvents.filter(x => x.event === 'enter-full-screen').length);
      await application.evaluate(({ app }) => app.emit('activate', {}, false));
      await pause(200);
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
      await waitFor(() => application.evaluate((_electron, count) => globalThis.__windowEvents.filter(x => x.event === 'enter-full-screen').length > count, previous), '重复测试进入全屏失败');
      await application.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.close(); w.close(); });
      await waitFor(async () => { const s = await snapshot(); return !s.visible && !s.fullScreen; }, '重复关闭后未退出并隐藏');
      await application.evaluate(({ app }) => app.emit('activate', {}, false));
      await waitFor(async () => (await snapshot()).visible, '重复恢复失败');
      const current = await snapshot(); assert.equal(current.bounds.width, 1100); assert.equal(current.bounds.height, 740);
    }
    checks.push('连续三轮全屏与重复关闭保持正确尺寸');
    await application.evaluate(({ BrowserWindow, Menu }) => {
      Menu.getApplicationMenu().items.find(x => x.label === '显示').submenu.items.find(x => x.label === '切换全屏幕').click();
      BrowserWindow.getAllWindows()[0].close();
    });
    await waitFor(async () => { const s = await snapshot(); return !s.fullScreen && !s.visible; }, '进入动画中关闭未能正确隐藏');
    await application.evaluate(({ app }) => app.emit('activate', {}, false));
    await waitFor(async () => (await snapshot()).visible, '进入动画中关闭后恢复失败');
    checks.push('进入全屏动画时关闭可恢复');
    const counts = await application.evaluate(() => Object.fromEntries(['enter-full-screen', 'leave-full-screen', 'close'].map(name => [name, globalThis.__windowEvents.filter(x => x.event === name).length])));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await waitFor(() => application.evaluate((_electron, count) => globalThis.__windowEvents.filter(x => x.event === 'enter-full-screen').length > count, counts['enter-full-screen']), '竞争测试未完成进入全屏');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await waitFor(() => application.evaluate((_electron, count) => globalThis.__windowEvents.filter(x => x.event === 'close').length > count, counts.close), '未收到关闭事件');
    await application.evaluate(({ app }) => app.emit('activate', {}, false));
    await waitFor(() => application.evaluate((_electron, count) => globalThis.__windowEvents.filter(x => x.event === 'leave-full-screen').length > count, counts['leave-full-screen']), '竞争测试未完成退出全屏');
    await waitFor(async () => { const s = await snapshot(); return s.visible && !s.fullScreen && s.bounds.width === 1100; }, '退出动画中 Dock 激活后未正常显示');
    await pause(350); assert.equal((await snapshot()).visible, true);
    checks.push('退出动画途中 Dock 激活不被延迟关闭');
    await application.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(1, 1); w.setBounds({ x: 10, y: 50, width: 2, height: 2 }); w.close(); });
    await waitFor(async () => !(await snapshot()).visible, '微小窗口未完成关闭');
    await application.evaluate(({ app }) => app.emit('activate', {}, false));
    await waitFor(async () => { const s = await snapshot(); return s.visible && s.bounds.width >= 850 && s.bounds.height >= 640; }, '异常微小尺寸未恢复');
    assert.deepEqual((await snapshot()).minimum, [850, 640]);
    checks.push('微小尺寸恢复与最小窗口保护');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await waitFor(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), '最小化未完成');
    await application.evaluate(({ app }) => app.emit('activate', {}, false));
    await waitFor(() => application.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return w.isVisible() && !w.isMinimized(); }), '最小化后无法激活恢复');
    assert.equal(await page.evaluate(() => globalThis.__windowDraft), '保留尚未提交的界面状态');
    await page.locator('#choose-legacy').click(); await waitFor(() => page.locator('#setup-error').isVisible(), '最终页面无法操作');
    checks.push('最小化恢复及未提交界面状态保留');
    states.push({ stage: 'after-regression', ...await snapshot() });
  }
  await page.screenshot({ path: path.join(root, '.artifacts', baseline ? '16-window-baseline.png' : '17-window-fixed.png') });
  const events = await application.evaluate(() => globalThis.__windowEvents);
  const result = { baseline, version: await application.evaluate(({ app }) => app.getVersion()), states, checks, events };
  await fs.writeFile(path.join(root, '.artifacts', baseline ? 'window-baseline.json' : 'window-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ result: baseline ? 'baseline-recorded' : 'passed', checks }));
} catch (error) {
  const events = await application.evaluate(() => globalThis.__windowEvents).catch(() => []);
  await fs.writeFile(path.join(root, '.artifacts/window-check-failure.json'), JSON.stringify({ error: error.message, states, current: await snapshot().catch(() => null), events }, null, 2));
  throw error;
} finally {
  await application.close();
  await fs.rm(data, { recursive: true, force: true });
}
