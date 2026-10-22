import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const version = metadata.version;
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('版本号格式无效');
const parent = path.join(root, 'github-publish');
const destination = path.join(parent, `v${version}`);
const marker = 'shiye-github-publish-v1';
const rootFiles = ['.gitignore', '.gitattributes', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'package.json', '启动拾页.command', '安装到Obsidian.command'];
for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE']) {
  const exists = await fs.lstat(path.join(root, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (exists) rootFiles.push(name);
}
const sourceDirectories = ['core', 'server', 'web', 'desktop', 'extension', 'obsidian', 'scripts', 'tests', 'docs'];
const excluded = new Set(['.git', '.data', '.runtime', '.test-vault', '.artifacts', '.obsidian', '笔记', '拾页笔记', 'dist', 'release', 'github-publish', 'node_modules', '__pycache__']);
const extensions = new Set(['.mjs', '.cjs', '.js', '.json', '.html', '.css', '.svg', '.md', '.txt', '.py', '.command']);
const forbiddenName = /^(?:\.env(?:\..*)?|.*\.(?:p12|pfx|p8|key|pem|dmg|blockmap|log|pyc))$/i;
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /(?:access_token|refresh_token|apiKey|bridgeToken)["']?\s*[:=]\s*["'][A-Za-z0-9_.-]{40,}["']/i,
];

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`发布资料拒绝非普通文件：${path.relative(root, filename)}`);
  return stat;
}

// Never follow source symlinks into a vault, key directory, or external checkout.
async function sourceFiles(relative = '') {
  const filename = path.join(root, relative);
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink()) throw new Error(`源码包含符号链接，请先人工确认：${relative}`);
  if (stat.isDirectory()) {
    const files = [];
    for (const name of (await fs.readdir(filename)).sort()) {
      if (excluded.has(name) || name === '.DS_Store') continue;
      files.push(...await sourceFiles(path.join(relative, name)));
    }
    return files;
  }
  if (!stat.isFile() || (!rootFiles.includes(relative) && !extensions.has(path.extname(relative)))) throw new Error(`未审核的源码文件类型：${relative}`);
  if (forbiddenName.test(path.basename(relative))) throw new Error(`源码范围中出现敏感或生成文件：${relative}`);
  const sizeLimit = relative === 'docs/third-party/LICENSES.chromium.html' ? 8 * 1024 * 1024 : 2 * 1024 * 1024;
  if (stat.size > sizeLimit) throw new Error(`源码文件超过已审核大小限制，请人工检查：${relative}`);
  const text = await fs.readFile(filename, 'utf8');
  if (credentialPatterns.some(pattern => pattern.test(text))) throw new Error(`检测到疑似凭据，停止整理；请检查文件：${relative}`);
  if (/\/Users\/[A-Za-z0-9_.-]+\//.test(text)) throw new Error(`检测到个人电脑绝对路径，请替换为通用说明：${relative}`);
  return [relative];
}

