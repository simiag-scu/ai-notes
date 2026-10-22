import { createHash } from 'node:crypto';
import { token, same, validateIDToken } from './security.mjs';

const authFailure = (code, message) => Object.assign(new Error(message), { authCode: code, safeForDisplay: true });
const stageNames = { callback: '接收授权回调', token_exchange: '交换授权凭据', discovery: '读取登录配置', jwks: '读取身份签名公钥', identity: '验证账号身份', permission: '检查套餐权限', storage: '保存本机登录', refresh: '刷新登录凭据', revoke: '撤销授权' };

export class ChatGPTAuth {
  constructor({ secrets, config, saveConfig, baseURL, changed }) { Object.assign(this, { secrets, config, saveConfig, baseURL, changed }); this.pending = null; this.refreshing = null; this.lastError = null; this.stage = 'callback'; }
  async status() {
    const record = await this.secrets.get('chatgpt');
    return { connected: !!record?.scopes?.includes('chatgpt.tokens.use.direct'), email: record?.email || '', storage: this.secrets.kind, pending: !!this.pending, lastError: this.lastError };
  }
  async begin() {
    const saved = await this.secrets.get('chatgpt');
    this.lastError = null;
    const verifier = token(), nonce = token(), state = token();
    const redirect = `${this.baseURL}/auth/callback`;
    const clientId = saved?.client_id || this.config.pendingRegistration?.clientId || null;
    this.pending = { verifier, nonce, state, redirect, clientId, subject: saved?.subject || null, started: Date.now() };
    const params = new URLSearchParams({ client_id: clientId || 'dynamic_agent_client', ext_agent_host_id: this.config.hostId, response_type: 'code', redirect_uri: redirect, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: 'https://api.openai.com/v1', state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    if (!clientId) params.set('agent_name_hint', 'Shiye Study Notes');
    return { url: `https://auth.openai.com/api/accounts/authorize?${params}` };
  }
  async callback(params) {
    this.stage = 'callback';
    this.processing = true;
    try {
      await this.completeCallback(params);
      this.lastError = null;
      this.changed();
    } catch (error) {
      const message = error.safeForDisplay ? error.message : `连接未完成（${stageNames[this.stage] || '账号授权'}），请重新授权`;
      this.lastError = { code: error.authCode || 'authorization_failed', stage: this.stage, message, at: new Date().toISOString() };
      this.changed();
      throw authFailure(this.lastError.code, message);
    } finally { this.processing = false; }
  }
  async completeCallback(params) {
    const pending = this.pending;
    if (!pending || Date.now() - pending.started > 600000) throw authFailure('request_expired', '登录请求已过期，或工作台在授权期间重启。请返回工作台重新连接');
    if (!same(params.get('state'), pending.state)) throw authFailure('state_mismatch', '登录请求验证失败。请使用最近一次打开的授权页面，或返回工作台重新连接');
    this.pending = null;
    if (params.get('error')) throw authFailure(params.get('error') === 'access_denied' ? 'access_denied' : 'authorization_declined', '账号授权未完成或未被允许。请返回工作台重新连接，并确认授权页面的提示');
    const clientId = params.get('client_id') || pending.clientId;
    if (!clientId || clientId === 'dynamic_agent_client' || (pending.clientId && clientId !== pending.clientId) || !params.get('code')) throw authFailure('incomplete_callback', '未收到有效的账号连接标识或授权码，请重新连接');
    // Retain only the issued client ID for a fresh retry; never retain a failed code.
    this.config.pendingRegistration = { clientId };
    await this.saveConfig?.();
    this.stage = 'token_exchange';
    const data = await this.exchange({ grant_type: 'authorization_code', client_id: clientId, code: params.get('code'), code_verifier: pending.verifier, redirect_uri: pending.redirect, resource: 'https://api.openai.com/v1' });
    this.stage = 'discovery';
    const discovery = await this.fetchJSON('https://auth.openai.com/.well-known/openid-configuration', { signal: AbortSignal.timeout(20000) });
    if (discovery.issuer !== 'https://auth.openai.com' || !/^https:\/\/auth\.openai\.com\//.test(discovery.jwks_uri)) throw authFailure('discovery_invalid', '身份校验服务地址异常，本次未保存登录');
    this.stage = 'jwks';
    const jwks = await this.fetchJSON(discovery.jwks_uri, { signal: AbortSignal.timeout(20000) });
    this.stage = 'identity';
    let claims;
    try { claims = validateIDToken(data.id_token, jwks, { issuer: discovery.issuer, audience: clientId, nonce: pending.nonce, subject: pending.subject }); }
    catch { throw authFailure('identity_invalid', '账号身份校验未通过，本次未保存登录。请重新授权'); }
    this.stage = 'permission';
    const scopes = String(data.scope || '').split(/\s+/);
    if (!scopes.includes('chatgpt.tokens.use.direct')) throw authFailure('plan_permission_missing', '账号未授予套餐调用权限，请重新授权并确认套餐使用权限');
    this.stage = 'storage';
    await this.secrets.set('chatgpt', { ...data, client_id: clientId, subject: claims.sub, email: claims.email || '', scopes, expires_at: Date.now() + Number(data.expires_in || 3600) * 1000 });
    delete this.config.pendingRegistration;
    await this.saveConfig?.();
  }
  async fetchJSON(url, options = {}) {
    const stage = stageNames[this.stage] || '连接登录服务';
    let response;
    try { response = await fetch(url, { ...options, headers: { Accept: 'application/json', ...options.headers } }); }
    catch (error) { throw authFailure(error.name === 'TimeoutError' ? 'network_timeout' : 'network_error', `${stage}时无法连接 OpenAI${error.name === 'TimeoutError' ? '（请求超时）' : ''}。请检查本机后台的网络连接后重新授权`); }
    if (!response.ok) {
      let data; try { data = await response.json(); } catch {}
      const providerCode = typeof data?.error === 'string' ? data.error : data?.error?.code;
      if (providerCode === 'invalid_grant') throw authFailure('invalid_grant', '授权码已失效或已使用，请返回工作台重新连接；不要刷新旧回调页面');
      if (providerCode === 'invalid_client') throw authFailure('invalid_client', 'OpenAI 未接受当前应用的账号连接标识，请重新连接或检查应用注册状态');
      throw authFailure(`upstream_http_${response.status}`, `${stage}失败（HTTP ${response.status}）${response.status === 403 ? '：OpenAI 拒绝了本机后台请求；请检查网络或登录服务的访问限制后重新授权' : '，请稍后重新授权'}`);
    }
    let data;
    try { data = await response.json(); } catch { throw authFailure('invalid_response', `${stage}返回的内容无法识别，请稍后重新授权`); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw authFailure('invalid_response', `${stage}返回的内容无法识别，请稍后重新授权`);
    return data;
  }
  async exchange(values) {
    if (values.grant_type === 'refresh_token') this.stage = 'refresh';
    const data = await this.fetchJSON('https://auth.openai.com/api/accounts/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values), signal: AbortSignal.timeout(30000) });
    if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw authFailure('incomplete_credentials', '授权服务返回了不完整的凭据，请重新连接');
    return data;
  }
  async accessToken() {
    let saved = await this.secrets.get('chatgpt');
    if (!saved?.scopes?.includes('chatgpt.tokens.use.direct')) throw new Error('请先在设置中连接 ChatGPT 账号');
    if (saved.expires_at > Date.now() + 60000) return saved.access_token;
    if (!saved.refresh_token) throw new Error('登录已过期，请重新连接 ChatGPT');
    if (!this.refreshing) this.refreshing = (async () => {
      const update = await this.exchange({ grant_type: 'refresh_token', client_id: saved.client_id, refresh_token: saved.refresh_token, resource: 'https://api.openai.com/v1' });
      const scopes = update.scope ? update.scope.split(/\s+/) : saved.scopes;
      if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Error('套餐权限已失效，请重新连接');
      saved = { ...saved, ...update, scopes, expires_at: Date.now() + Number(update.expires_in || 3600) * 1000 };
      await this.secrets.set('chatgpt', saved);
      return saved.access_token;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async disconnect() {
    const saved = await this.secrets.get('chatgpt');
    let revoked = false;
    if (saved?.refresh_token) {
      try {
        const discovery = await fetch('https://auth.openai.com/.well-known/openid-configuration', { signal: AbortSignal.timeout(10000) }).then(r => r.json());
        if (!/^https:\/\/auth\.openai\.com\//.test(discovery.revocation_endpoint)) throw new Error('endpoint');
        const response = await fetch(discovery.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: saved.refresh_token, token_type_hint: 'refresh_token', client_id: saved.client_id }), signal: AbortSignal.timeout(10000) });
        revoked = response.ok;
      } catch {}
    }
    await this.secrets.remove('chatgpt'); this.pending = null; this.lastError = null;
    delete this.config.pendingRegistration; await this.saveConfig?.();
    return { revoked, message: revoked ? '已断开账号连接' : '本机已退出；可在 ChatGPT 设置中确认或撤销远端授权' };
  }
}
