import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { ChatGPTAuth } from '../server/auth.mjs';

function fixture(t) {
  const memory = new Map(), originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const auth = new ChatGPTAuth({ secrets: { kind: '隔离内存', get: async key => memory.get(key), set: async (key, value) => memory.set(key, value), remove: async key => memory.delete(key) }, config: { hostId: 'urn:uuid:isolated-test' }, baseURL: 'http://127.0.0.1:17862', changed: () => {} });
  return { auth, memory };
}
test('OAuth 使用 PKCE 和动态客户端；错误 state 不交换凭据，正确签名后才保存', async t => {
  const { auth, memory } = fixture(t); const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const start = new URL((await auth.begin()).url), pending = auth.pending;
  assert.equal(start.origin, 'https://auth.openai.com'); assert.equal(start.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(start.searchParams.get('code_challenge'), createHash('sha256').update(pending.verifier).digest('base64url'));
  let exchanges = 0;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/oauth/token')) {
      exchanges++; const sent = options.body; assert.equal(sent.get('client_id'), 'issued-client'); assert.equal(sent.get('code_verifier'), pending.verifier); assert.equal(sent.get('redirect_uri'), pending.redirect);
      const first = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
      const second = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'issued-client', sub: 'test-user', nonce: pending.nonce, exp: Date.now() / 1000 + 3600 })).toString('base64url');
      const input = `${first}.${second}`, jwt = `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
      return Response.json({ access_token: 'isolated-token', refresh_token: 'isolated-refresh', expires_in: 3600, id_token: jwt, scope: 'openid chatgpt.tokens.use.direct' });
    }
    if (url.endsWith('/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks' });
    if (url.endsWith('/jwks')) return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig' }] });
    throw new Error('unexpected endpoint');
  };
  await assert.rejects(auth.callback(new URLSearchParams({ state: 'wrong', code: 'code', client_id: 'issued-client' })), /验证失败/);
  assert.equal(exchanges, 0); assert.equal(memory.size, 0);
  await auth.callback(new URLSearchParams({ state: pending.state, code: 'code', client_id: 'issued-client' }));
  assert.equal(exchanges, 1); assert.equal((await auth.status()).connected, true); assert.equal(memory.get('chatgpt').client_id, 'issued-client');
  assert.ok(!JSON.stringify(await auth.status()).includes('isolated-token'));
});
test('同时调用只刷新一次，轮换后的 refresh token 被保存', async t => {
  const { auth, memory } = fixture(t);
  memory.set('chatgpt', { access_token: 'expired', refresh_token: 'refresh-one', expires_at: 0, client_id: 'issued', scopes: ['chatgpt.tokens.use.direct'] });
  let calls = 0;
  globalThis.fetch = async (url, options) => { calls++; assert.equal(options.body.get('refresh_token'), 'refresh-one'); await new Promise(resolve => setTimeout(resolve, 15)); return Response.json({ access_token: 'new-token', refresh_token: 'refresh-two', expires_in: 3600 }); };
  const values = await Promise.all(Array.from({ length: 12 }, () => auth.accessToken()));
  assert.equal(calls, 1); assert.ok(values.every(value => value === 'new-token')); assert.equal(memory.get('chatgpt').refresh_token, 'refresh-two');
});
test('公开身份配置被拒绝时保留具体阶段，隐藏凭据，并复用已颁发客户端重新授权', async t => {
  const { auth, memory } = fixture(t); await auth.begin(); const first = auth.pending;
  globalThis.fetch = async url => {
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', id_token: 'secret-id', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' });
    return new Response('<html>secret-provider-body</html>', { status: 403, headers: { 'Content-Type': 'text/html' } });
  };
  await assert.rejects(auth.callback(new URLSearchParams({ state: first.state, code: 'secret-code', client_id: 'issued-client' })), /读取登录配置失败（HTTP 403）/);
  const status = await auth.status(); assert.equal(status.connected, false); assert.equal(status.lastError.stage, 'discovery');
  assert.equal(status.lastError.code, 'upstream_http_403'); assert.equal(memory.size, 0);
  assert.doesNotMatch(JSON.stringify(status), /secret-access|secret-refresh|secret-id|secret-code|secret-provider-body/);
  const retry = new URL((await auth.begin()).url); assert.equal(retry.searchParams.get('client_id'), 'issued-client');
  assert.equal(retry.searchParams.has('agent_name_hint'), false); assert.notEqual(auth.pending.state, first.state); assert.notEqual(auth.pending.verifier, first.verifier);
  assert.equal((await auth.status()).lastError, null);
});
