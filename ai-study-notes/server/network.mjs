import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { protectedJSON } from './security.mjs';
import { upstreamError } from './upstream-errors.mjs';

const run = promisify(execFile);
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function proxyURL(value, localOnly = false) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请填写有效的 HTTP 或 HTTPS 代理地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw new Error('请使用 HTTP/Mixed 代理地址，例如 http://127.0.0.1:7897');
  if (localOnly && (!localHosts.has(url.hostname) || url.username || url.password)) throw new Error('指定代理只支持不含账号密码的本机 HTTP/Mixed 地址');
  return url.href;
}
const publicProxyURL = value => { if (!value) return ''; const url = new URL(value); return `${url.protocol}//${url.host}`; };

export function resolveNetwork(settings, environment = {}, systemProxy = null) {
  const mode = settings.mode || 'auto';
  if (!['auto', 'manual', 'direct'].includes(mode)) throw new Error('请选择有效的后台网络方式');
  let httpProxy = '', httpsProxy = '', source = mode === 'direct' ? '系统网络' : '自动：系统网络';
  if (mode === 'manual') { httpProxy = httpsProxy = proxyURL(settings.proxyUrl, true); source = '指定本机代理'; }
  else if (mode === 'auto') {
    httpProxy = environment.http_proxy || environment.HTTP_PROXY || '';
    httpsProxy = environment.https_proxy || environment.HTTPS_PROXY || httpProxy;
    if (httpProxy || httpsProxy) { httpProxy ||= httpsProxy; source = '环境变量代理'; }
    else if (systemProxy) { httpProxy = httpsProxy = systemProxy; source = 'macOS 系统代理'; }
    else if (environment.all_proxy || environment.ALL_PROXY) throw new Error('当前只有 ALL_PROXY；请在拾页中指定 HTTP/Mixed 代理地址');
  }
  if (httpProxy) httpProxy = proxyURL(httpProxy);
  if (httpsProxy) httpsProxy = proxyURL(httpsProxy);
  const exclusions = mode === 'direct' ? '*' : [...new Set(['127.0.0.1', 'localhost', '::1', '[::1]', ...String(environment.no_proxy || environment.NO_PROXY || '').split(',').map(x => x.trim()).filter(Boolean)])].join(',');
  return { settings: { mode, proxyUrl: mode === 'manual' ? httpProxy : '' }, source, active: !!(httpProxy || httpsProxy), proxyUrl: publicProxyURL(httpsProxy || httpProxy), environment: { http_proxy: httpProxy, https_proxy: httpsProxy, no_proxy: exclusions } };
}

async function macOSProxy() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await run('/usr/sbin/scutil', ['--proxy'], { timeout: 1500 });
    const read = key => stdout.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*([^\\n]+)`))?.[1]?.trim();
    for (const type of ['HTTPS', 'HTTP']) {
      const host = read(`${type}Proxy`), port = Number(read(`${type}Port`));
      if (read(`${type}Enable`) === '1' && host && Number.isInteger(port) && port > 0 && port < 65536) {
        const url = new URL('http://localhost'); url.hostname = host; url.port = String(port); return url.href;
      }
    }
  } catch {}
  return null;
}

export class NetworkManager {
  constructor(root, { environment = process.env, systemProxy = macOSProxy, applyProxy = null } = {}) { this.filename = path.join(root, '.data', 'network.json'); this.environment = environment; this.systemProxy = systemProxy; this.applyProxy = applyProxy; this.current = resolveNetwork({ mode: 'direct' }); this.restore = null; }
  async init() {
    let settings = { mode: 'auto' };
    try { settings = JSON.parse(await fs.readFile(this.filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('后台网络配置无法读取，请检查 .data/network.json'); }
    await this.configure(settings, false); return this;
  }
  status() { const { settings, active, source, proxyUrl } = this.current; return { ...settings, proxyUrl, active, source, available: true }; }
  async configure(settings, persist = true) {
    const next = resolveNetwork(settings, this.environment, settings.mode === 'auto' ? await this.systemProxy() : null);
    if (next.active && !this.applyProxy && typeof http.setGlobalProxyFromEnv !== 'function') throw new Error('此 Node.js 版本不支持后台代理，请使用 Node.js 25.4 或更新版本');
    const previous = this.current;
    if (persist) { await protectedJSON(this.filename + '.tmp', next.settings); await fs.rename(this.filename + '.tmp', this.filename); }
    try {
      this.restore?.();
      this.restore = this.applyProxy ? this.applyProxy(next.environment) : typeof http.setGlobalProxyFromEnv === 'function' ? http.setGlobalProxyFromEnv(next.environment) : null;
      this.current = next;
    } catch {
      this.restore = this.applyProxy ? this.applyProxy(previous.environment) : typeof http.setGlobalProxyFromEnv === 'function' ? http.setGlobalProxyFromEnv(previous.environment) : null;
      if (persist) await protectedJSON(this.filename, previous.settings);
      throw new Error('后台代理配置未能生效，已恢复原连接方式');
    }
    return this.status();
  }
  async check({ provider = 'chatgpt' } = {}) {
    const targets = provider === 'deepseek' ? [['DeepSeek 模型接口', 'https://api.deepseek.com/models', null]] : [['登录配置', 'https://auth.openai.com/.well-known/openid-configuration', 'issuer'], ['身份签名公钥', 'https://auth.openai.com/.well-known/jwks.json', 'keys'], ['OpenAI 模型接口', 'https://api.openai.com/v1/models', null]];
    const results = await Promise.all(targets.map(async ([name, url, field]) => {
      try {
        // An unauthenticated models request should return 401. It checks the
        // actual model host without sending credentials or consuming AI quota.
        const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
        const data = await response.json().catch(() => null);
        return { name, status: response.status, ok: field ? response.ok && !!data?.[field] : (response.ok && !!(data?.data || data?.models)) || (response.status === 401 && !!data?.error) };
      } catch (error) { const readable = upstreamError(error, { provider }); return { name, status: null, ok: false, error: readable.diagnostic ? readable.message : '无法连接，请检查代理是否开启及地址是否正确', code: readable.diagnostic?.code || null }; }
    }));
    return { ok: results.every(x => x.ok), network: this.status(), results };
  }
  close() { this.restore?.(); this.restore = null; }
}
