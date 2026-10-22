const $ = selector => document.querySelector(selector);
let busy = false, currentInfo = null;
function render(info) {
  currentInfo = info;
  $('#vault-name').textContent = info.vault?.split('/').pop() || '尚未选择文件夹';
  $('#vault-path').textContent = info.vault || '点击下方按钮，选择保存笔记的位置。';
  $('#start').disabled = !info.vault || busy;
  $('#start').firstChild.textContent = info.existing ? '继续这个仓库的学习 ' : '打开学习工作台 ';
  $('#legacy-card').hidden = !info.legacy;
  if (info.legacy) $('#legacy-summary').textContent = `${info.legacy.notes} 篇笔记 · ${info.legacy.chats} 个对话 · ${info.legacy.directory}`;
  $('#choose-legacy').hidden = info.existing;
  $('#version').textContent = `拾页 ${info.version} · Mac 应用`;
  error(info.error || '');
}
function error(message) { $('#setup-error').textContent = message; $('#setup-error').hidden = !message; }
function action(id, operation) { $(id).addEventListener('click', async () => { if (busy) return; busy = true; $('#start').disabled = true; error(''); try { await operation(); } catch (reason) { error(reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } finally { busy = false; $('#start').disabled = !currentInfo?.vault; } }); }
action('#choose-vault', async () => { render(await window.shiyeDesktop.chooseVault()); $('#import-legacy').checked = false; });
action('#choose-legacy', async () => { render(await window.shiyeDesktop.chooseLegacy()); $('#import-legacy').checked = !$('#legacy-card').hidden; });
action('#show-data', () => window.shiyeDesktop.showData());
action('#start', () => window.shiyeDesktop.start({ importLegacy: $('#import-legacy').checked && !$('#legacy-card').hidden }));
render(await window.shiyeDesktop.info());
