import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let count = 0;
async function visit(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['dist', 'release', 'github-publish', 'node_modules', '笔记', '拾页笔记'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(filename);
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) { execFileSync(process.execPath, ['--check', filename], { stdio: 'pipe' }); count++; }
    else if (entry.name.endsWith('.json')) JSON.parse(await fs.readFile(filename, 'utf8'));
  }
}
await visit(root); console.log(`${count} 个脚本通过语法检查；JSON 配置有效。`);
