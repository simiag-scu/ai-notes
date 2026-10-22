import { createChatUI } from './chat.js';
import { createMarkdownRenderer, stripColorSpans } from './markdown.js';
import { createSelectionMenu } from './selection-menu.js';
import { initializeDesktop } from './desktop.js';
const $ = selector => document.querySelector(selector);
const extension = typeof chrome !== 'undefined' && !!chrome.runtime?.id && location.protocol === 'chrome-extension:';
let bridgeToken = '', apiBase = extension ? 'http://127.0.0.1:17861' : '', appState = null, activeId = null, activeNote = null, dirty = false, view = 'preview', toastTimer, refreshTimer, eventController;
const selected = new Set();
const renderer = createMarkdownRenderer({ element, noteURL, loadAsset });
const chatUI = createChatUI({ request, toast, element, renderMarkdown, getState: () => appState, getNoteId: () => activeId, refresh, openSettings, isDirty: () => dirty });
const selectionMenu = createSelectionMenu({ element, request, toast, refresh, renderMarkdown, renderer, getNote: () => activeNote, isDirty: () => dirty, requireNote });
const authNotice = document.createElement('p'); authNotice.id = 'auth-notice'; authNotice.className = 'auth-notice'; authNotice.hidden = true; authNotice.setAttribute('role', 'alert');
$('#settings-account .account-card').after(authNotice);
const localFileMode = document.createElement('button'); localFileMode.id = 'local-file-mode'; localFileMode.className = 'button subtle'; localFileMode.textContent = '切回本地文件模式'; localFileMode.hidden = true;
$('#vault-info').after(localFileMode);
localFileMode.addEventListener('click', async () => { try { await request('/api/obsidian/disconnect', 'POST', {}); await refresh(); openSettings('connection'); toast('已切回本地文件模式'); } catch (error) { toast(error.message, true); } });
const niceNumber = n => new Intl.NumberFormat('zh-CN').format(n || 0);
const modeLabel = mode => mode === 'outline' ? '大纲 Markdown' : '普通 Markdown';
function markDirty(value) { dirty = value; window.shiyeDesktop?.setDirty(value); }
function element(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = text; return item; }
const networkBox = element('div', 'network-card'); networkBox.id = 'network-settings';
const networkModeLabel = element('label', '', '后台联网方式'), networkMode = element('select'); networkMode.id = 'network-mode';
for (const [value, label] of [['auto', '自动跟随环境与系统代理'], ['manual', '指定本机代理'], ['direct', '使用系统网络']]) { const option = element('option', '', label); option.value = value; networkMode.append(option); }
networkModeLabel.append(networkMode);
const networkURLLabel = element('label', '', 'HTTP / Mixed 代理地址'), networkURL = element('input'); networkURL.id = 'network-url'; networkURL.type = 'url'; networkURL.placeholder = '例如 http://127.0.0.1:7897'; networkURLLabel.append(networkURL);
const networkActions = element('div', 'network-actions'), saveNetwork = element('button', 'button subtle', '保存网络连接'), checkNetwork = element('button', 'button subtle', '检查连接');
saveNetwork.type = checkNetwork.type = 'button'; saveNetwork.id = 'save-network'; checkNetwork.id = 'check-network'; networkActions.append(saveNetwork, checkNetwork);
const networkStatus = element('p', 'help-text'); networkStatus.id = 'network-status';
networkBox.append(networkModeLabel, networkURLLabel, networkActions, networkStatus); $('#settings-form').before(networkBox);
networkMode.addEventListener('change', () => { networkURLLabel.hidden = networkMode.value !== 'manual'; });
saveNetwork.addEventListener('click', async () => { saveNetwork.disabled = true; try { await request('/api/network', 'POST', { mode: networkMode.value, proxyUrl: networkURL.value.trim() }); await refresh(); toast('后台网络已保存，下一次请求立即生效'); } catch (error) { toast(error.message, true); } finally { saveNetwork.disabled = false; } });
checkNetwork.addEventListener('click', async () => { checkNetwork.disabled = saveNetwork.disabled = true; networkStatus.textContent = '正在检查所选 AI 服务的网络连接…'; try { const result = await request('/api/network/check', 'POST', {}); networkStatus.textContent = result.results.map(x => `${x.name}：${x.ok ? '正常' : x.error || `HTTP ${x.status}`}`).join('；'); toast(result.ok ? '所选 AI 服务网络连通，可以返回对话重试' : '连接未通过，请查看网络检查结果', !result.ok); } catch (error) { networkStatus.textContent = error.message; toast(error.message, true); } finally { checkNetwork.disabled = saveNetwork.disabled = false; } });
function toast(message, error = false) { clearTimeout(toastTimer); const node = $('#toast'); node.textContent = message; node.className = `show${error ? ' error' : ''}`; toastTimer = setTimeout(() => node.className = '', error ? 6500 : 3200); }
function listen(selector, event, callback) { $(selector).addEventListener(event, value => { try { Promise.resolve(callback(value)).catch(error => toast(error.message || '操作未完成', true)); } catch (error) { toast(error.message || '操作未完成', true); } }); }
async function request(route, method = 'GET', data) {
  let response;
  try { response = await fetch(`${apiBase}${route}`, { method, headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}), credentials: extension ? 'omit' : 'same-origin' }); }
  catch { throw new Error('无法连接本机工作台，请确认启动窗口仍在运行，再刷新页面'); }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(!extension && response.status === 401 ? '工作台连接已失效，请刷新页面后再试' : result.error || '连接失败'), { status: response.status });
  return result;
}
function noteURL(filename) { return `obsidian://open?vault=${encodeURIComponent(appState?.connection.vault || 'Mynotes')}&file=${encodeURIComponent(filename)}`; }
function safeLink(value) { return /^(https?:\/\/|obsidian:\/\/)/i.test(value); }
function loadAsset(file, image) {
  fetch(`${apiBase}/api/assets?path=${encodeURIComponent(file)}`, { headers: bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {}, credentials: extension ? 'omit' : 'same-origin' }).then(r => { if (!r.ok) throw new Error(); return r.blob(); }).then(blob => { const url = URL.createObjectURL(blob); image.onload = () => URL.revokeObjectURL(url); image.src = url; }).catch(() => image.replaceWith(element('span', 'empty-copy', `图片请在 Obsidian 查看：${file}`)));
}
function renderMarkdown(text, target) { renderer.render(text, target); }
async function refresh({ detail = true } = {}) {
  appState = await request('/api/state');
  const route = appState.connection.network;
  networkBox.hidden = !route?.available;
  if (route?.available) { if (!networkBox.contains(document.activeElement)) { networkMode.value = route.mode; networkURL.value = route.proxyUrl || ''; networkURLLabel.hidden = route.mode !== 'manual'; } networkStatus.textContent = `当前：${route.source}${route.proxyUrl ? ` · ${route.proxyUrl}` : ''}。本机工作台与 Obsidian 连接始终保留在本机。`; }
  authNotice.textContent = appState.account.lastError?.message || ''; authNotice.hidden = !appState.account.lastError;
  $('#connection-label').textContent = appState.connection.obsidian ? 'Obsidian 原生连接' : '本地文件模式';
  $('#note-total').textContent = appState.notes.length;
  $('#auto-summary').checked = appState.settings.autoSummary;
  const used = appState.usage.input + appState.usage.output;
  $('#usage-number').textContent = niceNumber(used);
  $('#usage-meter').style.width = `${Math.min(100, used / appState.settings.dailyTokenBudget * 100)}%`;
  $('#usage-description').textContent = `${appState.usage.estimated ? '含估算 · ' : ''}${appState.usage.calls} 次 AI 请求 · 预算 ${niceNumber(appState.settings.dailyTokenBudget)} token`;
  renderLibrary();
  if (!activeId && appState.notes.length) activeId = appState.settings.targetNoteId || appState.notes[0].id;
  if (detail && activeId && !dirty) await loadNote(activeId);
  else if (detail && activeId && dirty && activeNote) {
    const latest = await request(`/api/notes/${activeId}`);
    // Update review metadata while preserving the editor buffer and the hash it
    // was based on. Saving still detects external changes instead of overwriting.
    activeNote = { ...latest, text: activeNote.text, hash: activeNote.hash };
    $('#source-count').textContent = latest.sources.length; renderDrafts(); renderSources();
  }
  $('#welcome').hidden = !!activeId; $('#note-workspace').hidden = !activeId;
  await chatUI.sync(appState);
  selectionMenu.sync(appState);
}
function renderLibrary() {
  const target = $('#note-list'); target.replaceChildren();
  for (const note of appState.notes) {
    const button = element('button', `note-item${note.id === activeId ? ' active' : ''}`); button.setAttribute('aria-pressed', String(note.id === activeId));
    button.append(element('span', 'note-icon', note.mode === 'outline' ? '☷' : '▤'));
    const group = element('span'); group.append(element('strong', '', note.title), element('small', '', `${note.mode === 'outline' ? '大纲' : '普通笔记'}${note.draftCount ? ` · ${note.draftCount} 条待采纳` : ''}`)); button.append(group);
    button.addEventListener('click', async () => {
      try {
        if (dirty) { toast('请先保存源文修改，再切换笔记', true); return; }
        activeId = note.id; selected.clear(); await request('/api/settings', 'POST', { targetNoteId: note.id }); await refresh();
      } catch (error) { toast(error.message, true); }
    }); target.append(button);
  }
}
async function loadNote(id) {
  activeNote = await request(`/api/notes/${id}`); activeId = id;
  $('#note-title').textContent = activeNote.title; $('#note-kind').textContent = activeNote.mode === 'outline' ? 'OUTLINE NOTE / 大纲模式' : 'MARKDOWN NOTE / 普通模式';
  $('#note-path').textContent = activeNote.path;
  $('#editor').value = activeNote.text; renderMarkdown(activeNote.text, $('#preview'));
  $('#word-count').textContent = `${niceNumber(activeNote.text.replace(/\s/g, '').length)} 字符`;
  $('#save-state').textContent = activeNote.native ? '已连接 Obsidian 原生编辑器' : '已保存在本机 · 完整效果在 Obsidian 阅读';
  $('#open-obsidian').href = noteURL(activeNote.path); $('#undo-note').disabled = !activeNote.canUndo;
  $('#copy-note').textContent = activeNote.mode === 'outline' ? '复制到幕布' : '复制 Markdown';
  $('#source-count').textContent = activeNote.sources.length;
  renderDrafts(); renderSources(); renderLibrary();
  $('#welcome').hidden = true; $('#note-workspace').hidden = false;
  const job = appState.jobs.find(x => x.noteId === id);
  if (job) showJob(job.type === 'conversion' ? '正在生成另一种笔记版本…' : '正在整理新增对话…');
  else if (!$('#job-status').classList.contains('error')) { $('#job-status').hidden = true; $('#stop-job').hidden = true; }
}
function renderDrafts() {
  const pending = activeNote.drafts.filter(x => x.status === 'pending'); $('#draft-count').textContent = pending.length;
  $('#pending-badge').textContent = pending.length;
  const picked = pending.filter(x => selected.has(x.id)).length;
  $('#select-all').checked = pending.length > 0 && picked === pending.length; $('#select-all').indeterminate = picked > 0 && picked < pending.length;
  const target = $('#draft-list'); target.replaceChildren();
  if (!pending.length) { const empty = element('div', 'draft-empty'); empty.append(element('span', '', '✧'), element('h3', '', '给理解留一点空间。'), element('p', '', '采集新对话后，草稿会出现在这里。\n原文摘录可以直接加入笔记。')); target.append(empty); return; }
  for (const draft of pending) {
    const card = element('article', 'draft-card'), head = element('div', 'draft-card-head'), checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(draft.id); checkbox.setAttribute('aria-label', `选择草稿：${draft.block.heading || '原文摘录'}`); checkbox.addEventListener('change', () => checkbox.checked ? selected.add(draft.id) : selected.delete(draft.id));
    head.append(checkbox, element('h3', '', draft.block.heading || '原文摘录')); card.append(head);
    const texts = []; function collect(block) { if (block.content) texts.push(block.content); for (const child of block.children) { if (child.heading) texts.push(child.heading); collect(child); } } collect(draft.block);
    card.append(element('div', 'draft-body', texts.join('\n')));
    const meta = element('div', 'draft-meta'); meta.append(element('span', 'draft-tag', draft.manual ? '手动摘录' : 'AI 草稿'));
    const refs = [...new Set(draft.block.sourceIds)].map(id => activeNote.sources.find(x => x.id === id)).filter(Boolean);
    if (refs.length) { const source = element('button', 'quiet', `来源 ${refs.length}`); source.addEventListener('click', () => { showView('sources'); }); meta.append(source); }
    const accept = element('button', 'quiet accept-one', '采纳 ↗'); accept.addEventListener('click', () => acceptDrafts([draft.id]).catch(error => toast(error.message, true))); meta.append(accept); card.append(meta); target.append(card);
  }
}
function renderSources() {
  const target = $('#source-cards'); target.replaceChildren();
  if (!activeNote.sources.length) { target.append(element('p', 'empty-copy', '还没有采集内容。可以安装浏览器扩展，或点击上方“加入学习片段”。')); return; }
  for (const source of [...activeNote.sources].reverse()) {
    const card = element('article', 'source-card'), head = element('header'); head.append(element('span', 'draft-tag', source.platform), element('span', '', source.role === 'user' ? '你的问题' : source.manual ? '手动摘录' : 'AI 回答'), element('time', '', new Date(source.at).toLocaleString('zh-CN'))); card.append(head, element('pre', '', source.text));
    const footer = element('footer'); if (source.conversationId) { const link = element('button', 'quiet', '回到工作台对话 ↗'); link.addEventListener('click', () => chatUI.open(source.conversationId).catch(error => toast(error.message, true))); footer.append(link); }
    else if (source.url && safeLink(source.url)) { const link = element('a', '', '回到原对话 ↗'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; footer.append(link); }
    const exclude = element('button', 'quiet', source.excluded ? '已排除整理' : '不再用于整理'); exclude.disabled = !!source.excluded; exclude.addEventListener('click', async () => { try { await request(`/api/notes/${activeId}/exclude-source`, 'POST', { sourceId: source.id }); await refresh(); } catch (error) { toast(error.message, true); } }); footer.append(exclude); card.append(footer); target.append(card);
  }
}
function showView(value) { view = value; $('#preview').hidden = value !== 'preview'; $('#source-editor').hidden = value !== 'source'; $('#source-cards').hidden = value !== 'sources'; for (const [id, name] of [['preview-tab', 'preview'], ['source-tab', 'source'], ['sources-tab', 'sources']]) $(`#${id}`).classList.toggle('active', value === name); }
async function acceptDrafts(ids) { if (!activeId) return; if (dirty) throw new Error('请先保存源文修改'); await request(`/api/notes/${activeId}/accept`, 'POST', { ids, expectedHash: activeNote.hash }); selected.clear(); await refresh(); toast('已加入笔记'); }
function showJob(message, error = false) { const status = $('#job-status'); status.hidden = false; status.textContent = message; status.classList.toggle('error', error); $('#stop-job').hidden = error; }
function settingsTab(value) { $('#settings-account').hidden = value !== 'account'; $('#settings-connection').hidden = value !== 'connection'; document.querySelectorAll('[data-settings]').forEach(button => button.classList.toggle('active', button.dataset.settings === value)); }
function openSettings(tab = 'account') {
  if (appState) {
    const settings = appState.settings; $('#provider').value = settings.provider; $('#model').value = settings.model; $('#context-budget').value = settings.contextBudget; $('#daily-budget').value = settings.dailyTokenBudget; $('#calls-limit').value = settings.callsPerHour; $('#output-folder').value = settings.outputFolder;
    $('#account-label').textContent = appState.account.connected ? `已连接 ${appState.account.email || 'ChatGPT 账号'}` : '尚未连接 ChatGPT';
    $('#account-description').textContent = appState.account.connected ? `凭据保存在${appState.account.storage}，不会传入浏览器。` : '通过官方页面登录，授权使用现有套餐。';
    $('#disconnect-chatgpt').hidden = !appState.account.connected; $('#connect-chatgpt').textContent = appState.account.connected ? '重新授权' : 'Continue with ChatGPT';
    $('#vault-info').textContent = `当前仓库：${appState.connection.vaultPath}。${appState.connection.obsidian ? '原生插件已连接。' : '当前使用本地文件方式；可安装插件启用原生编辑接入。'}`;
    localFileMode.hidden = !appState.connection.obsidian;
  }
  $('#api-key-field').hidden = $('#provider').value === 'chatgpt';
  settingsTab(tab); if (!$('#settings-dialog').open) $('#settings-dialog').showModal();
}
async function eventLoop() {
  eventController?.abort(); eventController = new AbortController();
  try {
    const response = await fetch(`${apiBase}/api/events`, { headers: bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {}, credentials: extension ? 'omit' : 'same-origin', signal: eventController.signal });
    if (!response.ok) return;
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      pending += decoder.decode(value, { stream: true }); const frames = pending.split('\n\n'); pending = frames.pop();
      for (const frame of frames) {
        const raw = frame.split('\n').find(x => x.startsWith('data: ')); if (!raw) continue;
        const event = JSON.parse(raw.slice(6));
        chatUI.onEvent(event);
        if (event.type === 'job' && event.noteId === activeId) {
          if (event.state === 'running') showJob(event.jobType === 'conversion' ? '正在生成另一种笔记版本…' : '正在整理新增对话…');
          else if (event.state === 'error') { showJob(event.message, true); toast(event.message, true); }
          else { $('#job-status').hidden = true; $('#stop-job').hidden = true; toast('整理完成，请检查结果'); }
        }
        if (event.type === 'auth-error') toast(event.message, true);
        if (event.type === 'converted') { if (!dirty) activeId = event.noteId; toast('已另存为新笔记，原笔记已保留'); }
        if (['changed', 'converted', 'job', 'auth-error'].includes(event.type)) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(() => {}), 180); }
      }
    }
  } catch (error) { if (error.name === 'AbortError') return; }
  setTimeout(eventLoop, 3000);
}
function requireNote() { if (!activeId) { $('#new-dialog').showModal(); throw new Error('先建立一篇学习笔记'); } }