async function assertGeneratedDestination() {
  const stat = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('发布输出位置已被其他文件占用，未修改');
  const manifest = await fs.readFile(path.join(destination, '整理清单.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (manifest?.generator !== marker || manifest.version !== version) throw new Error('现有发布目录不是本工具生成，未覆盖');
}

// Python's standard zipfile preserves Chinese names without macOS zip's
// locale conversion, and reads every entry back for integrity verification.
function verifiedZip(source, archive, files, prefix) {
  const result = JSON.parse(execFileSync('python3', ['-c', `
import hashlib, json, pathlib, sys, zipfile
request = json.load(sys.stdin)
source = pathlib.Path(request['source'])
with zipfile.ZipFile(request['archive'], 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in request['files']:
        archive.write(source / name, request['prefix'] + name)
with zipfile.ZipFile(request['archive']) as archive:
    if archive.testzip() is not None:
        raise RuntimeError('ZIP integrity check failed')
    result = [{'path': item.filename, 'sha256': hashlib.sha256(archive.read(item)).hexdigest()} for item in archive.infolist()]
print(json.dumps(result, ensure_ascii=True))
`], { input: JSON.stringify({ source, archive, files, prefix }), encoding: 'utf8' }));
  if (JSON.stringify(result.map(file => file.path).sort()) !== JSON.stringify(files.map(name => prefix + name).sort())) throw new Error('ZIP 文件清单不匹配');
  return result;
}

const dmgName = `Shiye-${version}-mac-arm64.dmg`;
const dmgOriginal = path.join(root, 'release', dmgName);
const dmgStat = await regularFile(dmgOriginal).catch(error => { if (error.code === 'ENOENT') throw new Error(`缺少 ${dmgName}，请先构建并验收同版本安装包`); throw error; });
await fs.mkdir(parent, { recursive: true });
await assertGeneratedDestination();
const files = [];
for (const entry of [...rootFiles, ...sourceDirectories]) files.push(...await sourceFiles(entry));
const staging = await fs.mkdtemp(path.join(parent, `.preparing-${version}-`));
try {
  const sourceParent = path.join(staging, '01-源码');
  const source = path.join(sourceParent, 'ai-study-notes');
  const assets = path.join(staging, '02-Release附件');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(assets);
  const sourceManifest = [];
  for (const relative of files.sort()) {
    const original = path.join(root, relative), target = path.join(source, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(original, target);
    await fs.chmod(target, (await fs.stat(original)).mode & 0o777);
    sourceManifest.push({ path: relative, sha256: await sha256(target) });
  }
  const sourceArchive = `Shiye-${version}-source.zip`;
  const archiveCheck = verifiedZip(source, path.join(staging, sourceArchive), files, 'ai-study-notes/');
  for (const file of sourceManifest) if (archiveCheck.find(entry => entry.path === `ai-study-notes/${file.path}`)?.sha256 !== file.sha256) throw new Error(`源码 ZIP 内容校验失败：${file.path}`);
  const dmgTarget = path.join(assets, dmgName);
  await fs.copyFile(dmgOriginal, dmgTarget);
  const originalHash = await sha256(dmgOriginal);
  if (originalHash !== await sha256(dmgTarget)) throw new Error('DMG 复制校验失败');
  await fs.copyFile(path.join(root, 'desktop/使用说明.txt'), path.join(assets, '安装说明.txt'));
  const assetNames = [dmgName, '安装说明.txt'];
  const noticesName = `Shiye-${version}-third-party-notices.zip`;
  const noticeFiles = files.filter(name => name === 'THIRD_PARTY_NOTICES.md' || name.startsWith('docs/third-party/'));
  const noticesCheck = verifiedZip(source, path.join(assets, noticesName), noticeFiles, 'third-party-notices/');
  for (const file of noticeFiles) if (noticesCheck.find(entry => entry.path === `third-party-notices/${file}`)?.sha256 !== sourceManifest.find(entry => entry.path === file)?.sha256) throw new Error(`第三方许可 ZIP 内容校验失败：${file}`);
  assetNames.push(noticesName);
  const receiptPath = path.join(root, 'release/安装包清单.json');
  const receiptStat = await fs.lstat(receiptPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (receiptStat) {
    await regularFile(receiptPath);
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    if (receipt.version === version && receipt.dmg === dmgName && receipt.bytes === dmgStat.size) {
      // Publish only known factual fields, never arbitrary local paths or notes.
      const publicReceipt = { version, architecture: 'arm64', minimumMacOS: receipt.minimumMacOS, dmg: dmgName, bytes: dmgStat.size, sha256: originalHash };
      for (const field of ['signature', 'appleNotarized', 'sourceFilesVerified', 'coreTests', 'nativeWindowChecks', 'desktopChecks', 'intelBuild']) if (['string', 'number', 'boolean'].includes(typeof receipt[field])) publicReceipt[field] = receipt[field];
      await fs.writeFile(path.join(assets, '安装包清单.json'), JSON.stringify(publicReceipt, null, 2) + '\n');
      assetNames.push('安装包清单.json');
    }
  }
  const assetManifest = [];
  for (const name of assetNames) assetManifest.push({ path: name, bytes: (await fs.stat(path.join(assets, name))).size, sha256: await sha256(path.join(assets, name)) });
  await fs.writeFile(path.join(assets, 'SHA256SUMS.txt'), assetManifest.map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n');
  const releaseNotes = await fs.readFile(path.join(root, `docs/releases/v${version}.md`), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return `# 拾页 v${version} · Apple Silicon 测试版\n\n下载 ${dmgName}。请在发布前按实际改动补充说明，并确认签名、公证与验收状态。\n\n笔记保存在自选仓库，凭据需自行配置；当前应用不提供在线自动更新。\n`;
  });
  await fs.writeFile(path.join(staging, 'Release说明.md'), releaseNotes);
  await fs.copyFile(path.join(root, 'docs/GitHub发布指南.md'), path.join(staging, '先看我-上传步骤.md'));
  await fs.writeFile(path.join(staging, '整理清单.json'), JSON.stringify({ generator: marker, version, generatedAt: new Date().toISOString(), sourceFileCount: files.length, sourceArchive, sourceArchiveSHA256: await sha256(path.join(staging, sourceArchive)), sourceFiles: sourceManifest, releaseAssets: assetManifest, excluded: [...excluded], checks: { sourceArchiveListing: true, sourceArchiveIntegrity: true, thirdPartyNoticesArchive: true, dmgCopySHA256: true, credentialPatternScan: true }, note: '仅为文件整理与校验记录；未上传 GitHub，不代表重新验收模型或二进制。' }, null, 2) + '\n');
  await assertGeneratedDestination();
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(staging, destination);
  console.log(`已整理 ${files.length} 个源码文件与 ${assetNames.length + 1} 个 Release 附件：${destination}`);
  console.log('未上传 GitHub。先看“先看我-上传步骤.md”，源码上传内容与 Release 附件分开操作。');
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
