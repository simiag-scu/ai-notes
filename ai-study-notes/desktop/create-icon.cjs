const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.dock?.hide();
app.whenReady().then(async () => {
  const [svgFile, output] = process.argv.slice(2);
  const svg = await fs.readFile(svgFile, 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent;width:1024px;height:1024px;display:grid;place-items:center"><div style="width:850px;height:850px">${svg}</div></body></html>`));
  await new Promise(resolve => setTimeout(resolve, 250));
  const icon = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  await fs.mkdir(output, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) await fs.writeFile(path.join(output, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), icon.resize({ width: size * scale, height: size * scale, quality: 'best' }).toPNG());
  await fs.writeFile(path.join(output, '..', 'icon.png'), icon.toPNG());
  win.destroy(); app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
