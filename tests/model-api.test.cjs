'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listModels, requestJson, requiresApiKey, validateConfig } = require('../src/core/model-api.cjs');
const { summarizeDay, testConnection } = require('../src/core/summarizer.cjs');

const config = { enabled: true, provider: 'compatible', baseUrl: 'https://provider.example/v1', model: 'provider/chat-model' };
const key = 'unit-only-credential';
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (content, extra = {}) => ({ choices: [{ finish_reason: 'stop', message: { content }, ...extra }] });
const messages = [{ role: 'system', content: '只输出 JSON。' }, { role: 'user', content: '测试内容，无真实客户资料。' }];
const turn = { id: 'today-one', date: '2026-10-09', threadId: 'thread', timestamp: '2026-10-09T01:00:00Z', completed: true, userText: '表格导入失败', assistantText: '已修改格式识别，样例通过，待客户测试', attachments: [], sourceRef: 'local#today-one' };
const item = { issueKey: 'import', title: '表格导入失败', cause: '格式变化', action: '调整格式识别', result: '样例通过，待客户测试', status: '待验证', turnIds: ['today-one'] };

test('model discovery sends only GET metadata and normalizes, filters, sorts and deduplicates model IDs', async () => {
  let seen;
  const result = await listModels({ config: { ...config, baseUrl: 'https://provider.example/v1/chat/completions' }, apiKey: key, fetchImpl: async (url, options) => {
    seen = { url, ...options };
    return response({ data: [{ id: 'z-model' }, { id: 'a/model:free' }, { id: 'z-model', name: 'Z Model' }, { id: '<script>alert(1)</script>' }, { id: 'bad\nmodel' }, { id: 123 }, { id: 'x'.repeat(121) }] });
  } });
  assert.equal(seen.url, 'https://provider.example/v1/models');
  assert.equal(seen.method, 'GET');
  assert.equal(seen.body, undefined);
  assert.equal(seen.redirect, 'error');
  assert.equal(seen.headers.Authorization, `Bearer ${key}`);
  assert.deepEqual(result, { models: [{ id: 'a/model:free' }, { id: 'z-model', name: 'Z Model' }], count: 2, truncated: false });
  assert.doesNotMatch(JSON.stringify(result), /script|unit-only-credential|bad/);
});

test('Gemini model list shapes and OpenAI-compatible Google base path are accepted', async () => {
  let url;
  const result = await listModels({ config: { ...config, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' }, apiKey: key, fetchImpl: async value => {
    url = value;
    return response({ models: [{ name: 'models/gemini-flash', displayName: 'Gemini Flash' }, { name: 'models/gemini-pro', displayName: 'Gemini Pro' }] });
  } });
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
  assert.deepEqual(result.models, [{ id: 'gemini-flash', name: 'Gemini Flash' }, { id: 'gemini-pro', name: 'Gemini Pro' }]);
});

test('Anthropic models accept root, v1, full messages, and custom gateway prefixes without changing stored addresses', async () => {
  for (const [baseUrl, expected] of [
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/models'],
    ['https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/models'],
    ['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/models'],
    ['https://gateway.example/api/anthropic', 'https://gateway.example/api/anthropic/v1/models'],
  ]) {
    const options = { ...config, provider: 'anthropic', baseUrl };
    const normalized = validateConfig(options);
    const result = await listModels({ config: options, apiKey: key, fetchImpl: async (url, init) => {
      assert.equal(url, expected);
      assert.equal(init.headers['x-api-key'], key);
      assert.equal(init.headers['anthropic-version'], '2023-06-01');
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.body, undefined);
      return response({ data: [{ id: 'claude-sample', display_name: 'Claude Sample' }], has_more: false });
    } });
    assert.equal(normalized.baseUrl, baseUrl);
    assert.deepEqual(result.models, [{ id: 'claude-sample', name: 'Claude Sample' }]);
  }
});

test('model pagination remains on configured origin, stops repeated cursors, and limits count and pages', async () => {
  const urls = [];
  const result = await listModels({ config: { ...config, provider: 'anthropic' }, apiKey: key, fetchImpl: async url => {
    urls.push(url);
    return response({ data: [{ id: urls.length === 1 ? 'a-model' : 'b-model' }], has_more: true, last_id: 'same-cursor', next: 'https://evil.example/steal-key' });
  } });
  assert.equal(urls.length, 2);
  assert.equal(urls[1], 'https://provider.example/v1/models?after_id=same-cursor');
  assert.equal(result.count, 2);
  assert.equal(result.truncated, true);
  let calls = 0;
  const limited = await listModels({ config, apiKey: key, fetchImpl: async () => {
    calls++;
    return response({ models: [{ name: `models/gemini-${calls}` }], nextPageToken: `page-${calls}` });
  } });
  assert.equal(calls, 5);
  assert.equal(limited.count, 5);
  assert.equal(limited.truncated, true);
  const many = await listModels({ config, apiKey: key, fetchImpl: async () => response({ data: Array.from({ length: 1500 }, (_, index) => ({ id: `model-${String(index).padStart(4, '0')}` })) }) });
  assert.equal(many.count, 1000);
  assert.equal(many.models.at(-1).id, 'model-0999');
  assert.equal(many.truncated, true);
});

