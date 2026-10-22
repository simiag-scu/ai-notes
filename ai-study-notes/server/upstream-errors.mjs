const reasons = {
  ECONNREFUSED: '连接被拒绝，请检查代理是否开启、端口是否正确',
  ENOTFOUND: '无法解析服务地址，请检查网络或代理的 DNS',
  EAI_AGAIN: '域名解析暂时失败，请稍后重试或检查代理',
  UND_ERR_CONNECT_TIMEOUT: '建立连接超时，请检查代理节点是否可用',
  ETIMEDOUT: '网络连接超时，请检查代理节点是否可用',
  ECONNRESET: '网络连接被中断，请检查代理节点后重试',
  EPIPE: '网络连接被中断，请检查代理节点后重试',
  UND_ERR_SOCKET: '网络连接被中断，请检查代理节点后重试',
  UND_ERR_HEADERS_TIMEOUT: '等待服务响应超时，请稍后重试',
  UND_ERR_BODY_TIMEOUT: '接收回答超时，请检查网络后重试',
  CERT_HAS_EXPIRED: '安全连接的证书已过期，请检查系统时间或代理证书',
  DEPTH_ZERO_SELF_SIGNED_CERT: '安全连接的证书无法验证，请检查代理的证书配置',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '安全连接的证书无法验证，请检查代理的证书配置',
  ERR_TLS_CERT_ALTNAME_INVALID: '安全连接的证书与服务地址不符，请检查代理配置'
};

// Only retain known transport codes. Never expose exception messages, headers,
// socket details, provider bodies or URLs that might contain private values.
export function upstreamError(error, { provider = 'chatgpt', phase = 'request' } = {}) {
  if (error?.diagnostic || error?.safeForDisplay || error?.name === 'AbortError') return error;
  const queue = [error], seen = new Set(); let code = null, network = false;
  while (queue.length && seen.size < 12) {
    const current = queue.shift(); if (!current || seen.has(current)) continue; seen.add(current);
    if (reasons[current.code]) { code ||= current.code; network = true; }
    if (current.name === 'TimeoutError') { code ||= 'REQUEST_TIMEOUT'; network = true; }
    if (/^(fetch failed|terminated|Failed to fetch|NetworkError when attempting to fetch resource\.)$/.test(current.message || '')) network = true;
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors.slice(0, 8));
  }
  if (!network) return error;
  code ||= 'NETWORK_CONNECTION_FAILED';
  const service = provider === 'deepseek' ? 'DeepSeek' : provider === 'openai' ? 'OpenAI API' : 'ChatGPT';
  const stage = phase === 'stream' ? '接收回答' : phase === 'models' ? '读取模型目录' : '连接';
  const reason = reasons[code] || (code === 'REQUEST_TIMEOUT' ? '请求超时，请检查网络后重试' : '请求未能完成，请检查代理节点与后台网络设置后重试');
  return Object.assign(new Error(`${service} ${stage}失败：${reason}（${code}）`, { cause: error }), { diagnostic: { kind: 'network', provider, phase, code, at: new Date().toISOString() } });
}
