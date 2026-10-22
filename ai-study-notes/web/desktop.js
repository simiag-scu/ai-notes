export async function initializeDesktop({ openSettings, toast, refresh, isDirty }) {
  const desktop = window.shiyeDesktop;
  if (!desktop) return;
  document.body.classList.add('desktop-app');
  const info = await desktop.info();
  const container = document.createElement('section'); container.className = 'desktop-preferences';
  const title = document.createElement('h3'); title.textContent = `拾页 ${info.version} · Mac 应用`;
  const description = document.createElement('p'); description.className = 'help-text'; description.textContent = '笔记保存在所选仓库。聊天与偏好独立保存，替换应用时会保留。';
  const actions = document.createElement('div'); actions.className = 'desktop-actions';
  function button(label, action) { const item = document.createElement('button'); item.type = 'button'; item.className = 'button subtle'; item.textContent = label; item.addEventListener('click', () => Promise.resolve().then(action).catch(error => toast(error.message, true))); actions.append(item); }
  button('笔记仓库与数据…', () => desktop.manage());
  button('在访达显示笔记', () => desktop.showVault());
  button('显示应用数据', () => desktop.showData());
  container.append(title, description, actions);
  const address = document.createElement('p'); address.className = 'help-text'; address.textContent = `扩展与插件连接地址：${info.localAddress}`; container.append(address);
  if (info.portWarning) { const warning = document.createElement('p'); warning.className = 'auth-notice'; warning.textContent = info.portWarning; container.append(warning); }
  document.querySelector('#settings-connection').prepend(container);
  const pluginLink = document.querySelector('#download-plugin');
  pluginLink.closest('.setup-step').querySelector('p').textContent = '本地文件方式无需插件。需要 Obsidian 原生编辑接入时，点击安装，再在 Obsidian 的第三方插件设置中启用「拾页」并填写连接码。';
  const install = document.createElement('button'); install.className = 'button primary'; install.textContent = '安装可选 Obsidian 插件';
  install.addEventListener('click', async () => { install.disabled = true; try { await desktop.installPlugin(); toast('插件已安装，请在 Obsidian 第三方插件设置中启用「拾页」并填写连接码'); } catch (error) { toast(error.message, true); } finally { install.disabled = false; } });
  pluginLink.before(install); pluginLink.textContent = '另存插件包';
  desktop.onCommand(async command => {
    if (command === 'settings') openSettings();
    else if (command === 'new-note') document.querySelector('#new-note').click();
    else if (command === 'new-chat') document.querySelector('#new-chat').click();
    else if (command === 'save' && isDirty()) document.querySelector('#save-note').click();
    else if (command === 'auth-connected' || command === 'auth-failed') { await refresh(); openSettings(); toast(command === 'auth-connected' ? '账号已连接，可以继续学习' : '授权未完成，请查看连接原因', command === 'auth-failed'); }
  });
}