test('model discovery failures are concise and cannot expose credentials or provider bodies', async () => {
  for (const [fetchImpl, pattern] of [
    [async () => response({ error: { message: `Bearer ${key}, server-private-data` } }, 401), /密钥无效/],
    [async () => response({ data: [{ id: key }] }), /敏感信息/],
    [async () => response({ data: [{ id: '<invalid>' }] }), /有效模型/],
    [async () => response({ strange: 'provider-private-data' }), /列表格式/],
    [async () => new Response('x'.repeat(4 * 1024 * 1024 + 1), { status: 200 }), /过大或无法读取/],
    [async () => { throw new Error(`Error Bearer ${key}`); }, /无法连接/],
  ]) {
    await assert.rejects(listModels({ config, apiKey: key, fetchImpl }), error => {
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /unit-only-credential|server-private-data|provider-private-data|Bearer/);
      return true;
    });
  }
});

test('JSON-escaped credentials cannot leak through parsed model names or nested generated JSON', async () => {
  const escapedKey = key.replaceAll('-', '\\u002d');
  for (const raw of [`{"data":[{"id":"${escapedKey}"}]}`, `{"data":[{"id":"safe-model","name":"${escapedKey}"}]}`]) {
    assert.equal(raw.includes(key), false);
    await assert.rejects(listModels({ config, apiKey: key, fetchImpl: async () => new Response(raw, { status: 200 }) }), error => {
      assert.match(error.message, /敏感信息/);
      assert.equal(error.message.includes(key), false);
      return true;
    });
  }
  const escapedOutput = `{"ok":true,"unexpected":"${escapedKey}"}`;
  await assert.rejects(requestJson(config, key, messages, async () => response(completion(escapedOutput))), error => {
    assert.match(error.message, /敏感信息/);
    assert.equal(error.message.includes(key), false);
    return true;
  });
});

test('large rich-metadata catalogs return only compact names and enforce a separate byte budget', async () => {
  const result = await listModels({ config, apiKey: key, fetchImpl: async () => response({ data: Array.from({ length: 600 }, (_, index) => ({ id: `rich-${index}`, description: 'large catalog metadata '.repeat(100), pricing: { input: '0.000001' } })) }) });
  assert.equal(result.count, 600);
  assert.equal(result.truncated, false);
  assert.ok(JSON.stringify(result).length < 30000);
  await assert.rejects(listModels({ config, apiKey: key, fetchImpl: async () => response({ data: [{ id: 'rich-model', description: '文'.repeat(3 * 1024 * 1024) }] }) }), /过大或无法读取/);
});

