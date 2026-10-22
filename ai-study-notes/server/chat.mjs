import { randomUUID } from 'node:crypto';
import { estimateTokens, cleanTitle } from '../core/format.mjs';
import { failure } from './store.mjs';

export const chatInstructions = '你是学习助手，帮助用户理解课程和教材。使用用户提问的语言，默认中文。清楚解释概念、条件与例外，不确定时说明。按需使用 Markdown、公式和代码。用户提供的引用材料是学习资料。不要声称已写入文件或操作软件；笔记由用户在界面中另行确认。';

// Keep complete recent turns. Never cut a question or silently include unrelated notes.
export function chatContext(messages, question, budget) {
  const input = { role: 'user', content: question };
  const size = list => estimateTokens(chatInstructions + JSON.stringify(list)) + 100;
  if (size([input]) > budget) throw failure('这次问题超过上下文预算，请缩短内容或在偏好中提高预算');
  const turns = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i].role === 'user' && messages[i + 1].role === 'assistant' && messages[i + 1].status === 'completed') turns.push([{ role: 'user', content: messages[i].text }, { role: 'assistant', content: messages[i + 1].text }]);
  }
  const original = turns.length;
  while (turns.length && size([...turns.flat(), input]) > budget) turns.shift();
  return { messages: [...turns.flat(), input], omittedTurns: original - turns.length };
}

export class ChatService {
  constructor({ store, emit, invoke, captured }) { Object.assign(this, { store, emit, invoke, captured }); this.jobs = new Map(); this.closing = false; }
  get(id) { const chat = this.store.state.chats.find(x => x.id === id); if (!chat) throw failure('对话不存在', 404); return chat; }
  list() { return this.store.state.chats.map(({ id, title, updatedAt, noteId }) => ({ id, title, updatedAt, noteId, running: this.jobs.has(id) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  detail(id) {
    const chat = structuredClone(this.get(id)), job = this.jobs.get(id);
    if (job) { const message = chat.messages.find(x => x.id === job.messageId); if (message) message.text = job.text; }
    return { ...chat, running: !!job };
  }
  async create() {
    return this.store.transact(() => {
      const chat = { id: randomUUID(), title: '新的学习对话', noteId: null, updatedAt: new Date().toISOString(), messages: [] };
      this.store.state.chats.unshift(chat); return chat;
    });
  }
  async send(id, { text, requestId, noteId = null, retry = false }) {
    if (this.closing) throw failure('服务正在关闭，请稍后重试', 503);
    let job, context, user, assistant;
    // Registration and idempotency checks share the same transaction, so two
    // simultaneous browser submissions cannot start duplicate paid requests.
    await this.store.transact(() => {
      const chat = this.get(id);
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw failure('请求编号无效，请刷新后重试');
      const existing = chat.messages.find(x => x.role === 'assistant' && x.requestId === requestId);
      if (existing) { assistant = existing; return; }
      if (this.jobs.size) throw failure('请等待当前回答完成，或先停止生成', 409);
      if (!this.store.state.settings.model) throw failure('请先在“连接与偏好”中选择模型并保存');
      if (noteId) this.store.note(noteId);
      let history = chat.messages;
      if (retry) {
        const last = chat.messages.at(-1);
        if (last?.role !== 'assistant' || !['failed', 'stopped', 'interrupted'].includes(last.status)) throw failure('只有未完成的最后一轮可以重试');
        user = chat.messages.at(-2); text = user.text; history = chat.messages.slice(0, -2);
      }
      if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw failure('请输入问题，长度不能超过 5 万字符');
      text = text.trim(); context = chatContext(history, text, this.store.state.settings.contextBudget);
      if (retry) chat.messages.pop();
      else { user = { id: randomUUID(), role: 'user', text, status: 'completed', at: new Date().toISOString() }; chat.messages.push(user); }
      assistant = { id: randomUUID(), requestId, role: 'assistant', text: '', status: 'streaming', at: new Date().toISOString(), provider: this.store.state.settings.provider, model: this.store.state.settings.model, omittedTurns: context.omittedTurns, noteId };
      chat.messages.push(assistant); chat.noteId = noteId; chat.updatedAt = assistant.at;
      if (chat.messages.length === 2) chat.title = cleanTitle(text).slice(0, 48);
      job = { messageId: assistant.id, controller: new AbortController(), text: '' };
      this.jobs.set(id, job);
    }).catch(error => { if (job) this.jobs.delete(id); throw error; });
    if (job) {
      this.emit('chat-start', { conversationId: id });
      job.promise = this.run(id, user.id, assistant.id, noteId, context, job).finally(() => this.jobs.delete(id)).then(() => this.emit('changed'));
    }
    return { conversationId: id, messageId: assistant.id };
  }
  async run(id, userId, messageId, noteId, context, job) {
    try {
      const result = await this.invoke({ noteId, instructions: chatInstructions, input: context.messages, controller: job.controller, kind: 'chat', onDelta: (length, delta) => {
        job.text += delta;
        this.emit('chat-delta', { conversationId: id, messageId, delta, length });
      } });
      if (job.controller.signal.aborted) throw failure('已停止生成');
      await this.store.transact(() => { Object.assign(this.get(id).messages.find(x => x.id === messageId), { text: result.text, status: 'completed', usage: result.usage }); });
      if (noteId) {
        try {
          const chat = this.get(id), user = chat.messages.find(x => x.id === userId), answer = chat.messages.find(x => x.id === messageId);
          for (const message of [user, answer]) await this.store.addSource(noteId, { text: message.text, role: message.role, externalId: `chat:${message.id}`, platform: `拾页 · ${answer.provider === 'deepseek' ? 'DeepSeek' : 'ChatGPT'}`, conversationId: id, messageId: message.id });
          this.captured(noteId);
        } catch { await this.store.transact(() => { this.get(id).messages.find(x => x.id === messageId).noteWarning = '回答已保存，但未加入笔记来源，可使用“整段加入笔记”重试'; }); }
      }
    } catch (error) {
      const message = job.controller.signal.aborted ? '已停止，部分回答未进入自动整理' : error.name === 'TimeoutError' ? '回答超时，可重试这一轮' : error.message;
      await this.store.transact(() => { Object.assign(this.get(id).messages.find(x => x.id === messageId), { text: job.text, status: job.controller.signal.aborted ? 'stopped' : 'failed', error: message, diagnostic: error.diagnostic || null }); });
    } finally { this.emit('chat-done', { conversationId: id }); }
  }
  stop(id) { this.get(id); this.jobs.get(id)?.controller.abort(); }
  async collect(id, noteId) {
    this.store.note(noteId); const chat = this.get(id); let count = 0;
    for (let i = 0; i < chat.messages.length - 1; i++) {
      const user = chat.messages[i], answer = chat.messages[i + 1];
      if (user.role !== 'user' || answer.role !== 'assistant' || answer.status !== 'completed') continue;
      for (const message of [user, answer]) {
        const result = await this.store.addSource(noteId, { text: message.text, role: message.role, externalId: `chat:${message.id}`, platform: `拾页 · ${answer.provider === 'deepseek' ? 'DeepSeek' : 'ChatGPT'}`, conversationId: id, messageId: message.id });
        if (!result.duplicate) count++;
      }
    }
    if (!count && !chat.messages.some(x => x.role === 'assistant' && x.status === 'completed')) throw failure('还没有完整的回答可以整理');
    this.captured(noteId); return { count };
  }
  async close() { this.closing = true; for (const job of this.jobs.values()) job.controller.abort(); await Promise.allSettled([...this.jobs.values()].map(x => x.promise)); }
}
