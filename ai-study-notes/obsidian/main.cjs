const { Plugin, PluginSettingTab, Setting, ItemView, MarkdownView, Notice, requestUrl } = require('obsidian');
const http = require('node:http');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const VIEW = 'shiye-study-drafts';
const hash = text => createHash('sha256').update(text).digest('hex');
const equal = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); };

module.exports = class ShiyePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({ url: 'http://127.0.0.1:17861', token: '' }, await this.loadData());
    this.secret = randomBytes(32).toString('base64url'); this.connected = false; this.eventRequest = null;
    this.registerView(VIEW, leaf => new DraftView(leaf, this)); this.addSettingTab(new Preferences(this.app, this));
    this.addRibbonIcon('book-open', '拾页 · 学习草稿', () => this.openDrafts());
    this.addCommand({ id: 'show-drafts', name: '打开学习草稿', callback: () => this.openDrafts() });
    this.addCommand({ id: 'open-workbench', name: '打开本机工作台', callback: () => window.open(this.settings.url) });
    this.addCommand({ id: 'bind-current-note', name: '将当前笔记设为采集目标', callback: () => this.bindCurrent() });
    this.server = http.createServer((req, res) => this.handle(req, res).catch(error => this.reply(res, { error: error.message }, error.status || 500)));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.register(() => { this.eventRequest?.destroy(); this.server?.closeAllConnections(); this.server?.close(); });
    this.registerInterval(setInterval(() => { if (!this.connected && this.settings.token) this.connect().catch(() => {}); }, 10000));
    if (this.settings.token) this.connect().catch(() => {});
  }
  async api(route, data, method = data === undefined ? 'GET' : 'POST') {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(this.settings.url)) throw new Error('工作台地址必须是本机 127.0.0.1 地址');
    const result = await requestUrl({ url: this.settings.url + route, method, headers: { Authorization: `Bearer ${this.settings.token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), throw: false });
    if (result.status >= 400) throw new Error(result.json?.error || '工作台连接失败'); return result.json;
  }
  async connect() {
    if (!this.settings.token || !this.server?.address()) return;
    await this.api('/api/obsidian/connect', { port: this.server.address().port, secret: this.secret, vaultPath: this.app.vault.adapter.getBasePath() });
    this.connected = true; this.startEvents(); this.refreshViews();
  }
  startEvents() {
    this.eventRequest?.destroy();
    this.eventRequest = http.get(this.settings.url + '/api/events', { headers: { Authorization: `Bearer ${this.settings.token}` } }, response => {
      response.on('data', () => { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => this.refreshViews(), 250); });
      response.on('end', () => { this.connected = false; });
      response.on('error', () => { this.connected = false; });
    });
    this.eventRequest.on('error', () => { this.connected = false; });
  }
  refreshViews() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) leaf.view.refresh().catch(() => {}); }
  reply(res, data, status = 200) { if (res.headersSent) return; res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
  openView(file) { return this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).find(view => view.file?.path === file.path && view.editor); }
  async handle(req, res) {
    if (!equal(req.headers.authorization, `Bearer ${this.secret}`) || req.method !== 'POST') return this.reply(res, { error: '未授权' }, 401);
    let body = ''; for await (const data of req) { body += data; if (body.length > 2500000) throw new Error('内容过大'); }
    const payload = JSON.parse(body);
    const relative = payload.path;
    if (typeof relative !== 'string' || !relative.endsWith('.md') || relative.startsWith('/') || relative.split(/[\\/]/).some(x => x === '..' || x.startsWith('.'))) return this.reply(res, { error: '笔记路径无效' }, 400);
    let file = this.app.vault.getAbstractFileByPath(relative), view = file ? this.openView(file) : null;
    const current = file ? view?.editor ? view.editor.getValue() : await this.app.vault.read(file) : '';
    if (req.url === '/read') { if (!file) return this.reply(res, { error: '笔记不存在' }, 404); return this.reply(res, { text: current, hash: hash(current), native: true }); }
    if (req.url !== '/write' || typeof payload.text !== 'string') return this.reply(res, { error: '操作无效' }, 400);
    if (payload.expectedHash && payload.expectedHash !== hash(current)) return this.reply(res, { error: '笔记已修改，请刷新后再采纳' }, 409);
    if (!file) {
      const parts = relative.split('/'); parts.pop(); let cursor = '';
      for (const part of parts) { cursor = cursor ? `${cursor}/${part}` : part; if (!this.app.vault.getAbstractFileByPath(cursor)) await this.app.vault.createFolder(cursor); }
      file = await this.app.vault.create(relative, payload.text);
    } else if (view?.editor) {
      let prefix = 0, suffix = 0;
      while (prefix < current.length && prefix < payload.text.length && current[prefix] === payload.text[prefix]) prefix++;
      while (suffix < current.length - prefix && suffix < payload.text.length - prefix && current[current.length - suffix - 1] === payload.text[payload.text.length - suffix - 1]) suffix++;
      view.editor.transaction({ changes: [{ from: view.editor.offsetToPos(prefix), to: view.editor.offsetToPos(current.length - suffix), text: payload.text.slice(prefix, payload.text.length - suffix) }] });
    } else await this.app.vault.process(file, latest => { if (hash(latest) !== hash(current)) throw Object.assign(new Error('笔记同时发生修改，请重试'), { status: 409 }); return payload.text; });
    return this.reply(res, { text: payload.text, hash: hash(payload.text), native: true });
  }
  async openDrafts() { let leaf = this.app.workspace.getLeavesOfType(VIEW)[0]; if (!leaf) { leaf = this.app.workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW, active: true }); } this.app.workspace.revealLeaf(leaf); }
  async bindCurrent() {
    try {
      const file = this.app.workspace.getActiveFile(); if (!file || file.extension !== 'md') throw new Error('先打开一篇 Markdown 笔记');
      const text = await this.app.vault.cachedRead(file); const mode = text.split('\n').filter(line => line.trim()).every(line => /^(?:  )*- \S/.test(line)) ? 'outline' : 'markdown';
      const note = await this.api('/api/notes', { title: file.basename, mode, existingPath: file.path }); await this.api('/api/settings', { targetNoteId: note.id }); new Notice('已绑定当前笔记'); this.refreshViews();
    } catch (error) { new Notice(error.message); }
  }
  onunload() { clearTimeout(this.refreshTimer); }
};

class Preferences extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const container = this.containerEl; container.empty(); container.createEl('h2', { text: '拾页 · 本机连接' });
    container.createEl('p', { text: '先运行项目中的“启动拾页.command”，在工作台“连接与偏好”里复制本机连接码。' });
    new Setting(container).setName('工作台地址').addText(text => text.setValue(this.plugin.settings.url).onChange(async value => { this.plugin.settings.url = value.trim().replace(/\/$/, ''); await this.plugin.saveData(this.plugin.settings); }));
    new Setting(container).setName('本机连接码').addText(text => { text.inputEl.type = 'password'; text.setValue(this.plugin.settings.token).onChange(async value => { this.plugin.settings.token = value.trim(); await this.plugin.saveData(this.plugin.settings); }); });
    new Setting(container).setName('连接工作台').addButton(button => button.setButtonText('连接').setCta().onClick(async () => { try { await this.plugin.connect(); new Notice('拾页已连接原生编辑器'); } catch (error) { new Notice(error.message); } }));
  }
}
class DraftView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.noteId = null; this.selected = new Set(); }
  getViewType() { return VIEW; } getDisplayText() { return '拾页学习草稿'; } getIcon() { return 'book-open'; }
  async onOpen() { this.contentEl.addClass('shiye-panel'); await this.refresh(); }
  async refresh() {
    if (this.refreshing) return; this.refreshing = true;
    try {
      const container = this.contentEl; container.empty(); const header = container.createDiv({ cls: 'shiye-header' }); header.createEl('h3', { text: '拾页 · 学习草稿' });
      const open = header.createEl('button', { text: '工作台 ↗' }); open.onclick = () => window.open(this.plugin.settings.url);
      if (!this.plugin.connected) { container.createEl('p', { text: '尚未连接。请启动本机工作台，并在插件设置中填写连接码。', cls: 'shiye-muted' }); return; }
      const state = await this.plugin.api('/api/state');
      if (!state.notes.length) { container.createEl('p', { text: '请在工作台新建学习笔记，或使用命令“将当前笔记设为采集目标”。' }); return; }
      this.noteId = state.settings.targetNoteId || state.notes[0].id;
      const select = container.createEl('select', { cls: 'shiye-select' });
      for (const note of state.notes) { const option = select.createEl('option', { text: `${note.title} · ${note.mode === 'outline' ? '大纲' : '普通'}`, value: note.id }); option.selected = note.id === this.noteId; }
      select.onchange = async () => { await this.plugin.api('/api/settings', { targetNoteId: select.value }); this.selected.clear(); await this.refresh(); };
      const note = await this.plugin.api(`/api/notes/${this.noteId}`); const controls = container.createDiv({ cls: 'shiye-controls' });
      const read = controls.createEl('button', { text: '打开笔记' }); read.onclick = () => this.app.workspace.openLinkText(note.path, '', false);
      const summary = controls.createEl('button', { text: '整理新对话' }); summary.onclick = async () => { try { await this.plugin.api(`/api/notes/${note.id}/summarize`, {}); new Notice('正在生成草稿'); } catch (error) { new Notice(error.message); } };
      const accept = controls.createEl('button', { text: '采纳选中', cls: 'mod-cta' }); accept.onclick = async () => { try { if (!this.selected.size) throw new Error('请先选择草稿'); await this.plugin.api(`/api/notes/${note.id}/accept`, { ids: [...this.selected], expectedHash: note.hash }); this.selected.clear(); await this.refresh(); } catch (error) { new Notice(error.message); } };
      const drafts = note.drafts.filter(x => x.status === 'pending');
      if (!drafts.length) container.createEl('p', { text: '暂时没有待确认草稿。采集 AI 网页对话后，整理结果会出现在这里。', cls: 'shiye-muted' });
      for (const draft of drafts) {
        const card = container.createDiv({ cls: 'shiye-draft' }); const label = card.createEl('label'); const checkbox = label.createEl('input', { type: 'checkbox' }); checkbox.checked = this.selected.has(draft.id); checkbox.onchange = () => checkbox.checked ? this.selected.add(draft.id) : this.selected.delete(draft.id); label.createEl('strong', { text: draft.block.heading || '原文摘录' });
        const contents = []; const walk = block => { if (block.content) contents.push(block.content); block.children.forEach(child => { if (child.heading) contents.push(child.heading); walk(child); }); }; walk(draft.block); card.createEl('div', { text: contents.join('\n'), cls: 'shiye-draft-text' });
        const ignore = card.createEl('button', { text: '忽略此条' }); ignore.onclick = async () => { try { await this.plugin.api(`/api/notes/${note.id}/reject`, { ids: [draft.id] }); await this.refresh(); } catch (error) { new Notice(error.message); } };
      }
    } catch (error) { this.contentEl.createEl('p', { text: error.message, cls: 'shiye-muted' }); }
    finally { this.refreshing = false; }
  }
}
