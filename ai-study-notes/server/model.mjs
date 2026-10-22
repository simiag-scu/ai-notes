import { parseModelBlocks, estimateTokens } from '../core/format.mjs';
import { upstreamError } from './upstream-errors.mjs';

export async function readResponses(stream, onDelta = () => {}) {
  let buffer = '', text = '', completed = false, usage = null;
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop();
    for (const frame of frames) {
      const payload = frame.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
      if (!payload || payload === '[DONE]') continue;
      let data; try { data = JSON.parse(payload); } catch { throw new Error('模型响应格式异常'); }
      if (data.type === 'response.output_text.delta') { const delta = data.delta || ''; text += delta; onDelta(text.length, delta); }
      if (data.type === 'response.failed' || data.type === 'error' || data.type === 'response.incomplete') {
        const code = data.response?.error?.code || data.error?.code || data.code;
        throw new Error(String(code || '').includes('usage_limit') ? '当前套餐或应用额度不足，请到 ChatGPT 使用情况中查看' : '模型未完成输出，请重试');
      }
      if (data.type === 'response.completed') {
        completed = true; usage = data.response?.usage;
        if (!text) { text = (data.response?.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join(''); if (text) onDelta(text.length, text); }
      }
    }
  }
  if (!completed) throw new Error('模型连接中断，未收到完整结果，已有笔记未改动');
  if (!text.trim()) throw new Error('模型没有返回可显示的回答，请重试或切换模型');
  return { text, usage };
}

export async function readDeepSeek(stream, onDelta = () => {}) {
  const decoder = new TextDecoder(); let buffer = '', text = '', usage = null, finish = null, done = false;
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop();
    for (const frame of frames) {
      const payload = frame.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
      if (!payload) continue;
      if (payload === '[DONE]') { done = true; continue; }
      let data; try { data = JSON.parse(payload); } catch { throw new Error('模型响应格式异常'); }
      if (data.error) throw new Error('DeepSeek 未完成回答，请检查模型或额度后重试');
      const choice = data.choices?.[0], delta = choice?.delta?.content || '';
      if (delta) { text += delta; onDelta(text.length, delta); }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (data.usage) usage = data.usage;
    }
  }
  if (!done || finish !== 'stop' || !text.trim()) throw new Error(finish === 'length' ? '回答达到模型长度限制，部分内容已保留，可重新提问' : 'DeepSeek 连接中断，未收到完整回答');
  return { text, usage };
}

export class ModelClient {
  constructor({ auth, secrets, settings }) { Object.assign(this, { auth, secrets, settings }); }
  async models() {
    try {
    if (this.settings.provider === 'chatgpt') {
      const access = await this.auth.accessToken();
      const response = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('无法读取此账号可用模型');
      const data = await response.json();
      return (data.models || data.data || []).filter(x => !x.visibility || x.visibility === 'list').map(x => ({ id: x.slug || x.id, name: x.display_name || x.id || x.slug }));
    }
    const key = (await this.secrets.get(`api-key:${this.settings.provider}`))?.key;
    if (!key) throw new Error('请先填写此服务的 API Key 并保存偏好');
    const endpoint = this.settings.provider === 'deepseek' ? 'https://api.deepseek.com/models' : 'https://api.openai.com/v1/models';
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`读取模型失败（${response.status}）`);
    const data = await response.json();
    return (data.data || []).map(x => ({ id: x.id, name: x.id }));
    } catch (error) { throw upstreamError(error, { provider: this.settings.provider, phase: 'models' }); }
  }
  async generate(instructions, content, signal, onProgress) {
    const bodyText = typeof content === 'string' ? content : JSON.stringify(content);
    const result = await this.chat(instructions, [{ role: 'user', content: bodyText }], signal, onProgress);
    return { blocks: parseModelBlocks(result.text), usage: result.usage };
  }
  async chat(instructions, messages, signal, onProgress = () => {}) {
    const provider = this.settings.provider;
    const key = provider === 'chatgpt' ? await this.auth.accessToken() : (await this.secrets.get(`api-key:${provider}`))?.key;
    if (!key) throw new Error('请先连接账号或配置 API Key');
    if (!this.settings.model) throw new Error('请先选择此账号可用的模型');
    const bodyText = JSON.stringify(messages);
    let phase = 'request';
    try {
    let text, usage;
    if (provider === 'chatgpt' || provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.settings.model, instructions, input: messages, store: false, stream: true }), signal });
      if (!response.ok) throw new Error(`模型请求失败（${response.status}）${response.status === 429 ? '，请检查套餐额度' : ''}`);
      phase = 'stream';
      ({ text, usage } = await readResponses(response.body, onProgress));
    } else {
      const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.settings.model, messages: [{ role: 'system', content: instructions }, ...messages], thinking: { type: 'disabled' }, stream: true, stream_options: { include_usage: true } }), signal });
      if (!response.ok) throw new Error(`模型请求失败（${response.status}）`);
      phase = 'stream';
      ({ text, usage } = await readDeepSeek(response.body, onProgress));
    }
    return { text, usage: { input: usage?.input_tokens ?? usage?.prompt_tokens ?? estimateTokens(instructions + bodyText), output: usage?.output_tokens ?? usage?.completion_tokens ?? estimateTokens(text), cached: usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0, estimated: !usage } };
    } catch (error) { throw upstreamError(error, { provider, phase }); }
  }
}
