import { app, BrowserWindow, Menu, dialog, ipcMain, shell, session, screen } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetch as desktopFetch, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createApplication } from '../server/index.mjs';
import { NetworkManager } from '../server/network.mjs';
import { WorkspaceStore, inspectLegacy, safeExternalURL } from './workspaces.mjs';
import { WindowLifecycle, minimumWindowSize } from './window-lifecycle.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const setupURL = pathToFileURL(path.join(directory, 'setup.html')).href;
app.setName('拾页');
if (process.env.SHIYE_APP_DATA) app.setPath('userData', path.resolve(process.env.SHIYE_APP_DATA));
app.commandLine.appendSwitch('lang', 'zh-CN');
globalThis.fetch = desktopFetch;
let window, windowLifecycle, workspaces, service, selectedVault = null, selectedLegacy = null, startupError = '', portWarning = '', dirty = false, starting = false, quitting = false;

function trusted(event) {
  const current = event.senderFrame?.url;
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !(current === setupURL || service && new URL(current).origin === service.baseURL)) throw new Error('此页面不能操作本机文件');
}
function handler(name, operation) { ipcMain.handle(`shiye:${name}`, async (event, data) => { trusted(event); try { return await operation(data); } catch (error) { throw new Error(error.message); } }); }
function focus() { windowLifecycle?.show(); }
async function openExternal(url) { if (safeExternalURL(url)) await shell.openExternal(url); }
async function confirmLeave() {
  if (!dirty && !service?.busy) return true;
  const { response } = await dialog.showMessageBox(window, { type: 'question', message: dirty ? '还有未保存的笔记修改' : 'AI 仍在生成内容', detail: dirty ? '继续会放弃尚未保存的源文修改。已经保存的笔记和聊天记录会保留。' : '继续会停止当前生成，已收到的聊天文字会保存。', buttons: ['返回继续', dirty ? '放弃修改并继续' : '停止并继续'], defaultId: 0, cancelId: 0 });
  if (response !== 1) return false;
  dirty = false; return true;
}
function applyProxy(environment) {
  const previous = getGlobalDispatcher();
  const agent = new EnvHttpProxyAgent({ httpProxy: environment.http_proxy, httpsProxy: environment.https_proxy, noProxy: environment.no_proxy });
  setGlobalDispatcher(agent);
  return () => { setGlobalDispatcher(previous); void agent.close().catch(() => {}); };
}
async function info() {
  const existing = workspaces.config.workspaces.find(x => x.vaultPath === selectedVault);
  let legacy = null;
  if (selectedVault && !existing) {
    const candidate = selectedLegacy || path.join(selectedVault, 'ai-study-notes');
    try { const result = await inspectLegacy(candidate, selectedVault); legacy = { directory: result.source, notes: result.notes, chats: result.chats }; selectedLegacy = result.source; } catch { selectedLegacy = null; }
  }
  return { version: app.getVersion(), dataDirectory: workspaces.directory, vault: selectedVault, existing: !!existing, legacy, active: service ? workspaces.active?.name : null, localAddress: service?.baseURL || '', error: startupError, portWarning };
}
async function showSetup() {
  selectedVault = workspaces.active?.vaultPath || null; selectedLegacy = null;
  await window.loadFile(path.join(directory, 'setup.html')); focus();
}
async function openWorkspace(workspace) {
  const vault = await fs.realpath(workspace.vaultPath).catch(() => { throw new Error('原笔记仓库暂时无法访问。请确认磁盘或 iCloud 已连接，再重新选择该文件夹'); });
  if (service) { await service.close(); service = null; }
  const root = workspaces.root(workspace);
  const isNew = await fs.access(path.join(root, '.data/state.json')).then(() => false, () => true);
  const network = await new NetworkManager(root, { applyProxy }).init();
  const options = { root, vault, network, onAuthComplete: async ({ ok }) => { focus(); window.webContents.send('shiye:command', ok ? 'auth-connected' : 'auth-failed'); } };
  portWarning = '';
  try { service = await createApplication({ ...options, port: 17861 }); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') { network.close(); throw error; }
    // Never attach to or stop an unknown process that happens to use our port.
    service = await createApplication({ ...options, port: 0 }).catch(error => { network.close(); throw error; });
    portWarning = '原工作台端口已被占用，当前使用空闲端口。网页采集扩展和 Obsidian 插件请填写下面的本机地址；退出旧版后重启应用可恢复默认地址。';
  }
  if (isNew) await service.store.transact(() => { service.store.state.settings.outputFolder = '拾页笔记'; });
  dirty = false; startupError = '';
  await window.loadURL(service.baseURL); focus();
}
function command(value) { if (window.webContents.getURL() !== setupURL) window.webContents.send('shiye:command', value); }
function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '拾页', submenu: [{ label: '关于拾页', role: 'about' }, { label: '连接与偏好…', accelerator: 'CmdOrCtrl+,', click: () => command('settings') }, { type: 'separator' }, { role: 'services', label: '服务' }, { type: 'separator' }, { role: 'hide', label: '隐藏拾页' }, { role: 'hideOthers', label: '隐藏其他应用' }, { role: 'unhide', label: '显示全部' }, { type: 'separator' }, { role: 'quit', label: '退出拾页' }] },
    { label: '文件', submenu: [{ label: '新建学习笔记…', accelerator: 'CmdOrCtrl+N', click: () => command('new-note') }, { label: '新对话', accelerator: 'CmdOrCtrl+Shift+N', click: () => command('new-chat') }, { label: '保存笔记', accelerator: 'CmdOrCtrl+S', click: () => command('save') }, { type: 'separator' }, { label: '笔记仓库与数据…', accelerator: 'CmdOrCtrl+Shift+O', click: () => { void (async () => { if (await confirmLeave()) await showSetup(); })(); } }, { label: '在访达显示笔记仓库', click: () => { if (workspaces.active) void shell.openPath(workspaces.active.vaultPath); } }, { type: 'separator' }, { role: 'close', label: '关闭窗口' }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '拷贝' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '显示', submenu: [{ role: 'reload', label: '重新载入' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { label: '切换全屏幕', accelerator: 'Ctrl+Command+F', click: () => windowLifecycle?.toggleFullScreen() }] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { role: 'front', label: '前置全部窗口' }] },
    { label: '帮助', submenu: [{ label: '使用说明', click: () => { void shell.openPath(path.join(directory, '使用说明.txt')); } }, { label: '显示应用数据（用于备份）', click: () => { void shell.openPath(workspaces.directory); } }] }
  ]));
}
async function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: minimumWindowSize.width, minHeight: minimumWindowSize.height, show: false, backgroundColor: '#f4f3ee', title: '拾页', webPreferences: { preload: path.join(directory, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, spellcheck: false, devTools: !app.isPackaged || app.commandLine.hasSwitch('remote-debugging-port') } });
  windowLifecycle = new WindowLifecycle(window, { screen, activate: () => app.focus({ steal: true }) });
  window.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (url !== setupURL && (!service || new URL(url).origin !== service.baseURL)) { event.preventDefault(); void openExternal(url); } });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => { if (!dirty) { event.preventDefault(); return; } const response = dialog.showMessageBoxSync(window, { type: 'question', message: '还有未保存的笔记修改', buttons: ['返回继续', '放弃修改'], defaultId: 0, cancelId: 0 }); if (response === 1) { dirty = false; event.preventDefault(); } });
  window.on('close', event => { if (!quitting) { event.preventDefault(); windowLifecycle.hide(); } });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
  session.defaultSession.on('will-download', (_event, item) => { item.setSaveDialogOptions({ title: '保存拾页组件', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) }); });
  createMenu();
  try { if (workspaces.active) await openWorkspace(workspaces.active); else await showSetup(); }
  catch (error) { startupError = error.message; await showSetup(); }
}

