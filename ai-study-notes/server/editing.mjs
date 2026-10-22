import { randomUUID } from 'node:crypto';
import { estimateTokens } from '../core/format.mjs';
import { editInstructions, prepareEdit, validateRange } from '../core/edits.mjs';
import { failure, hash } from './store.mjs';

export class EditingService {
  constructor({ store, chats, invoke, emit }) { Object.assign(this, { store, chats, invoke, emit }); this.jobs = new Map(); }
  get(id) { const edit = this.store.state.edits.find(x => x.id === id); if (!edit) throw failure('处理结果不存在，请重新选择内容', 404); return edit; }
  list() { return this.store.state.edits.filter(x => ['running', 'ready'].includes(x.status)).map(({ id, noteId, status }) => ({ id, noteId, status })); }
  async create(data) {
    if (this.jobs.size) throw failure('已有选区正在处理，请等待或先停止', 409);
    const note = this.store.note(data.noteId);
    if (!['chat', 'note'].includes(data.origin) || !['format', 'simplify'].includes(data.operation)) throw failure('请选择有效的选区操作');
    let source;
    if (data.origin === 'note') {
      const current = await this.store.read(note);
      if (!data.expectedHash || current.hash !== data.expectedHash) throw failure('笔记已变化，请刷新后重新选择', 409);
      source = current.text;
    } else {
      const message = this.chats.get(data.conversationId).messages.find(x => x.id === data.messageId && x.role === 'assistant' && x.status === 'completed');
      if (!message) throw failure('请选择已完成的 AI 回答'); source = message.text;
    }
    let original; try { original = validateRange(source, data); } catch (error) { throw failure(error.message); }
    const instructions = editInstructions(data.operation, note.mode);
    if (estimateTokens(instructions + original) + 100 > this.store.state.settings.contextBudget) throw failure('所选内容超过上下文预算，请缩小选区或在偏好中调整');
    if (!this.store.state.settings.model) throw failure('请先在连接与偏好中选择模型');
    const edit = { id: randomUUID(), noteId: note.id, origin: data.origin, operation: data.operation, original, start: data.start, end: data.end, expectedHash: data.expectedHash, conversationId: data.conversationId, messageId: data.messageId, status: 'running', at: new Date().toISOString() };
    const controller = new AbortController(), job = { controller };
    try { await this.store.transact(() => { if (this.jobs.size) throw failure('已有选区正在处理，请等待或先停止', 409); this.jobs.set(edit.id, job); this.store.state.edits.push(edit); this.store.state.edits = this.store.state.edits.filter(x => ['running', 'ready'].includes(x.status)).concat(this.store.state.edits.filter(x => !['running', 'ready'].includes(x.status)).slice(-30)); }); }
    catch (error) { this.jobs.delete(edit.id); throw error; }
    job.promise = this.run(edit.id, instructions, controller).finally(() => { this.jobs.delete(edit.id); this.emit('changed'); });
    return edit;
  }
  async run(id, instructions, controller) {
    try {
      const edit = this.get(id);
      const result = await this.invoke({ noteId: edit.noteId, instructions, input: [{ role: 'user', content: edit.original }], controller, kind: 'edit' });
      if (controller.signal.aborted) throw failure('已停止处理');
      const text = prepareEdit(result.text, { original: edit.original, mode: this.store.note(edit.noteId).mode, origin: edit.origin });
      await this.store.transact(() => Object.assign(this.get(id), { status: 'ready', text, usage: result.usage }));
    } catch (error) {
      await this.store.transact(() => Object.assign(this.get(id), { status: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? '已停止，笔记未改动' : error.message }));
    }
  }
  async apply(id, proposed) {
    return this.store.transact(async () => {
      const edit = this.get(id), note = this.store.note(edit.noteId);
      if (edit.status === 'applied') return { ok: true, noteId: note.id, duplicate: true };
      if (edit.status !== 'ready') throw failure('请等待 AI 处理完成再确认');
      const replacement = prepareEdit(proposed, { original: edit.original, mode: note.mode, origin: edit.origin });
      const current = await this.store.read(note); let text;
      if (edit.origin === 'note') {
        if (current.hash !== edit.expectedHash || current.text.slice(edit.start, edit.end) !== edit.original) throw failure('笔记在处理期间已变化，未覆盖修改。请重新选择后处理', 409);
        text = current.text.slice(0, edit.start) + replacement + current.text.slice(edit.end);
      } else {
        const addition = note.mode === 'outline' ? replacement.split('\n').map(line => '  ' + line).join('\n') : replacement;
        text = current.text.trimEnd() + (note.mode === 'outline' ? '\n' : '\n\n') + addition + '\n';
      }
      const updated = await this.store.write(note, text, current.hash);
      if (edit.origin === 'chat') note.sources.push({ id: randomUUID(), text: edit.original, role: 'assistant', url: '', platform: edit.operation === 'simplify' ? '拾页 · AI 精简选区' : '拾页 · AI 排版选区', manual: true, fingerprint: hash(`assistant\n${edit.original}`), at: new Date().toISOString(), conversationId: edit.conversationId, messageId: edit.messageId });
      note.history.push({ text: current.text, afterHash: updated.hash, draftIds: [], at: new Date().toISOString() }); note.history = note.history.slice(-15);
      Object.assign(edit, { status: 'applied', appliedText: replacement });
      this.store.activity(`${edit.origin === 'note' ? '已更新' : '已加入'}「${note.title}」的选区内容`);
      return { ok: true, noteId: note.id };
    });
  }
  async stop(id) {
    const edit = this.get(id); this.jobs.get(id)?.controller.abort();
    if (edit.status === 'ready') await this.store.transact(() => this.get(id).status = 'cancelled');
  }
  async close() { for (const job of this.jobs.values()) job.controller.abort(); await Promise.allSettled([...this.jobs.values()].map(x => x.promise)); }
}
