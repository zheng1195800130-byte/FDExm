'use strict';

// Small, bounded transport for OpenAI-compatible chat APIs and native Anthropic.
// It never executes tools or exposes a provider's response/error body to the UI.
const DEFAULT_CONFIG = Object.freeze({ enabled: false, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,119}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const REQUEST_TIMEOUT = 60000;
const OUTPUT_CHARS = 100000;
const ERROR_CHARS = 16000;
const MODEL_LIST_CHARS = 4 * 1024 * 1024;
const MODEL_LIST_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 1000;
const MAX_PAGES = 5;
const own = (object, name) => Object.prototype.hasOwnProperty.call(object, name);

function validateConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型设置无效');
  if (own(value, 'enabled') && typeof value.enabled !== 'boolean') throw new Error('自动整理开关无效');
  const provider = value.provider || 'deepseek';
  if (!['deepseek', 'compatible', 'anthropic'].includes(provider)) throw new Error('模型服务类型无效');
  const baseUrl = value.baseUrl == null || value.baseUrl === '' ? DEFAULT_CONFIG.baseUrl : value.baseUrl;
  const model = value.model == null || value.model === '' ? DEFAULT_CONFIG.model : value.model;
  if (typeof baseUrl !== 'string' || baseUrl.length > 2000 || typeof model !== 'string' || !MODEL_ID.test(model)) throw new Error('请检查模型地址和模型名称');
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error('模型接口地址无效'); }
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname))) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('模型地址需使用 HTTPS，或本机 HTTP 地址；不能包含密钥和查询参数');
  // Keep the exact normalization used by the encrypted key's original binding.
  // Endpoint derivation below must never rewrite this persisted public address.
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return { enabled: Boolean(value.enabled), provider, baseUrl: parsed.toString().replace(/\/+$/, ''), model };
}

function requiresApiKey(config = {}) { return !LOOPBACK.has(new URL(validateConfig(config).baseUrl).hostname); }

function endpointFor(config, kind = 'chat') {
  const url = new URL(config.baseUrl);
  let pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|messages|models)$/, '');
  if (config.provider === 'anthropic' && !/\/v\d+(?:beta)?$/.test(pathname)) pathname += '/v1';
  url.pathname = `${pathname}/${kind === 'models' ? 'models' : config.provider === 'anthropic' ? 'messages' : 'chat/completions'}`;
  return url.toString();
}

function checkedKey(config, value) {
  if (typeof value !== 'string' || value.length > 4000 || /[\r\n]/.test(value)) throw new Error('请先填写有效的模型密钥');
  const key = value.trim();
  if (!key && requiresApiKey(config)) throw new Error('请先填写有效的模型密钥');
  return key;
}

function headersFor(config, key) {
  return { 'Content-Type': 'application/json', ...(config.provider === 'anthropic'
    ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
    : key ? { Authorization: `Bearer ${key}` } : {}) };
}

function apiError(status) {
  const messages = { 400: '请求格式不被模型支持，请检查接口和模型名称', 401: '模型密钥无效，请重新填写', 402: '模型账户余额不足', 403: '模型接口拒绝访问，请检查权限', 404: '模型接口或模型不存在，请检查设置', 422: '模型参数不被支持，请检查模型名称', 429: '模型请求过于频繁，请稍后重试', 500: '模型服务暂时异常，请稍后重试', 502: '模型服务暂时异常，请稍后重试', 503: '模型服务繁忙，请稍后重试' };
  return new Error(messages[status] || `模型请求失败（HTTP ${Number.isInteger(status) ? status : '未知'}），请稍后重试`);
}

async function readBounded(response, maxChars, maxBytes = maxChars * 4) {
  if (Number(response.headers?.get?.('content-length') || 0) > maxBytes) throw new Error('response limit');
  let raw = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        raw += decoder.decode(next.value, { stream: true });
        if (bytes > maxBytes || raw.length > maxChars) { await reader.cancel(); throw new Error('response limit'); }
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
  } else if (typeof response.text === 'function') raw = await response.text();
  else raw = JSON.stringify(await response.json());
  if (typeof raw !== 'string' || raw.length > maxChars || Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('response limit');
  return raw;
}

function guardSecret(raw, key) {
  if (key && raw.includes(key)) throw new Error('模型返回了不应包含的敏感信息，未保存本次结果');
}

async function fetchSafe(fetchImpl, url, options, controller) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持模型连接');
  try { return await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal }); }
  catch { throw new Error(controller.signal.aborted ? '模型请求超时，请稍后重试' : '无法连接模型服务，请检查网络和接口地址'); }
}