document.querySelectorAll('[data-close]').forEach(button => { button.type = 'button'; button.addEventListener('click', () => button.closest('dialog').close()); });
document.querySelectorAll('[data-settings]').forEach(button => button.addEventListener('click', () => settingsTab(button.dataset.settings)));
for (const selector of ['#new-note', '#welcome-new']) listen(selector, 'click', () => { if (dirty) throw new Error('请先保存源文修改，再建立笔记'); $('#new-dialog').showModal(); $('#new-title').focus(); });
listen('#new-form', 'submit', async event => { event.preventDefault(); const form = new FormData(event.target); const note = await request('/api/notes', 'POST', { title: form.get('title'), mode: form.get('mode') }); activeId = note.id; markDirty(false); selected.clear(); $('#new-dialog').close(); event.target.reset(); await refresh(); toast('这一章已经准备好'); });
listen('#settings-button', 'click', () => openSettings());
listen('#jump-drafts', 'click', () => $('.draft-rail').scrollIntoView({ behavior: 'smooth', block: 'start' }));
listen('#import-button', 'click', () => { requireNote(); if (dirty) throw new Error('请先保存源文修改，再加入片段'); $('#import-dialog').showModal(); $('#import-text').focus(); });
listen('#import-form', 'submit', async event => {
  event.preventDefault(); requireNote(); const file = $('#import-image').files[0];
  let imageDataURL; if (file) { if (file.size > 15 * 1024 * 1024) throw new Error('图片需小于 15MB'); imageDataURL = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }
  const text = $('#import-text').value.trim(); if (!text && !imageDataURL) throw new Error('请粘贴文字或选择图片');
  await request('/api/capture', 'POST', { noteId: activeId, text, url: $('#import-url').value.trim(), imageDataURL, platform: '手动导入', manual: $('#import-direct').checked });
  $('#import-dialog').close(); event.target.reset(); $('#import-direct').checked = true; await refresh(); toast('学习片段已保存');
});
listen('#preview-tab', 'click', () => showView('preview')); listen('#source-tab', 'click', () => showView('source')); listen('#sources-tab', 'click', () => showView('sources'));
listen('#editor', 'input', () => { markDirty(true); $('#save-state').textContent = '有尚未保存的修改'; });
listen('#save-note', 'click', async () => { requireNote(); await request(`/api/notes/${activeId}`, 'PUT', { text: $('#editor').value, expectedHash: activeNote.hash }); markDirty(false); await refresh(); toast('修改已保存'); });
listen('#undo-note', 'click', async () => { requireNote(); if (dirty) throw new Error('请先保存当前修改'); await request(`/api/notes/${activeId}/undo`, 'POST', {}); await refresh(); toast('已撤销上次写入'); });
listen('#copy-note', 'click', async () => { requireNote(); const raw = dirty ? $('#editor').value : activeNote.text; await navigator.clipboard.writeText(activeNote.mode === 'outline' ? stripColorSpans(raw) : raw); toast(activeNote.mode === 'outline' ? '已复制大纲，可粘贴到幕布；笔记中的颜色仍保留' : '已复制 Markdown'); });
listen('#convert-note', 'click', () => { requireNote(); if (dirty) throw new Error('请先保存源文修改'); $('#convert-title').textContent = activeNote.mode === 'outline' ? '转换为普通 Markdown' : '转换为大纲 Markdown'; $('#convert-budget').textContent = '转换会调用 AI 并消耗额度。完成后生成独立文件，可与原笔记对照。'; $('#confirm-dialog').showModal(); });
listen('#convert-form', 'submit', async event => { event.preventDefault(); await request(`/api/notes/${activeId}/convert`, 'POST', { mode: activeNote.mode === 'outline' ? 'markdown' : 'outline' }); $('#confirm-dialog').close(); showJob('正在生成另一种笔记版本…'); });
listen('#summarize', 'click', async () => { requireNote(); if (dirty) throw new Error('请先保存源文修改'); await request(`/api/notes/${activeId}/summarize`, 'POST', {}); showJob('正在整理新增对话…'); });
listen('#stop-job', 'click', async () => { if (activeId) await request(`/api/notes/${activeId}/stop`, 'POST', {}); });
listen('#auto-summary', 'change', async event => { try { await request('/api/settings', 'POST', { autoSummary: event.target.checked }); toast(event.target.checked ? '自动整理已开启；新采集的对话会进入草稿' : '自动整理已暂停'); } catch (error) { event.target.checked = !event.target.checked; throw error; } });
listen('#select-all', 'change', event => { selected.clear(); if (event.target.checked && activeNote) activeNote.drafts.filter(x => x.status === 'pending').forEach(x => selected.add(x.id)); if (activeNote) renderDrafts(); });
listen('#accept-selected', 'click', async () => { if (!selected.size) throw new Error('请先选择草稿'); await acceptDrafts([...selected]); });
listen('#reject-selected', 'click', async () => { if (!selected.size) throw new Error('请先选择草稿'); await request(`/api/notes/${activeId}/reject`, 'POST', { ids: [...selected] }); selected.clear(); await refresh(); toast('已记住排除内容'); });
listen('#provider', 'change', event => { $('#api-key-field').hidden = event.target.value === 'chatgpt'; $('#model').value = appState.settings.providerModels?.[event.target.value] || (event.target.value === appState.settings.provider ? appState.settings.model : ''); $('#model-options').replaceChildren(); });
listen('#settings-form', 'submit', async event => { event.preventDefault(); await request('/api/settings', 'POST', { provider: $('#provider').value, model: $('#model').value.trim(), apiKey: $('#api-key').value.trim(), contextBudget: Number($('#context-budget').value), dailyTokenBudget: Number($('#daily-budget').value), callsPerHour: Number($('#calls-limit').value), outputFolder: $('#output-folder').value.trim() }); $('#api-key').value = ''; await refresh(); toast('偏好已保存'); });
listen('#load-models', 'click', async () => { await request('/api/settings', 'POST', { provider: $('#provider').value, ...($('#api-key').value.trim() ? { apiKey: $('#api-key').value.trim() } : {}) }); $('#api-key').value = ''; const { models } = await request('/api/models'); $('#model-options').replaceChildren(...models.map(model => { const option = element('option'); option.value = model.id; option.label = model.name; return option; })); if (!$('#model').value && models.length) $('#model').value = models[0].id; toast(`已读取 ${models.length} 个模型，请保存偏好`); });
listen('#connect-chatgpt', 'click', async () => { const { url } = await request('/api/auth/start', 'POST', {}); window.open(url, '_blank', 'noopener,noreferrer'); toast('请在官方页面完成授权，随后返回工作台'); });
listen('#disconnect-chatgpt', 'click', async () => { const result = await request('/api/auth/disconnect', 'POST', {}); await refresh(); openSettings(); toast(result.message); });
listen('#copy-connection', 'click', async () => { const result = await request('/api/connection'); await navigator.clipboard.writeText(result.token); toast('已复制本机连接码，仅粘贴到你的扩展或插件设置'); });
listen('#save-connection', 'click', async () => { bridgeToken = $('#bridge-token').value.trim(); if (!bridgeToken) throw new Error('请填写本机工作台里的连接码'); await request('/api/state'); await chrome.storage.local.set({ bridgeToken }); await refresh(); eventLoop(); $('#settings-dialog').close(); toast('已连接本机工作台'); });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('focus', () => { if (appState && !dirty) refresh().catch(() => {}); });
function showMobilePane(pane) { document.body.dataset.pane = pane; $('#show-chat').classList.toggle('active', pane === 'chat'); $('#show-notes').classList.toggle('active', pane === 'notes'); }
showMobilePane(extension ? 'notes' : 'chat');
listen('#show-chat', 'click', () => showMobilePane('chat')); listen('#show-notes', 'click', () => showMobilePane('notes'));
if (extension) {
  const saved = await chrome.storage.local.get(['bridgeToken', 'apiBase']); bridgeToken = saved.bridgeToken || ''; apiBase = saved.apiBase || apiBase;
  $('#extension-connection').hidden = false;
  $('#download-extension').href = `${apiBase}/downloads/shiye-extension.zip`; $('#download-plugin').href = `${apiBase}/downloads/shiye-obsidian.zip`;
  const bar = element('div', 'extension-controls'); const capture = element('button', 'button primary full', '采集当前 AI 对话');
  capture.addEventListener('click', () => chrome.runtime.sendMessage({ kind: 'capture-page' }).then(result => { if (result?.error) throw new Error(result.error); toast(`已采集 ${result?.count || 0} 条可识别消息`); }).catch(error => toast(error.message, true)));
  const toggle = element('label', 'checkline'); const check = element('input'); check.type = 'checkbox'; check.checked = (await chrome.storage.local.get('autoCapture')).autoCapture || false; check.addEventListener('change', () => chrome.storage.local.set({ autoCapture: check.checked })); toggle.append(check, document.createTextNode('持续采集本页新消息')); bar.append(capture, toggle); $('.library').insertBefore(bar, $('.library-label'));
}
try {
  await refresh(); eventLoop();
  await initializeDesktop({ openSettings, toast, refresh, isDirty: () => dirty });
  const query = new URLSearchParams(location.search);
  if (query.has('authFailed')) { openSettings('account'); toast(appState.account.lastError?.message || '授权未完成，旧的错误详情已失效。请在这里重新连接以查看具体原因', true); }
  else if (query.has('connected')) { openSettings('account'); toast('账号已连接，请读取可用模型并保存偏好'); }
  if (query.has('authFailed') || query.has('connected')) history.replaceState(null, '', location.pathname);
}
catch (error) { $('#connection-label').textContent = '尚未连接工作台'; toast(extension ? '先启动本机工作台，再填写连接码' : '本机连接失败，请刷新重试', true); if (extension) openSettings('connection'); }
