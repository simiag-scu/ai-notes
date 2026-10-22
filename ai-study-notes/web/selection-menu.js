export function createSelectionMenu({ element, request, toast, refresh, renderMarkdown, renderer, getNote, isDirty, requireNote }) {
  const $ = selector => document.querySelector(selector), menu = element('div', 'selection-menu');
  menu.id = 'selection-menu'; menu.role = 'menu'; menu.hidden = true; document.body.append(menu);
  let currentEdit = null, payload = null, timer = null, closing = false;
  try { currentEdit = localStorage.getItem('shiye-edit'); } catch {}
  const remember = id => { currentEdit = id; try { id ? localStorage.setItem('shiye-edit', id) : localStorage.removeItem('shiye-edit'); } catch {} };
  function hide() { menu.hidden = true; }
  function available() { requireNote(); if (isDirty()) throw new Error('请先保存右侧源文修改，再进行选区操作'); return getNote(); }
  function item(label, id, operation, disabled = false) {
    const button = element('button', 'selection-menu-item', label); button.id = id; button.role = 'menuitem'; button.disabled = disabled;
    button.addEventListener('click', () => { hide(); Promise.resolve().then(operation).catch(error => toast(error.message, true)); }); menu.append(button); return button;
  }
  function rangeForEditor(editor) {
    if (editor.selectionEnd <= editor.selectionStart) return null;
    const start = editor.value.lastIndexOf('\n', editor.selectionStart - 1) + 1, next = editor.value.indexOf('\n', editor.selectionEnd);
    return { start, end: next < 0 ? editor.value.length : next, text: editor.value.slice(start, next < 0 ? editor.value.length : next) };
  }
  async function launch(data) {
    available(); payload = data; if (!$('#edit-dialog').open) $('#edit-dialog').showModal(); $('#edit-title').textContent = data.origin === 'note' ? 'AI 重新排版笔记' : data.operation === 'simplify' ? 'AI 精简后加入' : 'AI 排版后加入';
    $('#edit-original').textContent = data.text; $('#edit-result').value = ''; $('#edit-result').hidden = true; $('#edit-toggle-source').textContent = '编辑 Markdown 结果'; $('#edit-rendered').replaceChildren(); $('#edit-error').hidden = true; $('#edit-apply').disabled = true; $('#edit-retry').hidden = true;
    $('#edit-status').textContent = '正在处理所选内容…'; $('#edit-target').textContent = `目标：${getNote().title} · ${getNote().mode === 'outline' ? '大纲 Markdown' : '普通 Markdown'}`;
    $('#edit-apply').textContent = data.origin === 'note' ? '确认替换原选区' : '确认加入笔记';
    try { const created = await request('/api/edits', 'POST', data); remember(created.id); await poll(); }
    catch (error) { $('#edit-error').textContent = error.message; $('#edit-error').hidden = false; $('#edit-status').textContent = '尚未写入笔记'; $('#edit-retry').hidden = false; }
  }
  async function poll() {
    clearTimeout(timer); const id = currentEdit; if (!id || !$('#edit-dialog').open) return;
    try {
      const edit = await request(`/api/edits/${id}`); if (id !== currentEdit || !$('#edit-dialog').open) return;
      payload = { noteId: edit.noteId, origin: edit.origin, operation: edit.operation, text: edit.original, start: edit.start, end: edit.end, expectedHash: edit.expectedHash, conversationId: edit.conversationId, messageId: edit.messageId };
      $('#edit-original').textContent = edit.original;
      if (edit.status === 'running') { timer = setTimeout(poll, 650); return; }
      if (edit.status === 'ready') {
        $('#edit-result').value = edit.text; renderMarkdown(edit.text, $('#edit-rendered')); $('#edit-apply').disabled = false;
        $('#edit-status').textContent = `已生成，尚未写入 · 本次 ${edit.usage?.estimated ? '约 ' : ''}${(edit.usage?.input || 0) + (edit.usage?.output || 0)} token`;
        $('#edit-error').hidden = true; $('#edit-retry').hidden = true;
      } else { $('#edit-error').textContent = edit.error || '这次处理已结束，笔记未改动'; $('#edit-error').hidden = false; $('#edit-status').textContent = '尚未写入笔记'; $('#edit-retry').hidden = edit.status === 'applied'; }
    } catch (error) { $('#edit-error').textContent = error.message; $('#edit-error').hidden = false; $('#edit-status').textContent = '无法读取结果，笔记未改动'; }
  }
  function open(event, keyboard = false) {
    const target = event.target instanceof Element ? event.target : event.target.parentElement;
    const chatRoot = target.closest('.chat-message.assistant .message-body'), preview = target.closest('#preview'), editor = target.closest('#editor');
    if (!chatRoot && !preview && !editor) return;
    const note = getNote(), selection = !editor && renderer.readSelection(chatRoot || preview);
    if (chatRoot && !selection) return;
    event.preventDefault(); menu.replaceChildren();
    if (chatRoot) {
      const message = chatRoot.closest('.chat-message'), base = { noteId: note?.id, origin: 'chat', text: selection.text, start: selection.start, end: selection.end, conversationId: $('#chat-messages').dataset.conversationId, messageId: message.dataset.messageId };
      menu.append(element('div', 'selection-menu-label', `AI 回答选区 · ${selection.text.length} 字符`));
      item('原文加入笔记', 'menu-chat-add', async () => { available(); await request('/api/capture', 'POST', { noteId: note.id, text: selection.text, manual: true, platform: '拾页 · 右键摘录', conversationId: base.conversationId, messageId: base.messageId }); await refresh(); toast('原文已加入笔记'); });
      item('AI 排版后加入…', 'menu-chat-format', () => launch({ ...base, operation: 'format' }), message.dataset.status !== 'completed');
      item('AI 精简后加入…', 'menu-chat-simplify', () => launch({ ...base, operation: 'simplify' }), message.dataset.status !== 'completed');
    } else {
      menu.append(element('div', 'selection-menu-label', selection ? '笔记选区' : '笔记内容'));
      if (selection && !selection.code) {
        const colors = element('div', 'selection-colors');
        for (const [name, value] of [['默认', 'var(--text-normal)'], ['红色', '#b4473d'], ['橙色', '#a66a19'], ['绿色', '#26744d'], ['蓝色', '#326ca8'], ['紫色', '#8055a0']]) {
          const button = element('button', 'color-swatch'); button.role = 'menuitem'; button.title = `文字颜色：${name}`; button.setAttribute('aria-label', `文字颜色：${name}`); button.style.setProperty('--swatch', value); button.dataset.color = value;
          button.addEventListener('click', async () => { hide(); try { available(); await request(`/api/notes/${note.id}/color`, 'POST', { color: value, segments: selection.segments, expectedHash: note.hash }); await refresh(); toast(`已设为${name}，可撤销写入`); } catch (error) { toast(error.message, true); } }); colors.append(button);
        }
        menu.append(element('div', 'selection-menu-caption', '文字颜色'), colors);
      }
      let fragment = editor ? rangeForEditor(editor) : selection ? { ...selection.block, text: note?.text.slice(selection.block.start, selection.block.end) } : renderer.blockAt(preview, target);
      if (fragment) item(target.closest('table') ? 'AI 修复表格排版…' : 'AI 重新排版本段…', 'menu-note-format', () => launch({ noteId: note.id, origin: 'note', operation: 'format', ...fragment, expectedHash: note.hash }));
      item('AI 重新排版整篇笔记…', 'menu-note-format-all', () => launch({ noteId: note.id, origin: 'note', operation: 'format', start: 0, end: note.text.length, text: note.text, expectedHash: note.hash }), !note);
    }
    menu.hidden = false;
    const bounds = keyboard ? target.getBoundingClientRect() : null, x = bounds?.left || event.clientX, y = bounds?.bottom || event.clientY;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`; menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
    if (keyboard) menu.querySelector('button:not(:disabled)')?.focus();
  }
  document.addEventListener('contextmenu', open);
  document.addEventListener('keydown', event => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { open(event, true); return; }
    if (event.key === 'Escape') hide();
    if (!menu.hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const buttons = [...menu.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
  });
  document.addEventListener('pointerdown', event => { if (menu.contains(event.target)) { event.preventDefault(); return; } hide(); });
  document.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
  async function cancel() { clearTimeout(timer); const id = currentEdit; remember(null); if (id) await request(`/api/edits/${id}/stop`, 'POST', {}).catch(() => {}); }
  $('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());
  $('#edit-dialog').addEventListener('close', () => { if (!closing) cancel(); closing = false; });
  $('#edit-retry').addEventListener('click', () => { if (payload) { cancel().then(() => launch(payload)).catch(error => toast(error.message, true)); } });
  $('#edit-apply').addEventListener('click', async () => {
    const id = currentEdit; if (!id) return; $('#edit-apply').disabled = true;
    try { if (isDirty()) throw new Error('请先保存源文修改'); await request(`/api/edits/${id}/apply`, 'POST', { text: $('#edit-result').value }); closing = true; remember(null); $('#edit-dialog').close(); await refresh(); toast('已确认写入，可撤销上次写入'); }
    catch (error) { $('#edit-error').textContent = error.message; $('#edit-error').hidden = false; $('#edit-apply').disabled = false; }
  });
  $('#edit-result').addEventListener('input', () => renderMarkdown($('#edit-result').value, $('#edit-rendered')));
  $('#edit-toggle-source').addEventListener('click', () => { $('#edit-result').hidden = !$('#edit-result').hidden; $('#edit-toggle-source').textContent = $('#edit-result').hidden ? '编辑 Markdown 结果' : '收起 Markdown 编辑'; });
  return { sync(state) {
    if (currentEdit && !$('#edit-dialog').open && state.edits?.some(x => x.id === currentEdit)) {
      const note = state.notes.find(x => x.id === state.edits.find(x => x.id === currentEdit).noteId);
      $('#edit-title').textContent = '恢复上次选区处理'; $('#edit-target').textContent = `目标：${note?.title || '学习笔记'}`; $('#edit-dialog').showModal(); poll();
    }
  } };
}