function fallbackParameters(raw) {
  // Provider error bodies are used only for these booleans, never returned/logged.
  let message = raw;
  let param = '';
  let code = '';
  try {
    const envelope = JSON.parse(raw);
    const error = envelope.error || envelope;
    message = typeof error.message === 'string' ? error.message : raw;
    param = typeof error.param === 'string' ? error.param : '';
    code = typeof error.code === 'string' ? error.code : '';
  } catch { /* A plain text unsupported-parameter error is also unambiguous. */ }
  const unsupported = /(?:unsupported|not[_ -]?supported|does not support|do not support|unrecognized|unknown parameter|extra inputs? (?:are )?not permitted|not (?:allowed|permitted)|不支持|不允许)/i;
  const text = `${param} ${code} ${message}`;
  return {
    json: /response_format/i.test(text) && unsupported.test(text),
    tokens: /(?:^|[^a-z_])max_tokens(?:[^a-z_]|$)/i.test(text) && unsupported.test(text),
  };
}

function parseJsonContent(content, key) {
  if (typeof content !== 'string' || !content.trim() || content.length > OUTPUT_CHARS) throw new Error('模型没有返回有效整理内容，请重试');
  guardSecret(content, key);
  let raw = content.trim();
  if (raw.startsWith('```')) {
    const fenced = raw.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
    if (!fenced) throw new Error('模型没有返回有效 JSON 整理内容，请重试');
    raw = fenced[1].trim();
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('模型没有返回有效 JSON 整理内容，请重试'); }
  guardSecret(JSON.stringify(value), key);
  return value;
}

function extractContent(config, envelope) {
  if (config.provider === 'anthropic') {
    if (envelope?.stop_reason && !['end_turn', 'stop_sequence'].includes(envelope.stop_reason)) throw new Error('模型整理未完整生成，未保存本次结果，请重试');
    return Array.isArray(envelope?.content) ? envelope.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
  }
  const choice = envelope?.choices?.[0];
  if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error('模型整理未完整生成，未保存本次结果，请重试');
  const content = choice?.message?.content;
  return Array.isArray(content) ? content.filter(block => ['text', 'output_text'].includes(block?.type) && typeof block.text === 'string').map(block => block.text).join('\n') : content;
}

function sourceTransport(messages){
 const copy=messages.map(message=>({...message})),user=copy.findLast(message=>message.role==='user');
 let input;try{input=JSON.parse(user.content);}catch{throw new Error('整理来源输入格式无效');}
 if(!Array.isArray(input.sources))throw new Error('整理来源输入格式无效');
 const forward=new Map(),reverse=new Map();
 input.sources=input.sources.map((source,index)=>{const alias=(source.id.startsWith('turn:')?'turn:':'file:')+'source'+(index+1);forward.set(source.id,alias);reverse.set(alias,source.id);return {...source,id:alias};});
 for(const item of input.previousItems||[])if(Array.isArray(item.sourceIds))item.sourceIds=item.sourceIds.map(id=>forward.get(id)||id);
 user.content=JSON.stringify(input);
 const instruction='来源短编号约束：所有新增或更新事项的 sourceIds 必须逐字引用本次 sources[].id 的短编号，例如 turn:source1 或 file:source2。数字仅为示例，必须以本次输入实际列出的编号为准。不要根据编号位置、文件名或旧上下文自造来源。';
 const system=copy.find(message=>message.role==='system');if(system)system.content+='\n'+instruction;else copy.unshift({role:'system',content:instruction});
 return {messages:copy,restore(output){for(const field of ['items','requirements','confirmations'])if(Array.isArray(output?.[field]))for(const item of output[field])if(Array.isArray(item.sourceIds))item.sourceIds=item.sourceIds.map(id=>reverse.get(id)||id);return output;}};
}
async function requestJson(config, apiKey, messages, fetchImpl = globalThis.fetch, { maxTokens = 7000,sourceAliases=false } = {}) {
  const transport=sourceAliases?sourceTransport(messages):null;
  if(transport)messages=transport.messages;
  const normalized = validateConfig(config);
  const key = checkedKey(normalized, apiKey);
  const native = normalized.provider === 'anthropic';
  const payload = native
    ? { model: normalized.model, stream: false, max_tokens: maxTokens, system: messages.filter(message => message.role === 'system').map(message => message.content).join('\n'), messages: messages.filter(message => message.role !== 'system') }
    : { model: normalized.model, messages, stream: false, response_format: { type: 'json_object' }, max_tokens: maxTokens, ...(normalized.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT); timer.unref?.();
  let jsonRetried = false;
  let tokenRetried = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetchSafe(fetchImpl, endpointFor(normalized), { method: 'POST', headers: headersFor(normalized, key), body: JSON.stringify(payload) }, controller);
      if (!response?.ok) {
        let retry = false;
        if (normalized.provider === 'compatible' && [400, 422].includes(response?.status)) {
          let raw = '';
          try { raw = await readBounded(response, ERROR_CHARS); } catch { /* Unsupported classification stays false. */ }
          if (!key || !raw.includes(key)) {
            const fallback = fallbackParameters(raw);
            if (fallback.json && !jsonRetried && payload.response_format) { delete payload.response_format; jsonRetried = true; retry = true; }
            if (fallback.tokens && !tokenRetried && own(payload, 'max_tokens')) { payload.max_completion_tokens = payload.max_tokens; delete payload.max_tokens; tokenRetried = true; retry = true; }
          }
        } else { try { await response?.body?.cancel?.(); } catch { /* No body is exposed. */ } }
        if (retry && attempt < 2) continue;
        throw apiError(response?.status);
      }
      let raw;
      try { raw = await readBounded(response, OUTPUT_CHARS); } catch { throw new Error('模型返回内容无法读取，请重试'); }
      guardSecret(raw, key);
      let envelope;
      try { envelope = JSON.parse(raw); } catch { throw new Error('模型返回内容无法读取，请重试'); }
      guardSecret(JSON.stringify(envelope), key);
      const output=parseJsonContent(extractContent(normalized, envelope), key);
      return transport?transport.restore(output):output;
    }
    throw new Error('模型接口参数不兼容，请检查设置');
  } finally { clearTimeout(timer); }
}

