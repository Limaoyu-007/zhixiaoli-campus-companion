'use strict';

// The first adapter supports Chat Completions-compatible providers only.
function endpoint(base) {
  let url;
  try { url = new URL(String(base || '').trim().replace(/\/+$/, '')); }
  catch (_) { throw new Error('请在“通用学习”设置中填写有效的模型接口地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('模型接口须使用 HTTPS；本机 localhost 或回环地址可使用 HTTP，地址不可包含账号或查询参数。');
  }
  if (!url.pathname.endsWith('/chat/completions')) url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
  return { url, loopback };
}

function validateConfig(config) {
  const target = endpoint(config.api_base);
  if (!['qwen', 'deepseek', 'custom'].includes(config.provider)) throw new Error('请选择有效的模型厂家类型。');
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 120) throw new Error('请填写有效的对话模型名称。');
  return target;
}

async function readJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('模型接口未返回正文。');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('模型响应过大，已停止读取。');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw new Error('模型接口返回的不是有效 JSON，请核对兼容接口地址。'); }
}

async function complete({ config, messages, tools, signal, onDiagnostic = () => {} }) {
  const { url, loopback } = validateConfig(config);
  if (!config.api_key && !loopback) throw new Error('请先在“通用学习”设置中填写模型 API Key。');
  const body = { model: config.model.trim(), messages, stream: false, max_tokens: 4096 };
  if (tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  if (config.provider === 'qwen') body.enable_thinking = false;
  if (config.provider === 'deepseek') body.thinking = { type: 'disabled' };
  onDiagnostic('study.model.started', { endpoint: url.origin + url.pathname, provider: config.provider,
    model: config.model, messageCount: messages.length, toolCount: tools.length });
  let response;
  try {
    response = await fetch(url, { method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(config.api_key ? { Authorization: 'Bearer ' + config.api_key } : {}) },
      body: JSON.stringify(body) });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('无法连接通用学习模型，请检查网络和接口地址。');
  }
  onDiagnostic('study.model.response', { status: response.status, requestId: response.headers.get('x-request-id') || undefined });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const advice = [401, 403].includes(response.status) ? '请检查 API Key、地域及模型访问权限。'
      : response.status === 429 ? '请求受限或额度不足，请稍后再试并检查账户。' : '请检查接口地址、模型名称和工具调用支持情况。';
    throw new Error('模型请求失败（HTTP ' + response.status + '）。' + advice);
  }
  const result = await readJSON(response);
  const choice = result.choices?.[0];
  const raw = choice?.message;
  if (!raw || raw.role !== 'assistant') throw new Error('模型没有返回有效的 assistant 消息，请核对接口兼容性。');
  if (choice.finish_reason === 'length') throw new Error('模型输出达到长度限制，本轮未完成，请缩小问题范围。');
  if (choice.finish_reason === 'content_filter') throw new Error('本轮输出被模型服务拦截，未完成回答。');
  const message = { role: 'assistant', content: typeof raw.content === 'string' ? raw.content : null };
  if ((message.content?.length || 0) > 64000 || (raw.reasoning_content?.length || 0) > 64000) throw new Error('模型单条消息过长，请缩小问题范围。');
  // Some compatible providers require reasoning_content alongside tool calls on the next request.
  if (typeof raw.reasoning_content === 'string') message.reasoning_content = raw.reasoning_content;
  if (raw.tool_calls !== undefined) {
    if (!Array.isArray(raw.tool_calls) || raw.tool_calls.length > 8) throw new Error('模型返回的工具调用数量或格式无效。');
    const ids = new Set();
    message.tool_calls = raw.tool_calls.map(call => {
      if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 200 || ids.has(call.id) ||
          typeof call.function?.name !== 'string' || call.function.name.length > 100 ||
          typeof call.function.arguments !== 'string' || call.function.arguments.length > 16000) throw new Error('模型返回的工具调用格式无效。');
      ids.add(call.id);
      return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
    });
  }
  return message;
}

module.exports = { complete, validateConfig };
