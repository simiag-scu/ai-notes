import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { NetworkManager, resolveNetwork } from '../server/network.mjs';

test('网络模式保留本机直连，环境代理凭据不进入可显示地址', () => {
  const manual = resolveNetwork({ mode: 'manual', proxyUrl: 'http://127.0.0.1:7897' });
  assert.equal(manual.active, true); assert.match(manual.environment.no_proxy, /127\.0\.0\.1/); assert.match(manual.environment.no_proxy, /localhost/);
  const automatic = resolveNetwork({ mode: 'auto' }, { HTTPS_PROXY: 'http://private-user:private-password@proxy.example:8080', NO_PROXY: '.internal.example' });
  assert.equal(automatic.proxyUrl, 'http://proxy.example:8080'); assert.match(automatic.environment.no_proxy, /\.internal\.example/);
  assert.equal(automatic.settings.proxyUrl, '');
  assert.equal(resolveNetwork({ mode: 'direct' }, { HTTPS_PROXY: 'http://proxy.example' }).active, false);
  assert.equal(resolveNetwork({ mode: 'auto' }, {}, 'http://localhost:7897').source, 'macOS 系统代理');
  for (const url of ['socks5://localhost:7897', 'http://remote.example:7897', 'http://user:password@localhost:7897', 'http://localhost:7897/path']) assert.throws(() => resolveNetwork({ mode: 'manual', proxyUrl: url }));
});

test('实际 HTTP 代理转发外部请求，本机请求绕过代理；设置持久保存且恢复正常', { skip: typeof http.setGlobalProxyFromEnv !== 'function' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiye-network-'));
  const proxied = [];
  const sockets = new Set();
  const proxy = http.createServer((req, res) => { proxied.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end('{"via":"local-test-proxy"}'); });
  const local = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"via":"local-service"}'); });
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); return socket; };
  proxy.on('connection', track); local.on('connection', track);
  // Node fetch uses CONNECT for HTTP targets too. Only this synthetic hostname
  // is accepted, and the tunnel terminates at the isolated local test origin.
  proxy.on('connect', (req, client, head) => {
    proxied.push(req.url);
    if (req.url !== 'shiye-offline.invalid:80') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = track(net.connect(local.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    }));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  await Promise.all([new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)), new Promise(resolve => local.listen(0, '127.0.0.1', resolve))]);
  const network = new NetworkManager(root, { environment: {}, systemProxy: async () => null });
  t.after(async () => { network.close(); for (const socket of sockets) socket.destroy(); proxy.closeAllConnections(); local.closeAllConnections(); await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => local.close(resolve))]); await fs.rm(root, { recursive: true, force: true }); });
  await network.configure({ mode: 'manual', proxyUrl: `http://127.0.0.1:${proxy.address().port}` });
  assert.equal((await fetch('http://shiye-offline.invalid/check', { signal: AbortSignal.timeout(2500) }).then(r => r.json())).via, 'local-service');
  assert.equal((await fetch(`http://127.0.0.1:${local.address().port}/check`, { signal: AbortSignal.timeout(2500) }).then(r => r.json())).via, 'local-service');
  assert.equal(proxied.length, 1); assert.equal(proxied[0], 'shiye-offline.invalid:80');
  const saved = JSON.parse(await fs.readFile(path.join(root, '.data/network.json'), 'utf8')); assert.equal(saved.mode, 'manual');
  await assert.rejects(network.configure({ mode: 'manual', proxyUrl: 'not-a-proxy' }));
  assert.equal(network.status().mode, 'manual');
  await network.configure({ mode: 'direct' }); assert.equal(network.status().active, false);
});
