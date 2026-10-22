import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist'); await fs.mkdir(dist, { recursive: true });
for (const directory of ['extension', 'obsidian']) {
  const target = path.join(dist, directory); await fs.rm(target, { recursive: true, force: true }); await fs.cp(path.join(root, directory), target, { recursive: true });
  if (directory === 'extension') await fs.cp(path.join(root, 'web'), path.join(target, 'panel'), { recursive: true });
  else await fs.rename(path.join(target, 'main.cjs'), path.join(target, 'main.js'));
  const archive = path.join(dist, directory === 'extension' ? 'shiye-extension.zip' : 'shiye-obsidian.zip');
  await fs.rm(archive, { force: true }); execFileSync('/usr/bin/zip', ['-qr', archive, '.'], { cwd: target });
}
console.log('已生成 dist/extension、dist/obsidian 和两份安装 ZIP 包。运行时无需安装依赖。');
