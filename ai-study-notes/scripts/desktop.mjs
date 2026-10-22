import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode = 'dev', arch = 'arm64'] = process.argv.slice(2);
if (process.platform !== 'darwin' || !['dev', 'build'].includes(mode) || arch !== 'arm64') throw new Error('当前仅构建 Apple 芯片 Mac 版本（arm64）');
const cache = process.env.SHIYE_BUILD_CACHE || path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'shiye-desktop-toolchain');
const stage = path.join(cache, `application-${arch}`);
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const toolchain = JSON.parse(await fs.readFile(path.join(root, 'desktop/package.json'), 'utf8'));
const environment = { ...process.env, ELECTRON_CACHE: process.env.ELECTRON_CACHE || path.join(cache, 'electron-cache'), ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || path.join(cache, 'builder-cache') };
delete environment.ELECTRON_RUN_AS_NODE;
async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => { const child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit', ...options }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`构建步骤未完成（退出码 ${code}）`))); });
}
await fs.mkdir(cache, { recursive: true });
const lock = await fs.readFile(path.join(root, 'desktop/package-lock.json'));
const signature = createHash('sha256').update(lock).digest('hex');
const installed = await fs.readFile(path.join(cache, '.installed-lock'), 'utf8').catch(() => '');
if (installed !== signature || !await fs.access(path.join(cache, 'node_modules/electron/dist/Electron.app')).then(() => true, () => false)) {
  for (const name of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(root, 'desktop', name), path.join(cache, name));
  // Keep the large build dependency tree outside the user's synced note vault.
  await run('npm', ['ci', '--no-fund', '--no-audit'], { cwd: cache });
  await run(process.execPath, [path.join(cache, 'node_modules/electron/install.js')], { cwd: cache });
  await fs.writeFile(path.join(cache, '.installed-lock'), signature);
}
await run(process.execPath, [path.join(root, 'scripts/build.mjs')]);
await fs.rm(stage, { recursive: true, force: true }); await fs.mkdir(stage, { recursive: true });
for (const name of ['desktop', 'server', 'core', 'web', 'obsidian']) await fs.cp(path.join(root, name), path.join(stage, name), { recursive: true, filter: filename => !['node_modules', 'package-lock.json'].includes(path.basename(filename)) });
await fs.mkdir(path.join(stage, 'dist')); for (const name of ['shiye-extension.zip', 'shiye-obsidian.zip']) await fs.copyFile(path.join(root, 'dist', name), path.join(stage, 'dist', name));
await fs.mkdir(path.join(stage, 'node_modules'), { recursive: true }); await fs.cp(path.join(cache, 'node_modules/undici'), path.join(stage, 'node_modules/undici'), { recursive: true });
await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'shiye-study-notes', version: metadata.version, private: true, type: 'module', main: 'desktop/main.mjs', description: metadata.description, author: 'Shiye', dependencies: toolchain.dependencies }, null, 2));
const electron = path.join(cache, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
if (mode === 'dev') await run(electron, [stage]);
else {
  await fs.mkdir(path.join(stage, 'build'), { recursive: true });
  await run(electron, [path.join(root, 'desktop/create-icon.cjs'), path.join(root, 'web/icon.svg'), path.join(stage, 'build/icon.iconset')]);
  await run('/usr/bin/iconutil', ['-c', 'icns', path.join(stage, 'build/icon.iconset'), '-o', path.join(stage, 'build/icon.icns')]);
  const output = path.join(cache, 'release');
  await run(process.execPath, [path.join(cache, 'node_modules/electron-builder/cli.js'), '--config', path.join(root, 'desktop/electron-builder.cjs'), '--projectDir', stage, '--mac', `--${arch}`, '--publish', 'never', '--config.directories.output=' + output, '--config.electronVersion=' + toolchain.devDependencies.electron]);
  await fs.mkdir(path.join(root, 'release'), { recursive: true });
  for (const name of await fs.readdir(output)) if (name.startsWith(`Shiye-${metadata.version}-mac-${arch}.`)) await fs.copyFile(path.join(output, name), path.join(root, 'release', name));
  console.log(`Mac 安装包已生成：${path.join(root, 'release')}。没有包含个人笔记、聊天、密钥或本机路径。`);
}
