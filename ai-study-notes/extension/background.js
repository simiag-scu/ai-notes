const BASE = 'http://127.0.0.1:17861';
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.create({ id: 'shiye-text', title: '加入拾页笔记', contexts: ['selection'], documentUrlPatterns: ['https://chatgpt.com/*', 'https://chat.deepseek.com/*'] });
  chrome.contextMenus.create({ id: 'shiye-image', title: '图片加入拾页笔记', contexts: ['image'], documentUrlPatterns: ['https://chatgpt.com/*', 'https://chat.deepseek.com/*'] });
  chrome.contextMenus.create({ id: 'shiye-page', title: '采集当前 AI 对话', contexts: ['page'], documentUrlPatterns: ['https://chatgpt.com/*', 'https://chat.deepseek.com/*'] });
});
async function api(route, method = 'GET', data) {
  const { bridgeToken } = await chrome.storage.local.get('bridgeToken');
  if (!bridgeToken) throw new Error('先在拾页侧栏设置中填写本机连接码');
  const response = await fetch(BASE + route, { method, headers: { Authorization: `Bearer ${bridgeToken}`, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '保存失败'); return result;
}
async function imageData(url, tabId) {
  if (url.startsWith('data:image/')) return url;
  if (url.startsWith('blob:')) { const result = await chrome.tabs.sendMessage(tabId, { kind: 'image-data', url }); if (result?.error) throw new Error(result.error); return result.data; }
  const target = new URL(url);
  if (target.protocol !== 'https:' || !['chatgpt.com', 'chat.deepseek.com'].includes(target.hostname) && !/\.(oaiusercontent|oaistatic|deepseek)\.com$/.test(target.hostname)) throw new Error('图片来自其他站点，请先保存图片，再在拾页中加入');
  const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('图片下载失败，可先保存图片，再从工作台加入');
  const type = response.headers.get('content-type')?.split(';')[0];
  if (!/^image\/(png|jpeg|webp|gif)$/.test(type || '')) throw new Error('此图片格式暂不支持');
  if (Number(response.headers.get('content-length')) > 15 * 1024 * 1024) throw new Error('图片超过 15MB');
  const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > 15 * 1024 * 1024) throw new Error('图片超过 15MB');
  let binary = ''; for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return `data:${type};base64,${btoa(binary)}`;
}
async function capture(payload, tabId) {
  const data = { ...payload }; if (data.imageURL) { data.imageDataURL = await imageData(data.imageURL, tabId); delete data.imageURL; }
  return api('/api/capture', 'POST', data);
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (message.kind === 'capture-target' && sender.tab) return api('/api/capture-target');
    if (message.kind === 'capture' && sender.tab) return capture(message.payload, sender.tab.id);
    if (message.kind === 'capture-batch' && sender.tab) {
      let count = 0; for (const payload of message.payloads.slice(0, 200)) { await capture(payload, sender.tab.id); count++; } return { count };
    }
    if (message.kind === 'capture-page') { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.deepseek\.com)\//.test(tab.url || '')) throw new Error('请先切换到 ChatGPT 或 DeepSeek 网页'); return chrome.tabs.sendMessage(tab.id, { kind: 'capture-page' }); }
    throw new Error('无法识别的扩展操作');
  })().then(reply, error => reply({ error: error.message }));
  return true;
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    let result;
    if (info.menuItemId === 'shiye-page') result = await chrome.tabs.sendMessage(tab.id, { kind: 'capture-page' });
    else result = await capture({ manual: true, text: info.selectionText || '', imageURL: info.menuItemId === 'shiye-image' ? info.srcUrl : undefined, url: tab.url, platform: tab.url.includes('deepseek') ? 'DeepSeek' : 'ChatGPT' }, tab.id);
    await chrome.tabs.sendMessage(tab.id, { kind: 'notice', message: result?.error || '已保存到学习笔记', error: !!result?.error });
  } catch (error) { chrome.tabs.sendMessage(tab.id, { kind: 'notice', message: error.message, error: true }).catch(() => {}); }
});
chrome.commands.onCommand.addListener(async command => { if (command === 'capture-selection') { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab?.id) chrome.tabs.sendMessage(tab.id, { kind: 'capture-selection' }).catch(() => {}); } });
