import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { cleanTitle, MODES, serializeBlocks, normalizeText, validateOutline } from '../core/format.mjs';
import { protectedJSON } from './security.mjs';
import { colorize } from '../core/edits.mjs';

export const hash = text => createHash('sha256').update(text).digest('hex');
export const fingerprint = text => hash(String(text).replace(/[\s#>*_`-]+/g, '').toLowerCase());
export const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export class NoteStore {
  constructor(root, vault) { this.root = root; this.vault = vault; this.directory = path.join(root, '.data'); this.filename = path.join(this.directory, 'state.json'); this.tail = Promise.resolve(); this.bridge = null; }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await fs.readFile(this.filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure('项目状态文件无法读取，请保留 .data 并从历史恢复，避免覆盖已有数据', 500);
      this.state = { version: 1, settings: { outputFolder: 'ai-study-notes/笔记', provider: 'chatgpt', model: '', autoSummary: false, contextBudget: 6000, dailyTokenBudget: 100000, callsPerHour: 30, targetNoteId: null }, notes: [], usage: [], activity: [] };
      await this.persist();
    }
    this.state.chats ||= [];
    this.state.edits ||= [];
    for (const edit of this.state.edits) if (edit.status === 'running') Object.assign(edit, { status: 'failed', error: '服务已重启，笔记未改动，请重新选择内容' });
    // A process restart cannot resume a provider's in-flight stream.
    for (const chat of this.state.chats) for (const message of chat.messages) if (message.status === 'streaming') { message.status = 'interrupted'; message.error = '服务已重启，请重试这一轮'; }
    for (const entry of this.state.usage) if (entry.status === 'running') entry.status = 'interrupted';
    await this.persist();
    this.vault = await fs.realpath(this.vault);
    return this;
  }
  async persist() { const temp = `${this.filename}.tmp`; await protectedJSON(temp, this.state); await fs.rename(temp, this.filename); }
  transact(fn) {
    const next = this.tail.then(async () => { const backup = structuredClone(this.state); try { const result = await fn(); await this.persist(); return result; } catch (error) { this.state = backup; throw error; } });
    this.tail = next.catch(() => {}); return next;
  }
  note(id) { const found = this.state.notes.find(x => x.id === id); if (!found) throw failure('笔记不存在', 404); return found; }
  async safePath(relative, create = false) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0') || relative.split(/[\\/]/).some(x => x === '..' || x.startsWith('.'))) throw failure('请选择仓库中的普通笔记路径');
    const target = path.resolve(this.vault, relative);
    if (!target.startsWith(this.vault + path.sep)) throw failure('路径超出当前仓库');
    let cursor = this.vault;
    for (const part of path.relative(this.vault, target).split(path.sep)) {
      cursor = path.join(cursor, part);
      try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw failure('输出路径不能经过符号链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (create) await fs.mkdir(path.dirname(target), { recursive: true });
    return target;
  }
  async read(note) {
    if (this.bridge) {
      try { return await this.bridge('read', { path: note.path }); }
      catch (error) { if (error.status === 409 || error.status === 404) throw error; throw failure('Obsidian 连接中断。为保护尚未保存的编辑，本次操作已停止；请恢复连接或在设置中切回本地文件模式', 503); }
    }
    const text = await fs.readFile(await this.safePath(note.path), 'utf8');
    return { text, hash: hash(text), native: false };
  }
  async write(note, text, expectedHash) {
    if (note.mode === 'outline') validateOutline(text);
    if (this.bridge) {
      try { return await this.bridge('write', { path: note.path, text, expectedHash }); }
      catch (error) { if (error.status === 409 || error.status === 400) throw error; throw failure('Obsidian 连接中断。为保护编辑内容，本次未写入；请恢复连接或重新打开本地文件模式', 503); }
    }
    const filename = await this.safePath(note.path, true);
    let existing = ''; try { existing = await fs.readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (expectedHash && hash(existing) !== expectedHash) throw failure('笔记已在其他位置修改，请刷新后再采纳，当前修改未被覆盖', 409);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    try {
      let check = ''; try { check = await fs.readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (hash(check) !== hash(existing)) throw failure('写入时检测到其他修改，请刷新后重试', 409);
      await fs.rename(temporary, filename);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return { text, hash: hash(text), native: false };
  }
  activity(message) { this.state.activity.unshift({ id: randomUUID(), message, at: new Date().toISOString() }); this.state.activity = this.state.activity.slice(0, 60); }
  async create({ title, mode = 'markdown', content = null, existingPath = null, convertedFrom = null }) {
    if (!MODES.has(mode)) throw failure('请选择有效笔记模式');
    return this.transact(async () => {
      const safeTitle = cleanTitle(title), suffix = mode === 'outline' ? '大纲' : '笔记';
      let relative = existingPath || path.posix.join(this.state.settings.outputFolder, `${safeTitle} · ${suffix}.md`);
      if (existingPath) { if (!relative.endsWith('.md')) throw failure('只能绑定 Markdown 笔记'); await this.safePath(relative); }
      else {
        const base = relative.slice(0, -3); let counter = 2;
        while (await fs.access(await this.safePath(relative)).then(() => true, () => false)) relative = `${base} (${counter++}).md`;
      }
      if (this.state.notes.some(x => x.path === relative)) return this.state.notes.find(x => x.path === relative);
      const note = { id: randomUUID(), title: safeTitle, mode, path: relative, createdAt: new Date().toISOString(), drafts: [], sources: [], processed: {}, excluded: [], accepted: [], history: [], convertedFrom };
      if (existingPath) {
        const current = await this.read(note);
        if (mode === 'outline') validateOutline(current.text);
      } else await this.write(note, content ?? (mode === 'outline' ? `- ${safeTitle}\n` : `# ${safeTitle}\n`));
      this.state.notes.unshift(note); this.state.settings.targetNoteId = note.id; this.activity(`已建立${mode === 'outline' ? '大纲' : '普通'}笔记：${safeTitle}`); return note;
    });
  }
  publicNote(note) { return { id: note.id, title: note.title, mode: note.mode, path: note.path, createdAt: note.createdAt, draftCount: note.drafts.filter(x => x.status === 'pending').length, sourceCount: note.sources.length, convertedFrom: note.convertedFrom }; }
  async detail(id) { const note = this.note(id); return { ...this.publicNote(note), drafts: note.drafts, sources: note.sources, excludedCount: note.excluded.length, canUndo: note.history.length > 0, ...await this.read(note) }; }
  async addSource(id, payload) {
    return this.transact(async () => {
      const note = this.note(id), text = normalizeText(payload.text).slice(0, 150000);
      if (!text) throw failure('选取的内容为空');
      const externalId = String(payload.externalId || '').slice(0, 300);
      const url = String(payload.url || '').slice(0, 3000);
      if (url && !/^https?:\/\//i.test(url)) throw failure('来源链接格式无效');
      const digest = hash(`${payload.role || 'assistant'}\n${text}`);
      const found = externalId ? note.sources.find(x => x.externalId === externalId && x.url === url && !x.manual) : note.sources.find(x => x.fingerprint === digest && x.url === url && x.manual === !!payload.manual);
      if (found) { if (found.fingerprint !== digest) Object.assign(found, { text, fingerprint: digest, updatedAt: new Date().toISOString() }); return { source: found, duplicate: true }; }
      const source = { id: randomUUID(), externalId, text, role: payload.role === 'user' ? 'user' : 'assistant', url, platform: String(payload.platform || '手动导入').slice(0, 60), manual: !!payload.manual, fingerprint: digest, at: new Date().toISOString() };
      if (payload.conversationId) source.conversationId = String(payload.conversationId).slice(0, 100);
      if (payload.messageId) source.messageId = String(payload.messageId).slice(0, 100);
      note.sources.push(source); return { source, duplicate: false };
    });
  }
  async addManualDraft(id, source) {
    return this.transact(async () => {
      const note = this.note(id);
      const block = { heading: '', content: source.text, children: [], sourceIds: [source.id] };
      const draft = { id: randomUUID(), block, status: 'pending', manual: true, at: new Date().toISOString(), fingerprint: fingerprint(source.text) };
      const existing = note.drafts.find(x => x.fingerprint === draft.fingerprint && x.status !== 'rejected');
      if (existing) return existing;
      note.drafts.push(draft);
      return draft;
    });
  }
  async accept(id, ids, expectedHash) {
    return this.transact(async () => {
      const note = this.note(id), drafts = note.drafts.filter(x => ids.includes(x.id) && x.status === 'pending');
      if (!drafts.length) throw failure('没有待采纳的内容');
      const current = await this.read(note);
      if (expectedHash && expectedHash !== current.hash) throw failure('笔记已修改，请刷新后再采纳', 409);
      const blocks = drafts.map(x => x.block);
      const addition = note.mode === 'outline' ? serializeBlocks(blocks, note.mode, { title: note.title, includeTitle: true }).split('\n').slice(1).join('\n') : serializeBlocks(blocks, note.mode);
      const allSources = []; const collect = block => { allSources.push(...block.sourceIds); block.children.forEach(collect); }; blocks.forEach(collect);
      const sourceIds = [...new Set(allSources)];
      const sourceLinks = sourceIds.map(sid => note.sources.find(x => x.id === sid)).filter(x => x?.url);
      const unique = [...new Map(sourceLinks.map(x => [x.url, x])).values()];
      let footer = '';
      if (unique.length) footer = note.mode === 'outline' ? unique.map(x => `  - 来源：[${x.platform}](${x.url.replace(/\)/g, '%29')})`).join('\n') + '\n' : `\n来源：${unique.map(x => `[${x.platform}](${x.url.replace(/\)/g, '%29')})`).join(' · ')}\n`;
      const text = current.text.trimEnd() + (note.mode === 'outline' ? '\n' : '\n\n') + addition + footer;
      const updated = await this.write(note, text, current.hash);
      note.history.push({ text: current.text, afterHash: updated.hash, draftIds: drafts.map(x => x.id), at: new Date().toISOString() }); note.history = note.history.slice(-15);
      drafts.forEach(x => { x.status = 'accepted'; note.accepted.push({ fingerprint: x.fingerprint, block: x.block }); });
      this.activity(`已采纳 ${drafts.length} 条内容到「${note.title}」`); return updated;
    });
  }
  async reject(id, ids) {
    return this.transact(() => {
      const note = this.note(id);
      for (const draft of note.drafts.filter(x => ids.includes(x.id) && x.status === 'pending')) { draft.status = 'rejected'; note.excluded.push({ fingerprint: draft.fingerprint, heading: draft.block.heading, content: draft.block.content.slice(0, 1200) }); }
      this.activity('已忽略选中的草稿，后续整理将保留排除记录');
    });
  }
  async save(id, text, expectedHash) {
    return this.transact(async () => {
      const note = this.note(id), current = await this.read(note);
      if (typeof text !== 'string' || text.length > 2000000) throw failure('笔记内容过大或无效');
      const updated = await this.write(note, text, expectedHash || 'missing');
      note.history.push({ text: current.text, afterHash: updated.hash, draftIds: [], at: new Date().toISOString() }); note.history = note.history.slice(-15); return updated;
    });
  }
  async undo(id) {
    return this.transact(async () => {
      const note = this.note(id), previous = note.history.at(-1);
      if (!previous) throw failure('没有可撤销的操作');
      await this.write(note, previous.text, previous.afterHash);
      const restored = note.drafts.filter(x => previous.draftIds.includes(x.id));
      restored.forEach(x => { x.status = 'pending'; });
      note.accepted = note.accepted.filter(x => !restored.some(draft => draft.fingerprint === x.fingerprint));
      note.history.pop(); this.activity(`已撤销「${note.title}」的上次写入`);
    });
  }
  async color(id, { segments, color, expectedHash }) {
    return this.transact(async () => {
      const note = this.note(id), current = await this.read(note);
      if (!expectedHash || current.hash !== expectedHash) throw failure('笔记已变化，请刷新后重新选择颜色', 409);
      let text; try { text = colorize(current.text, segments, color); } catch (error) { throw failure(error.message); }
      const updated = await this.write(note, text, current.hash);
      note.history.push({ text: current.text, afterHash: updated.hash, draftIds: [], at: new Date().toISOString() }); note.history = note.history.slice(-15);
      return updated;
    });
  }
  async image(dataURL) {
    const match = String(dataURL).match(/^data:image\/(png|jpeg|webp|gif);base64,([a-zA-Z0-9+/=]+)$/);
    if (!match) throw failure('支持 PNG、JPEG、WebP 和 GIF 图片');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 15 * 1024 * 1024) throw failure('图片需小于 15MB');
    const magic = buffer.subarray(0, 12);
    if (!(match[1] === 'png' && magic.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || match[1] === 'jpeg' && magic[0] === 255 && magic[1] === 216 || match[1] === 'webp' && magic.toString('ascii', 0, 4) === 'RIFF' && magic.toString('ascii', 8, 12) === 'WEBP' || match[1] === 'gif' && /^GIF8[79]a/.test(magic.toString('ascii')))) throw failure('图片内容与声明格式不一致');
    const relative = path.posix.join(this.state.settings.outputFolder, '_attachments', `${hash(buffer).slice(0, 24)}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`);
    await fs.writeFile(await this.safePath(relative, true), buffer);
    return { path: relative, markdown: `![[${relative}]]` };
  }
}