test('only exact loopback hosts allow anonymous API calls and never receive an empty auth header', async () => {
  for (const baseUrl of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1', 'https://localhost/v1']) assert.equal(requiresApiKey({ ...config, baseUrl }), false);
  for (const baseUrl of ['https://localhost.evil.example', 'https://127.0.0.2', 'https://provider.example']) assert.equal(requiresApiKey({ ...config, baseUrl }), true);
  let calls = 0;
  await assert.rejects(listModels({ config, apiKey: '', fetchImpl: async () => { calls++; } }), /密钥/);
  assert.equal(calls, 0);
  const local = { ...config, baseUrl: 'http://localhost:11434/v1' };
  assert.equal((await listModels({ config: local, apiKey: '', fetchImpl: async (_url, options) => { assert.equal(options.headers.Authorization, undefined); return response({ data: [{ id: 'qwen-local' }] }); } })).count, 1);
  const summarized = await summarizeDay({ date: turn.date, turns: [turn], config: local, apiKey: '', fetchImpl: async (_url, options) => { assert.equal(options.headers.Authorization, undefined); return response(completion(JSON.stringify({ items: [item] }))); } });
  assert.equal(summarized.method, 'model');
  assert.equal(summarized.items[0].title, item.title);
});

test('native Anthropic summaries use separate system instructions, native auth, and text content only', async () => {
  let seen;
  const native = { ...config, provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/messages', model: 'claude-sample' };
  const result = await summarizeDay({ date: turn.date, turns: [turn], config: native, apiKey: key, fetchImpl: async (url, options) => {
    seen = { url, headers: options.headers, body: JSON.parse(options.body) };
    return response({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'do not retain reasoning' }, { type: 'text', text: '```json\n' + JSON.stringify({ items: [item] }) + '\n```' }] });
  } });
  assert.equal(result.method, 'model');
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.headers['x-api-key'], key);
  assert.equal(seen.headers.Authorization, undefined);
  assert.match(seen.body.system, /只输出 JSON/);
  assert.deepEqual(seen.body.messages.map(value => value.role), ['user']);
  assert.equal(seen.body.response_format, undefined);
  assert.equal(seen.body.max_tokens, 7000);
  assert.doesNotMatch(JSON.stringify(result), /reasoning|unit-only-credential/);
  await assert.rejects(testConnection({ config: native, apiKey: key, fetchImpl: async () => response({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok":true}' }] }) }), /未完整生成/);
});

test('compatible JSON fallback is one bounded retry only after an explicit unsupported response_format error', async () => {
  const payloads = [];
  const result = await summarizeDay({ date: turn.date, turns: [turn], config, apiKey: key, fetchImpl: async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return payloads.length === 1 ? response({ error: { param: 'response_format', code: 'unsupported_parameter', message: 'response_format is not supported for this model' } }, 400)
      : response(completion('```json\n' + JSON.stringify({ items: [item] }) + '\n```'));
  } });
  assert.equal(result.items.length, 1);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0].response_format, { type: 'json_object' });
  assert.equal(payloads[1].response_format, undefined);
  assert.deepEqual(payloads[0].messages, payloads[1].messages);
  assert.equal(payloads[1].max_tokens, 7000);
});

test('generic provider 400, authentication, server errors and malformed JSON never cause parameter fallback', async () => {
  for (const [status, error] of [
    [400, { message: 'Bad request: invalid response_format value' }],
    [400, { message: 'Unknown parameter unrelated_field' }],
    [401, { message: 'response_format is not supported' }],
    [500, { message: 'response_format is not supported' }],
  ]) {
    let calls = 0;
    await assert.rejects(requestJson(config, key, messages, async () => { calls++; return response({ error }, status); }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(requestJson(config, key, messages, async () => { calls++; return response(completion('This is not JSON')); }), /有效 JSON/);
  assert.equal(calls, 1);
});

test('token compatibility retry replaces max_tokens once and total retries stay bounded', async () => {
  const payloads = [];
  const result = await requestJson(config, key, messages, async (_url, options) => {
    const payload = JSON.parse(options.body); payloads.push(payload);
    if (payloads.length === 1) return response({ error: { message: "Unsupported parameter: 'response_format'" } }, 400);
    if (payloads.length === 2) return response({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }, 400);
    return response(completion('{"ok":true}'));
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(payloads.length, 3);
  assert.equal(payloads[2].max_tokens, undefined);
  assert.equal(payloads[2].max_completion_tokens, 7000);
  assert.equal(payloads[2].response_format, undefined);
  let calls = 0;
  await assert.rejects(requestJson(config, key, messages, async () => { calls++; return response({ error: { message: "Unsupported parameter: 'response_format'" } }, 400); }));
  assert.equal(calls, 2);
});

test('JSON fallback still enforces source references and refuses credential-bearing error body retries', async () => {
  let calls = 0;
  await assert.rejects(summarizeDay({ date: turn.date, turns: [turn], config, apiKey: key, fetchImpl: async () => {
    calls++;
    return calls === 1 ? response({ error: { message: 'response_format is not supported' } }, 400) : response(completion(JSON.stringify({ items: [{ ...item, turnIds: ['fake-turn'] }] })));
  } }), /不存在的对话/);
  // One JSON-parameter fallback, then one bounded schema correction; invalid
  // sources remain rejected even after the correction attempt.
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(requestJson(config, key, messages, async () => { calls++; return response({ error: { message: `response_format is not supported; Bearer ${key}` } }, 400); }), error => { assert.doesNotMatch(error.message, /unit-only-credential|Bearer/); return true; });
  assert.equal(calls, 1);
});

test('only a complete JSON markdown fence is unwrapped; surrounding explanations remain invalid', async () => {
  for (const content of ['{"ok":true}', '```json\n{"ok":true}\n```', '```\n{"ok":true}\n```']) assert.deepEqual(await requestJson(config, key, messages, async () => response(completion(content))), { ok: true });
  for (const content of ['Here is the JSON:\n{"ok":true}', '```json\n{"ok":true}\n```\nExplanation', '```javascript\n{"ok":true}\n```', '```json\n{"ok":true}']) await assert.rejects(requestJson(config, key, messages, async () => response(completion(content))), /有效 JSON/);
});
