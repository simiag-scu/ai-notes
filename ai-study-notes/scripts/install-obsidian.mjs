import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vault = path.resolve(process.argv[2] || path.dirname(root));
const target = path.join(vault, '.obsidian', 'plugins', 'shiye-study-notes');
await fs.mkdir(target, { recursive: true });
for (const [source, name] of [['main.cjs', 'main.js'], ['manifest.json', 'manifest.json'], ['styles.css', 'styles.css']]) await fs.copyFile(path.join(root, 'obsidian', source), path.join(target, name));
console.log(`拾页插件已安装到：${target}\n请在 Obsidian 的第三方插件列表中启用，并填写工作台里的本机连接码。`);
