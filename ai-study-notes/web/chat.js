export function createChatUI({ request, toast, element, renderMarkdown, getState, getNoteId, refresh, openSettings, isDirty }) {
  const $ = selector => document.querySelector(selector), log = $('#chat-messages');
  let conversation = null, conversationId = null, submitting = false, selectedText = null, loadVersion = 0, syncing = false;
  const nodes = new Map(), drafts = new Map(), pendingSends = new Map();
  try { conversationId = localStorage.getItem('shiye-chat'); } catch {}
  const remember = () => { try { if (conversationId) localStorage.setItem('shiye-chat', conversationId); } catch {} };
  const action = (selector, event, fn) => $(selector).addEventListener(event, value => { try { Promise.resolve(fn(value)).catch(error => toast(error.message, true)); } catch (error) { toast(error.message, true); } });
  function targetLabel() {
    const state = getState(), note = state?.notes.find(x => x.id === getNoteId());
    $('#chat-target-label').textContent = note ? `本轮整理到：${note.title} · ${note.mode === 'outline' ? '大纲' : '普通笔记'}` : '可先聊天，再建立笔记';
    $('#collect-chat').disabled = !conversation?.messages.some(x => x.status === 'completed' && x.role === 'assistant') || !note;
    const provider = state?.settings.provider, label = provider === 'deepseek' ? 'DeepSeek' : provider === 'openai' ? 'OpenAI API' : 'ChatGPT';
    $('#chat-model').textContent = state?.settings.model ? `${label} · ${state.settings.model}` : `连接 ${label}`;
    const busy = submitting || conversation?.running;
    $('#send-chat').disabled = !!busy; $('#stop-chat').hidden = !conversation?.running;
    $('#chat-hint').textContent = conversation?.running ? '正在回答；完成后可摘录或整理' : 'Enter 发送 · Shift + Enter 换行';
  }
  function clearSelection() { selectedText = null; $('#chat-selection-bar').hidden = true; }
  async function clip(text, messageId) {
    const noteId = getNoteId();
    if (!noteId) throw new Error('请先新建或选择右侧的目标笔记');
    if (isDirty()) throw new Error('请先保存右侧的 Markdown 修改，再加入摘录');
    await request('/api/capture', 'POST', { noteId, text, manual: true, platform: '拾页对话摘录', conversationId, messageId });
    clearSelection(); await refresh(); toast('原文已加入笔记，未调用 AI');
  }
  function draw() {
    if (!conversation) { targetLabel(); return; }
    log.dataset.conversationId = conversation.id;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
    if (conversation.messages.length) $('.chat-welcome')?.remove();
    else if (!$('.chat-welcome')) { const welcome = element('div', 'chat-welcome'); welcome.append(element('span', '', '✳'), element('h2', '', '从一个问题开始。'), element('p', '', '在这里与 AI 对话，右侧留下你的理解。')); log.append(welcome); }
    for (const [id, node] of nodes) if (!conversation.messages.some(x => x.id === id)) { node.remove(); nodes.delete(id); }
    for (const message of conversation.messages) {
      let node = nodes.get(message.id);
      if (!node) { node = element('article', `chat-message ${message.role}`); node.dataset.messageId = message.id; nodes.set(message.id, node); log.append(node); }
      node.dataset.status = message.status;
      const signature = `${message.status}\n${message.text}\n${message.error || ''}\n${message.noteWarning || ''}\n${message.id === conversation.messages.at(-1)?.id}`;
      if (node.signature === signature) continue;
      node.signature = signature; node.replaceChildren();
      const header = element('header', 'message-label', message.role === 'user' ? '你' : `${message.provider === 'deepseek' ? 'DeepSeek' : message.provider === 'openai' ? 'OpenAI' : 'ChatGPT'} · ${message.model}`);
      const body = element('div', `message-body${message.role === 'assistant' ? ' prose' : ''}`);
      if (message.status === 'streaming') { body.classList.add('streaming-text'); body.textContent = message.text || '正在思考…'; }
      else if (message.role === 'assistant') renderMarkdown(message.text, body);
      else body.textContent = message.text;
      node.append(header, body);
      if (message.role === 'assistant') {
        if (message.omittedTurns) node.append(element('small', 'message-context', `本轮按预算省略了较早的 ${message.omittedTurns} 轮上下文；历史记录仍保留。`));
        if (message.error || message.noteWarning) node.append(element('p', 'message-error', message.error === 'fetch failed' ? '上次连接 AI 时网络请求失败，请检查代理节点后重试。' : message.error || message.noteWarning));
        const tools = element('footer', 'message-tools');
        if (message.diagnostic?.kind === 'network' || message.error === 'fetch failed') { const check = element('button', 'quiet', '检查网络连接'); check.addEventListener('click', () => openSettings()); tools.append(check); }
        if (message.text && message.status !== 'streaming') {
          const copy = element('button', 'quiet', '复制'), add = element('button', 'quiet', message.status === 'completed' ? '整段加入笔记 ↗' : '摘录部分回答 ↗');
          copy.addEventListener('click', () => navigator.clipboard.writeText(message.text).then(() => toast('已复制回答')).catch(() => toast('复制失败，请手动选择文字', true)));
          add.addEventListener('click', () => clip(message.text, message.id).catch(error => toast(error.message, true))); tools.append(copy, add);
        }
        if (message.id === conversation.messages.at(-1)?.id && ['failed', 'stopped', 'interrupted'].includes(message.status)) {
          const retry = element('button', 'quiet', '重试这一轮'); retry.addEventListener('click', () => send(true).catch(error => toast(error.message, true))); tools.append(retry);
        }
        if (message.usage) tools.append(element('small', '', `${message.usage.estimated ? '约 ' : ''}${message.usage.input + message.usage.output} token`));
        node.append(tools);
      }
    }
    targetLabel(); if (nearBottom || submitting) log.scrollTop = log.scrollHeight;
  }
  async function load(id) {
    const version = ++loadVersion, result = await request(`/api/chats/${id}`);
    if (version !== loadVersion || id !== conversationId) return;
    if (conversation?.id === id) for (const message of result.messages) {
      const old = conversation.messages.find(x => x.id === message.id);
      if (message.status === 'streaming' && old?.text.length > message.text.length) message.text = old.text;
    }
    conversation = result; draw();
  }
  async function choose(id) {
    if (conversationId) drafts.set(conversationId, $('#chat-input').value);
    conversationId = id; conversation = null; ++loadVersion; nodes.clear(); log.replaceChildren(); clearSelection(); remember();
    $('#chat-input').value = drafts.get(id) || '';
    await load(id); log.scrollTop = log.scrollHeight;
  }
  async function send(retry = false) {
    if (submitting || conversation?.running) return;
    const text = $('#chat-input').value.trim(), state = getState();
    if (!retry && !text) return;
    if (!state.settings.model || (state.settings.provider === 'chatgpt' ? !state.account.connected : !state.hasApiKey)) { openSettings(); throw new Error('先连接所选服务，读取模型并保存偏好，即可在这里聊天'); }
    submitting = true; targetLabel();
    try {
      if (!conversationId) { const created = await request('/api/chats', 'POST', {}); await choose(created.id); }
      // Retain the same request ID if a browser network failure makes delivery uncertain.
      const pending = pendingSends.get(conversationId);
      const payload = pending && pending.text === text && pending.retry === retry ? pending : { text, retry, noteId: getNoteId(), requestId: crypto.randomUUID() };
      pendingSends.set(conversationId, payload);
      await request(`/api/chats/${conversationId}/send`, 'POST', payload);
      pendingSends.delete(conversationId);
      if (!retry) { $('#chat-input').value = ''; drafts.delete(conversationId); }
      await load(conversationId); await refresh();
    } catch (error) { if (error.status) pendingSends.delete(conversationId); if (!retry && !$('#chat-input').value) $('#chat-input').value = text; throw error; }
    finally { submitting = false; targetLabel(); }
  }
  async function sync(state) {
    const history = $('#chat-history'); history.replaceChildren();
    if (!state.chats.length) { const option = element('option', '', '新的学习对话'); option.value = ''; history.append(option); }
    for (const chat of state.chats) { const option = element('option', '', `${chat.running ? '◌ ' : ''}${chat.title}`); option.value = chat.id; history.append(option); }
    if (!conversationId && state.chats.length) conversationId = state.chats[0].id;
    if (conversationId && !state.chats.some(x => x.id === conversationId)) conversationId = state.chats[0]?.id || null;
    history.value = conversationId || ''; targetLabel();
    if (conversationId && !syncing) { syncing = true; try { await load(conversationId); } finally { syncing = false; } }
  }
  function onEvent(event) {
    if (!event.type.startsWith('chat-')) return;
    if (event.conversationId !== conversationId) return;
    if (event.type === 'chat-delta') {
      const message = conversation?.messages.find(x => x.id === event.messageId);
      if (!message) { if (!syncing) { syncing = true; load(conversationId).catch(() => {}).finally(() => syncing = false); } return; }
      const offset = event.length - event.delta.length;
      if (message.text.length >= offset) { message.text += event.delta.slice(Math.max(0, message.text.length - offset)); draw(); }
    } else load(conversationId).catch(() => {});
  }
  function captureSelection() {
    const selection = window.getSelection();
    const parent = selection?.anchorNode?.parentElement?.closest('.chat-message.assistant'), end = selection?.focusNode?.parentElement?.closest('.chat-message.assistant');
    const text = selection?.toString().trim();
    if (!text || !parent || parent !== end || parent.querySelector('.streaming-text')) { clearSelection(); return; }
    selectedText = { text, messageId: parent.dataset.messageId }; $('#chat-selection-label').textContent = `已选取 ${text.length} 个字符`; $('#chat-selection-bar').hidden = false;
  }
  log.addEventListener('pointerup', captureSelection); log.addEventListener('keyup', captureSelection);
  $('#clip-chat-selection').addEventListener('pointerdown', event => event.preventDefault());
  action('#clip-chat-selection', 'click', () => selectedText && clip(selectedText.text, selectedText.messageId));
  action('#clear-chat-selection', 'click', clearSelection);
  action('#chat-form', 'submit', event => { event.preventDefault(); return send(); });
  action('#chat-input', 'keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); return send(); } });
  action('#stop-chat', 'click', async () => { if (conversationId) await request(`/api/chats/${conversationId}/stop`, 'POST', {}); });
  action('#new-chat', 'click', async () => {
    if (submitting) return; submitting = true; $('#chat-input').disabled = true; $('#new-chat').disabled = true; targetLabel();
    try { const chat = await request('/api/chats', 'POST', {}); await choose(chat.id); await refresh(); }
    finally { submitting = false; $('#chat-input').disabled = false; $('#new-chat').disabled = false; targetLabel(); $('#chat-input').focus(); }
  });
  action('#chat-history', 'change', event => choose(event.target.value));
  action('#chat-model', 'click', () => openSettings());
  action('#collect-chat', 'click', async () => {
    if (!getNoteId() || !conversationId) return;
    const result = await request(`/api/chats/${conversationId}/collect`, 'POST', { noteId: getNoteId() }); await refresh();
    toast(getState().settings.autoSummary ? '完整对话已进入整理来源，将自动生成草稿' : `已加入整理来源${result.count ? ` ${result.count} 条` : ''}，点击右侧“整理新增对话”生成草稿`);
  });
  return { sync, onEvent, async open(id) { await choose(id); await refresh(); } };
}