function modelEntries(envelope) {
  const source = Array.isArray(envelope?.data) ? envelope.data : Array.isArray(envelope?.models) ? envelope.models : Array.isArray(envelope) ? envelope : null;
  if (!source || source.length > 5000) throw new Error('模型列表格式不符合要求，请手动填写模型名称');
  const gemini = source === envelope?.models;
  const models = new Map();
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    let id = entry.id || (gemini ? entry.name : '');
    if (gemini && typeof id === 'string') id = id.replace(/^models\//, '');
    if (typeof id !== 'string' || !MODEL_ID.test(id)) continue;
    const label = entry.display_name || entry.displayName || (entry.id ? entry.name : '');
    const name = typeof label === 'string' ? label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) : '';
    if (!models.has(id) || (!models.get(id).name && name)) models.set(id, { id, ...(name ? { name } : {}) });
  }
  if (source.length && !models.size) throw new Error('模型列表中没有有效模型名称，请手动填写');
  return [...models.values()];
}

async function listModels({ config = {}, apiKey = '', fetchImpl = globalThis.fetch } = {}) {
  const normalized = validateConfig(config);
  const key = checkedKey(normalized, apiKey);
  const base = endpointFor(normalized, 'models');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT); timer.unref?.();
  const models = new Map();
  const seenCursors = new Set();
  let url = base;
  let truncated = false;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetchSafe(fetchImpl, url, { method: 'GET', headers: headersFor(normalized, key) }, controller);
      if (!response?.ok) { try { await response?.body?.cancel?.(); } catch { /* No body is exposed. */ } throw apiError(response?.status); }
      let raw;
      try { raw = await readBounded(response, MODEL_LIST_CHARS, MODEL_LIST_BYTES); } catch { throw new Error('模型列表过大或无法读取，请手动填写模型名称'); }
      guardSecret(raw, key);
      let envelope;
      try { envelope = JSON.parse(raw); } catch { throw new Error('模型列表格式不符合要求，请手动填写模型名称'); }
      guardSecret(JSON.stringify(envelope), key);
      for (const model of modelEntries(envelope)) if (!models.has(model.id) || (!models.get(model.id).name && model.name)) models.set(model.id, model);
      const hasMore = envelope.has_more === true || (typeof envelope.nextPageToken === 'string' && Boolean(envelope.nextPageToken));
      if (models.size >= MAX_MODELS) { truncated = models.size > MAX_MODELS || hasMore; break; }
      const cursor = envelope.has_more === true ? envelope.last_id : envelope.nextPageToken;
      if (!hasMore) break;
      if (typeof cursor !== 'string' || !cursor || cursor.length > 2000 || /[\u0000-\u001f]/.test(cursor) || seenCursors.has(cursor) || page === MAX_PAGES - 1) { truncated = true; break; }
      seenCursors.add(cursor);
      const next = new URL(base);
      next.searchParams.set(envelope.has_more === true ? 'after_id' : 'pageToken', cursor);
      url = next.toString();
    }
    const result = [...models.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_MODELS);
    return { models: result, count: result.length, truncated };
  } finally { clearTimeout(timer); }
}

module.exports = { DEFAULT_CONFIG, validateConfig, requiresApiKey, requestJson, listModels };