handler('info', info);
handler('choose-vault', async () => {
  const result = await dialog.showOpenDialog(window, { title: '选择 Obsidian 仓库或笔记文件夹', buttonLabel: '使用这个文件夹', defaultPath: selectedVault || app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] });
  if (!result.canceled) { selectedVault = await fs.realpath(result.filePaths[0]); selectedLegacy = null; startupError = ''; }
  return info();
});
handler('choose-legacy', async () => {
  if (!selectedVault) throw new Error('请先选择原 Obsidian 仓库');
  const result = await dialog.showOpenDialog(window, { title: '选择旧版 ai-study-notes 项目文件夹', properties: ['openDirectory'], defaultPath: selectedVault });
  if (!result.canceled) { const legacy = await inspectLegacy(result.filePaths[0], selectedVault); selectedLegacy = legacy.source; }
  return info();
});
handler('start', async options => {
  if (starting) throw new Error('正在打开，请稍候');
  if (!selectedVault) throw new Error('请先选择笔记文件夹');
  if (options?.importLegacy && !selectedLegacy) throw new Error('请先选择要导入的旧版项目');
  starting = true;
  try {
    if (!await confirmLeave()) return { cancelled: true };
    const workspace = await workspaces.prepare(selectedVault, options?.importLegacy ? selectedLegacy : null);
    await openWorkspace(workspace); return { ok: true };
  } finally { starting = false; }
});
handler('manage', async () => { if (await confirmLeave()) await showSetup(); });
handler('show-data', async () => { await shell.openPath(workspaces.directory); });
handler('show-vault', async () => { if (workspaces.active) await shell.openPath(workspaces.active.vaultPath); });
handler('install-plugin', async () => {
  if (!service) throw new Error('请先打开笔记仓库');
  const target = path.join(service.store.vault, '.obsidian', 'plugins', 'shiye-study-notes');
  const backup = path.join(workspaces.directory, 'backups', `obsidian-plugin-${Date.now()}`);
  for (const [source, name] of [['main.cjs', 'main.js'], ['manifest.json', 'manifest.json'], ['styles.css', 'styles.css']]) {
    const previous = path.join(target, name);
    if (await fs.access(previous).then(() => true, () => false)) { await fs.mkdir(backup, { recursive: true }); await fs.copyFile(previous, path.join(backup, name)); }
    await fs.mkdir(target, { recursive: true }); await fs.copyFile(path.join(directory, '..', 'obsidian', source), previous);
  }
  return { ok: true };
});
ipcMain.on('shiye:dirty', (event, value) => { trusted(event); dirty = value === true; });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', focus);
  app.on('activate', () => { if (window) focus(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    void (async () => { if (!await confirmLeave()) return; quitting = true; if (window && !window.isDestroyed()) window.webContents.removeAllListeners('will-prevent-unload'); await service?.close(); service = null; windowLifecycle?.dispose(); window?.destroy(); app.quit(); })().catch(error => { quitting = false; dialog.showErrorBox('退出未完成', error.message); });
  });
  // Electron completes ESM entry evaluation before emitting ready. Keep this
  // promise out of the module's top-level await chain to avoid a startup wait.
  void app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: '拾页', applicationVersion: app.getVersion(), copyright: 'AI 对话与自己的学习笔记', credits: '笔记保存在你选择的文件夹，聊天与偏好独立保存在本机。' });
    workspaces = await new WorkspaceStore(app.getPath('userData')).init();
    await createWindow();
  }).catch(error => { dialog.showErrorBox('无法打开拾页', error.message); app.exit(1); });
}
