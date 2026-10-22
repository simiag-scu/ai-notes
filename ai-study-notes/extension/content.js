(() => {
  if (window.__shiyeCapture) return; window.__shiyeCapture = true;
  const host = document.createElement('div'); host.id = 'shiye-capture-root'; const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style'); style.textContent = ':host{all:initial;position:fixed;z-index:2147483646;top:0;left:0;font:12px -apple-system,BlinkMacSystemFont,sans-serif}button{border:0;background:#254e3e;color:white;border-radius:6px;padding:9px 13px;box-shadow:0 3px 16px #0002;cursor:pointer;white-space:nowrap;font:12px -apple-system,sans-serif}button:hover{background:#35644e}.bubble,.image{position:fixed;display:none}.notice{position:fixed;bottom:28px;left:50vw;transform:translateX(-50%);background:#254e3e;color:white;padding:12px 18px;border-radius:7px;max-width:80vw;display:none;font:12px/1.6 -apple-system,sans-serif}.notice.error{background:#8d493f}'; shadow.append(style);
  const bubble = document.createElement('button'); bubble.className = 'bubble'; bubble.textContent = '＋ 加入笔记';
  const imageButton = document.createElement('button'); imageButton.className = 'image'; imageButton.textContent = '＋ 图片加入笔记';
  const notice = document.createElement('div'); notice.className = 'notice'; notice.setAttribute('role', 'status'); shadow.append(bubble, imageButton, notice); document.documentElement.append(host);
  let selectionText = '', selectionHTML = '', imageURL = '', noticeTimer, captureTimer, autoCapture = false, lastSent = new Map(), lastURL = location.href, lastTarget = null;
  function notify(message, error = false) { notice.textContent = message; notice.className = `notice${error ? ' error' : ''}`; notice.style.display = 'block'; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => notice.style.display = 'none', error ? 7000 : 3000); }
  function markdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
    if (node.nodeType === Node.ELEMENT_NODE && ['SCRIPT', 'STYLE', 'BUTTON', 'SVG', 'NAV'].includes(node.tagName)) return '';
    const tag = node.tagName, children = () => [...node.childNodes].map(markdown).join('');
    if (node.querySelector?.('annotation[encoding="application/x-tex"]') && (node.classList?.contains('katex') || tag === 'MATH')) return `$${node.querySelector('annotation').textContent}$`;
    if (tag === 'PRE') return `\n\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
    if (tag === 'CODE') return `\`${node.textContent}\``;
    if (tag === 'A') { const href = node.getAttribute('href'); return /^https?:\/\//.test(href || '') ? `[${children()}](${href})` : children(); }
    if (tag === 'STRONG' || tag === 'B') return `**${children()}**`;
    if (tag === 'EM' || tag === 'I') return `*${children()}*`;
    if (/^H[1-6]$/.test(tag || '')) return `\n\n${'#'.repeat(Number(tag[1]))} ${children()}\n\n`;
    if (tag === 'LI') { let depth = 0, parent = node.parentElement?.parentElement; while (parent && parent !== document.body) { if (parent.tagName === 'LI') depth++; parent = parent.parentElement; } return `\n${'  '.repeat(depth)}- ${children().trim()}`; }
    if (tag === 'IMG') return node.alt ? `\n[图片：${node.alt}]\n` : '';
    if (tag === 'BR') return '\n';
    if (tag === 'BLOCKQUOTE') return '\n' + children().trim().split('\n').map(line => `> ${line}`).join('\n') + '\n';
    if (tag === 'TR') return `\n| ${[...node.children].map(child => markdown(child).trim().replace(/\|/g, '\\|')).join(' | ')} |\n${node.querySelector('th') ? `| ${[...node.children].map(() => '---').join(' | ')} |\n` : ''}`;
    const content = children(); return ['P', 'DIV', 'UL', 'OL', 'SECTION', 'TABLE'].includes(tag) ? `\n${content}\n` : content;
  }
  function tidy(text) { return text.replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim(); }
  function source(payload) { return { ...payload, url: location.href, platform: location.hostname.includes('deepseek') ? 'DeepSeek' : 'ChatGPT' }; }
  async function send(payload) { const result = await chrome.runtime.sendMessage({ kind: 'capture', payload: source(payload) }); if (result?.error) throw new Error(result.error); return result; }
  document.addEventListener('mouseup', event => {
    if (event.composedPath().includes(host)) return;
    const selection = window.getSelection(); if (!selection?.rangeCount || !selection.toString().trim()) { bubble.style.display = 'none'; return; }
    const range = selection.getRangeAt(0); selectionText = selection.toString(); selectionHTML = tidy(markdown(range.cloneContents())) || selectionText;
    const rect = range.getBoundingClientRect(); bubble.style.left = `${Math.max(8, Math.min(window.innerWidth - 125, rect.left))}px`; bubble.style.top = `${Math.max(8, Math.min(window.innerHeight - 45, rect.bottom + 7))}px`; bubble.style.display = 'block';
  });
  bubble.addEventListener('pointerdown', event => event.preventDefault());
  async function saveSelection() { if (!selectionText.trim()) { notify('请先选中文字', true); return; } const current = selectionHTML || selectionText; bubble.disabled = true; try { await send({ manual: true, text: current }); notify('原文已加入笔记'); bubble.style.display = 'none'; } catch (error) { notify(error.message, true); } finally { bubble.disabled = false; } }
  bubble.addEventListener('click', saveSelection);
  let imageHideTimer;
  document.addEventListener('mouseover', event => {
    if (event.composedPath().includes(host)) { clearTimeout(imageHideTimer); return; }
    if (event.target instanceof HTMLImageElement && event.target.naturalWidth >= 100) { clearTimeout(imageHideTimer); imageURL = event.target.currentSrc || event.target.src; const rect = event.target.getBoundingClientRect(); imageButton.style.top = `${Math.max(8, rect.top + 8)}px`; imageButton.style.left = `${Math.max(8, Math.min(innerWidth - 160, rect.left + 8))}px`; imageButton.style.display = 'block'; }
    else { clearTimeout(imageHideTimer); imageHideTimer = setTimeout(() => imageButton.style.display = 'none', 500); }
  });
  imageButton.addEventListener('click', async () => { imageButton.disabled = true; try { await send({ manual: true, imageURL, text: '' }); notify('图片已作为本地附件加入笔记'); } catch (error) { notify(error.message, true); } finally { imageButton.disabled = false; } });
  function isGenerating() { return !!document.querySelector('button[data-testid="stop-button"]:not([disabled])') || [...document.querySelectorAll('button')].some(button => /stop generating|stop streaming|停止生成|停止响应|停止回答|停止输出/i.test(`${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`) && !button.disabled); }
  function collect() {
    const candidates = [...document.querySelectorAll('[data-message-author-role]')];
    const nodes = candidates.length ? candidates : [...document.querySelectorAll('[data-role="assistant"], [data-role="user"], [class*="ds-markdown"]')].filter(node => !node.parentElement.closest('[data-role="assistant"], [data-role="user"], [class*="ds-markdown"]'));
    return nodes.map((node, index) => {
      const role = node.getAttribute('data-message-author-role') || node.getAttribute('data-role') || 'assistant';
      if (!['user', 'assistant'].includes(role)) return null;
      const container = node.querySelector('.markdown, [class*="ds-markdown"], [data-testid="user-message"]') || node;
      const text = tidy(markdown(container));
      let digest = 2166136261; for (const character of text) digest = Math.imul(digest ^ character.codePointAt(0), 16777619) >>> 0;
      const stable = node.getAttribute('data-message-id') || node.closest('[data-message-id]')?.getAttribute('data-message-id') || `${role}-${digest.toString(16)}-${text.length}`;
      return text ? source({ externalId: stable, role, text, manual: false }) : null;
    }).filter(Boolean);
  }
  async function capturePage(automatic = false) {
    if (isGenerating()) { if (!automatic) throw new Error('AI 正在回答，请等回答完成后再采集'); return { count: 0 }; }
    if (lastURL !== location.href) { lastSent.clear(); lastURL = location.href; }
    const target = await chrome.runtime.sendMessage({ kind: 'capture-target' });
    if (target?.error) throw new Error(target.error);
    if (!target?.noteId) throw new Error('请先在拾页中建立或选择目标笔记');
    if (lastTarget !== target.noteId) { lastSent.clear(); lastTarget = target.noteId; }
    const payloads = collect(); if (!payloads.length && !automatic) throw new Error('没有识别到对话。可先滚动加载消息，或直接选取需要的文字');
    let count = 0;
    for (const payload of payloads) { if (lastSent.get(payload.externalId) === payload.text) continue; await send(payload); lastSent.set(payload.externalId, payload.text); count++; }
    if (count && !automatic) notify(`已采集 ${count} 条消息；长对话请先滚动加载需要的部分`);
    return { count };
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.kind === 'notice') { notify(message.message, message.error); reply({ ok: true }); return; }
    if (message.kind === 'capture-selection') { saveSelection(); reply({ ok: true }); return; }
    if (message.kind === 'capture-page') { capturePage().then(reply, error => reply({ error: error.message })); return true; }
    if (message.kind === 'image-data') { fetch(message.url).then(x => x.blob()).then(blob => { if (blob.size > 15 * 1024 * 1024) throw new Error('图片超过15MB'); const reader = new FileReader(); reader.onload = () => reply({ data: reader.result }); reader.readAsDataURL(blob); }).catch(error => reply({ error: error.message })); return true; }
  });
  chrome.storage.local.get('autoCapture').then(data => autoCapture = !!data.autoCapture);
  chrome.storage.onChanged.addListener(changes => { if (changes.autoCapture) autoCapture = !!changes.autoCapture.newValue; });
  new MutationObserver(records => { if (!autoCapture || records.every(record => record.target === host)) return; clearTimeout(captureTimer); captureTimer = setTimeout(() => capturePage(true).catch(error => { autoCapture = false; notify(`${error.message}；持续采集已暂停`, true); }), 2500); }).observe(document.body, { childList: true, subtree: true, characterData: true });
})();
