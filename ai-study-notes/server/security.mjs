import { randomBytes, timingSafeEqual, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
export const token = () => randomBytes(32).toString('base64url');
export function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
export async function protectedJSON(filename, data) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(filename, 0o600);
}
export class SecretStore {
  constructor(directory, service) { this.directory = directory; this.service = service; this.kind = process.platform === 'darwin' ? 'macOS 钥匙串' : '本地受保护文件'; }
  async get(key) {
    if (process.platform === 'darwin') {
      try { return JSON.parse((await run('/usr/bin/security', ['find-generic-password', '-s', this.service, '-a', key, '-w'])).stdout); } catch { return null; }
    }
    try { return JSON.parse(await readFile(path.join(this.directory, `${key}.secret.json`), 'utf8')); } catch { return null; }
  }
  async set(key, data) {
    if (process.platform === 'darwin') {
      try { await run('/usr/bin/security', ['add-generic-password', '-U', '-s', this.service, '-a', key, '-w', JSON.stringify(data)]); }
      catch { throw new Error('无法写入系统钥匙串，请允许访问后重试'); }
    } else await protectedJSON(path.join(this.directory, `${key}.secret.json`), data);
  }
  async remove(key) {
    if (process.platform === 'darwin') { try { await run('/usr/bin/security', ['delete-generic-password', '-s', this.service, '-a', key]); } catch {} }
    else { const { unlink } = await import('node:fs/promises'); await unlink(path.join(this.directory, `${key}.secret.json`)).catch(() => {}); }
  }
}

export function validateIDToken(jwt, jwks, { issuer, audience, nonce, subject, now = Date.now() / 1000 }) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('账号身份凭据无效');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (header.alg !== 'RS256') throw new Error('暂不支持此账号身份签名算法');
  const jwk = jwks.keys?.find(x => x.kid === header.kid && x.kty === 'RSA' && (!x.use || x.use === 'sig'));
  if (!jwk || !verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('账号身份签名验证失败');
  if (claims.iss !== issuer || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience) || !Number.isFinite(claims.exp) || claims.exp < now - 30 || claims.nbf > now + 30 || !claims.sub) throw new Error('账号身份范围或有效期验证失败');
  if (nonce && !same(claims.nonce, nonce)) throw new Error('账号登录随机值验证失败');
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== audience) throw new Error('账号授权接收方验证失败');
  if (subject && claims.sub !== subject) throw new Error('返回账号与所选账号不一致');
  return claims;
}
