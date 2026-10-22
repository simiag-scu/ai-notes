import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { protectedJSON } from '../server/security.mjs';

const readJSON = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const ordinaryPath = value => typeof value === 'string' && value.endsWith('.md') && !path.isAbsolute(value) && !value.split(/[\\/]/).some(p => !p || p === '..' || p.startsWith('.'));

export async function inspectLegacy(directory, vault) {
  const source = await fs.realpath(directory), base = await fs.realpath(vault);
  const files = {};
  for (const name of ['state.json', 'connection.json', 'network.json']) {
    const filename = path.join(source, '.data', name);
    try {
      if (!(await fs.lstat(filename)).isFile()) throw new Error('旧版数据必须是普通文件');
      files[name] = await readJSON(filename);
    } catch (error) { if (name !== 'network.json' || error.code !== 'ENOENT') throw new Error(`无法读取旧版 ${name}，请选择原项目文件夹并保留原始数据`); }
  }
  const state = files['state.json'], connection = files['connection.json'];
  if (state.version !== 1 || !Array.isArray(state.notes) || !state.settings || !Array.isArray(state.usage) || !Array.isArray(state.activity) || !/^[a-zA-Z0-9_-]{30,}$/.test(connection.bridgeToken || '') || !connection.instanceId || !connection.hostId) throw new Error('旧版数据格式无法识别，未进行导入');
  for (const note of state.notes) {
    if (!ordinaryPath(note.path)) throw new Error('旧版笔记路径无效，未进行导入');
    const actual = await fs.realpath(path.join(base, note.path)).catch(() => null);
    if (!actual || !actual.startsWith(base + path.sep)) throw new Error(`所选仓库内找不到原笔记：${note.path}。请先选择原来的 Obsidian 仓库`);
  }
  return { source, vault: base, files, notes: state.notes.length, chats: state.chats?.length || 0 };
}

export class WorkspaceStore {
  constructor(directory) { this.directory = directory; this.filename = path.join(directory, 'desktop.json'); this.config = null; }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.config = await readJSON(this.filename); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('应用设置无法读取。请保留应用数据目录后恢复备份，不要覆盖已有记录'); this.config = { version: 1, activeWorkspaceId: null, workspaces: [] }; }
    if (this.config.version !== 1 || !Array.isArray(this.config.workspaces) || this.config.workspaces.some(x => !/^[0-9a-f-]{36}$/.test(x.id) || !path.isAbsolute(x.vaultPath || ''))) throw new Error('应用设置版本无法识别，已有数据未改动');
    return this;
  }
  get active() { return this.config.workspaces.find(x => x.id === this.config.activeWorkspaceId) || null; }
  root(workspace) { return path.join(this.directory, 'workspaces', workspace.id); }
  async save() { await protectedJSON(this.filename + '.tmp', this.config); await fs.rename(this.filename + '.tmp', this.filename); }
  async prepare(vault, legacyDirectory = null) {
    const vaultPath = await fs.realpath(vault);
    if (!(await fs.stat(vaultPath)).isDirectory()) throw new Error('请选择笔记文件夹');
    const existing = this.config.workspaces.find(x => x.vaultPath === vaultPath);
    if (existing) {
      if (legacyDirectory) throw new Error('这个仓库已有独立应用记录，不能重复导入旧版覆盖');
      const previous = this.config.activeWorkspaceId;
      this.config.activeWorkspaceId = existing.id;
      try { await this.save(); } catch (error) { this.config.activeWorkspaceId = previous; throw error; }
      return existing;
    }
    const legacy = legacyDirectory ? await inspectLegacy(legacyDirectory, vaultPath) : null;
    const workspace = { id: randomUUID(), vaultPath, name: path.basename(vaultPath), createdAt: new Date().toISOString(), ...(legacy ? { importedFrom: legacy.source } : {}) };
    const root = this.root(workspace), temporary = root + '.importing';
    await fs.mkdir(path.join(temporary, '.data'), { recursive: true, mode: 0o700 });
    try {
      if (legacy) for (const [name, data] of Object.entries(legacy.files)) await protectedJSON(path.join(temporary, '.data', name), data);
      await fs.rename(temporary, root);
      const previous = this.config.activeWorkspaceId;
      this.config.workspaces.push(workspace); this.config.activeWorkspaceId = workspace.id;
      try { await this.save(); }
      catch (error) { this.config.workspaces.pop(); this.config.activeWorkspaceId = previous; await fs.rm(root, { recursive: true, force: true }); throw error; }
      return workspace;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
}

export function safeExternalURL(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (['https:', 'http:'].includes(url.protocol)) return true;
    return url.protocol === 'obsidian:' && url.hostname === 'open' && !!url.searchParams.get('vault') && !url.searchParams.has('command');
  } catch { return false; }
}
