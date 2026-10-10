'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { summarizeDay, groupCompletedTurns, dayFingerprint, turnFingerprint, turnCheckpoints, validateConfig, testConnection } = require('../src/core/summarizer.cjs');
const { readThread } = require('../src/core/codex.cjs');

const config = { enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
const turn = (id, date = '2026-10-09', extra = {}) => ({ id, date, timestamp: `${date}T01:00:00Z`, threadId: 'thread', completed: true,
  userText: '导入文件失败，请修复', assistantText: '已调整格式识别，样例通过，等待客户测试', sourceRef: `local#${id}`, attachments: [], ...extra });
const item = (turnIds = ['t1'], extra = {}) => ({ issueKey: 'import_fix', title: '表格导入失败', cause: '文件格式变化', action: '调整格式识别', result: '样例通过，待客户测试', status: '待验证', turnIds, ...extra });
const completion = data => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] });
const mockFetch = data => async () => new Response(JSON.stringify(completion(data)), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('config uses current DeepSeek model and disallows credentials or remote plaintext URLs', () => {
  assert.deepEqual(validateConfig(), { enabled: false, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  assert.equal(validateConfig({ baseUrl: 'http://localhost:1234/v1/' }).baseUrl, 'http://localhost:1234/v1');
  for (const baseUrl of ['http://example.com', 'https://user:secret@example.com', 'https://api.deepseek.com?key=secret', 'file:///secrets']) assert.throws(() => validateConfig({ baseUrl }));
  assert.throws(() => validateConfig({ model: 'model\r\nsecret' }));
  assert.throws(() => validateConfig({ enabled: 'true' }));
});

test('completed turns group by Shanghai date and fingerprints ignore unfinished messages and input order', () => {
  const first = turn('t1', '2026-10-08');
  const second = turn('t2');
  const pending = turn('pending', '2026-10-09', { completed: false });
  const invalid = turn('invalid', '2026-02-30');
  const groups = groupCompletedTurns([second, first, pending, invalid]);
  assert.deepEqual([...groups.keys()], ['2026-10-08', '2026-10-09']);
  assert.equal(groups.get('2026-10-09').length, 1);
  assert.equal(dayFingerprint([first, second, pending], config), dayFingerprint([second, first], config));
  assert.notEqual(dayFingerprint([second], config), dayFingerprint([{ ...second, assistantText: '后来发现仍有错误' }], config));
  assert.notEqual(dayFingerprint([second], config), dayFingerprint([second], { ...config, model: 'another-model' }));
  assert.notEqual(dayFingerprint([second], config), dayFingerprint([{ ...second, attachments: [{ type: 'file', path: 'D:\\客户\\样例.xlsx' }] }], config));
});

test('turn checkpoints track completed source revisions without depending on input order or retaining text', () => {
  const first = turn('t1'), second = turn('t2'), pending = turn('pending', '2026-10-09', { completed: false });
  const checkpoints = turnCheckpoints([second, pending, first]);
  assert.deepEqual(checkpoints, turnCheckpoints([first, second]));
  assert.equal(checkpoints.t1, turnFingerprint(first));
  assert.match(checkpoints.t1, /^[0-9a-f]{64}$/);
  assert.equal(turnFingerprint(pending), '');
  assert.notEqual(checkpoints.t1, turnFingerprint({ ...first, assistantText: '修订后仍有错误' }));
  assert.notEqual(checkpoints.t1, turnFingerprint({ ...first, attachments: [{ type: 'file', path: 'D:\\资料\\新样例.xlsx' }] }));
  assert.doesNotMatch(JSON.stringify(checkpoints), /导入|处理|样例|pending/);
});

test('incremental summaries send only new turn text and compact old issues while preserving unrelated daily work', async () => {
  const existing = [
    { ...item(['old-import']), attachments: [{ type: 'file', path: 'D:\\资料\\旧账单.xlsx', description: '旧来源' }], sourceRef: 'local#old-import' },
    { ...item(['old-folder'], { issueKey: 'folder_fix', title: '修复目录选择', action: '修正页面来源校验', result: '目录选择通过', status: '已完成' }), attachments: [], sourceRef: 'local#old-folder' },
  ];
  const snapshot = JSON.stringify(existing);
  const newTurn = turn('t2', '2026-10-09', { userText: '本轮新增格式修复', assistantText: '新格式自测通过，等待用户测试', attachments: [{ type: 'image', path: 'D:\\资料\\新截图.png', description: '新来源' }] });
  let payload;
  const result = await summarizeDay({ date: '2026-10-09', turns: [newTurn], existingItems: existing,
    previousItems: existing.map(value => ({ ...value, date: '2026-10-09' })), config, apiKey: 'secret', fetchImpl: async (_url, options) => {
      payload = JSON.parse(JSON.parse(options.body).messages[1].content);
      return mockFetch({ items: [item(['t2'], { issueKey: 'new_import_iteration', title: '完善账单导入兼容', action: '修复新格式并完成样例回归', result: '新格式自测通过，待客户测试', relatedIssueKeys: ['import_fix'] })] })();
    } });
  assert.deepEqual(payload.turns.map(value => value.id), ['t2']);
  assert.deepEqual(payload.allowedTurnIds, ['t2']);
  assert.deepEqual(payload.historicalIssues, []);
  assert.deepEqual(payload.existingIssues.map(value => value.issueKey), ['import_fix', 'folder_fix']);
  assert.deepEqual(payload.dailySoFar, []);
  for (const value of payload.existingIssues) for (const field of ['turnIds', 'sourceRef', 'attachments', 'userText', 'assistantText']) assert.equal(value[field], undefined);
  assert.doesNotMatch(JSON.stringify(payload), /old-import|old-folder|旧账单|local#/);
  assert.equal(result.items.length, 2);
  const updated = result.items.find(value => value.issueKey === 'import_fix');
  assert.deepEqual(updated.turnIds, ['old-import', 't2']);
  assert.equal(updated.action, '修复新格式并完成样例回归');
  assert.equal(updated.result, '新格式自测通过，待客户测试');
  assert.deepEqual(updated.attachments.map(value => value.path), ['D:\\资料\\旧账单.xlsx', 'D:\\资料\\新截图.png']);
  assert.equal(updated.sourceRef, 'local#old-import\nlocal#t2');
  assert.deepEqual(result.items.find(value => value.issueKey === 'folder_fix'), existing[1]);
  assert.equal(JSON.stringify(existing), snapshot, '不修改调用方已有摘要');
});

test('multiple incremental iterations and revised source turns update one issue with complete trusted provenance', async () => {
  let existing = [{ ...item(['old'], { relatedIssueKeys: ['legacy_import'] }), sourceRef: 'local#old', attachments: [] }];
  const requests = [];
  for (const [index, id] of ['new-one', 'new-two', 'new-two'].entries()) {
    const result = await summarizeDay({ date: '2026-10-09', turns: [turn(id, '2026-10-09', { assistantText: `本次修订结果${index}` })], existingItems: existing, config, apiKey: 'secret', fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(JSON.parse(options.body).messages[1].content));
      return mockFetch({ items: [item([id], { issueKey: 'legacy_import', title: '完善账单导入', action: `本次关键调整${index}`, result: `本次修订结果${index}` })] })();
    } });
    existing = result.items;
  }
  assert.equal(existing.length, 1);
  assert.equal(existing[0].issueKey, 'import_fix');
  assert.deepEqual(existing[0].relatedIssueKeys, ['legacy_import']);
  assert.deepEqual(existing[0].turnIds, ['old', 'new-one', 'new-two']);
  assert.equal(existing[0].result, '本次修订结果2');
  assert.equal(existing[0].action, '本次关键调整2');
  assert.deepEqual(requests.map(value => value.turns.map(entry => entry.id)), [['new-one'], ['new-two'], ['new-two']]);
  assert.equal(requests[2].existingIssues[0].result, '本次修订结果1');
});

test('existing summaries do not authorize old turn IDs or force an unrelated update into their group', async () => {
  const existing = [{ ...item(['old']), attachments: [], sourceRef: 'local#old' }];
  let calls = 0;
  await assert.rejects(summarizeDay({ date: '2026-10-09', turns: [turn('new')], existingItems: existing, config, apiKey: 'secret', fetchImpl: async () => {
    calls++; return mockFetch({ items: [item(['old'])] })();
  } }), /引用了不存在的对话/);
  assert.equal(calls, 2);
  const result = await summarizeDay({ date: '2026-10-09', turns: [turn('old')], existingItems: existing, config, apiKey: 'secret', fetchImpl: mockFetch({ items: [
    item(['old'], { issueKey: 'folder_fix', title: '修复目录选择', action: '修正目录选择器' }),
  ] }) });
  assert.equal(result.items.length, 2, '共享修订轮次不自动合并独立事项');
  assert.deepEqual(result.items.find(value => value.issueKey === 'import_fix'), existing[0]);
});

test('empty and local incremental updates retain old daily summaries without a model call', async () => {
  const existing = [{ ...item(['old']), attachments: [], sourceRef: 'local#old' }];
  let calls = 0;
  const unchanged = await summarizeDay({ date: '2026-10-09', turns: [], existingItems: existing, config, apiKey: 'secret', fetchImpl: async () => { calls++; } });
  assert.deepEqual(unchanged.items, existing); assert.equal(calls, 0);
  const local = await summarizeDay({ date: '2026-10-09', turns: [turn('new', '2026-10-09', { assistantText: '事项：表格导入失败\n处理：修复新格式兼容\n结果：样例通过，待客户测试' })], existingItems: existing, config: { ...config, enabled: false } });
  assert.equal(local.method, 'local'); assert.equal(local.items.length, 1);
  assert.deepEqual(local.items[0].turnIds, ['old', 'new']);
  assert.equal(local.items[0].action, '修复新格式兼容');
});

test('incremental rolling compaction absorbs related old groups and preserves unaffected work without replaying old sources', async () => {
  const existing = [
    { ...item(['old-api'], { issueKey: 'model_api', title: '模型接入' }), attachments: [{ type: 'file', path: 'D:\\资料\\旧接口.txt' }], sourceRef: 'local#old-api' },
    { ...item(['old-list'], { issueKey: 'model_list', title: '模型列表' }), attachments: [{ type: 'image', path: 'D:\\资料\\旧列表.png' }], sourceRef: 'local#old-list' },
    { ...item(['old-folder'], { issueKey: 'folder_fix', title: '目录选择' }), attachments: [], sourceRef: 'local#old-folder' },
  ];
  const turns = [turn('new-one', '2026-10-09', { userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) }),
    turn('new-two', '2026-10-09', { timestamp: '2026-10-09T02:00:00Z', userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) })];
  const requests = [];
  const result = await summarizeDay({ date: '2026-10-09', turns, existingItems: existing, config, apiKey: 'secret', fetchImpl: async (_url, options) => {
    const data = JSON.parse(JSON.parse(options.body).messages[1].content); requests.push(data);
    return mockFetch({ items: [item(data.allowedTurnIds, { issueKey: 'model_api', title: '完善模型配置', relatedIssueKeys: ['model_list'], action: '完善接入、列表和选择回填', result: requests.length === 1 ? '列表已回填' : '回归通过，待客户测试' })] })();
  } });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].allowedTurnIds, ['new-one']);
  assert.deepEqual(requests[1].allowedTurnIds, ['new-one', 'new-two']);
  assert.deepEqual(requests[1].dailySoFar[0].turnIds, ['new-one']);
  assert.doesNotMatch(JSON.stringify(requests), /old-api|old-list|old-folder|旧接口|旧列表|local#/);
  assert.equal(result.items.length, 2);
  const combined = result.items.find(value => value.issueKey === 'model_api');
  assert.deepEqual(combined.turnIds, ['old-api', 'old-list', 'new-one', 'new-two']);
  assert.deepEqual(combined.relatedIssueKeys, ['model_list']);
  assert.equal(combined.attachments.length, 2);
  assert.equal(combined.result, '回归通过，待客户测试');
  assert.deepEqual(result.items.find(value => value.issueKey === 'folder_fix'), existing[2]);
});

test('local mode saves only explicit compact outcomes and combines repeated issue within a day', async () => {
  let calls = 0;
  const turns = [
    turn('t1', '2026-10-09', { assistantText: '事项：表格导入失败\n处理：复现客户文件\n结果：仍然失败' }),
    turn('t2', '2026-10-09', { timestamp: '2026-10-09T02:00:00Z', assistantText: '事项：表格导入失败\n原因：格式变化\n处理：调整格式识别\n结果：样例通过，待客户测试' }),
    turn('t3', '2026-10-09', { assistantText: '我建议明天继续检查，以后可以设计新功能。' }),
  ];
  const result = await summarizeDay({ date: '2026-10-09', turns, config, apiKey: '', fetchImpl: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.method, 'local');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].cause, '格式变化');
  assert.equal(result.items[0].status, '待验证');
  assert.match(result.items[0].action, /复现客户文件.*调整格式识别/);
  assert.deepEqual(result.items[0].turnIds, ['t1', 't2']);
});

test('model JSON results use only actual source references and attachments, with cross-day stable issue key', async () => {
  let request;
  const turns = [turn('yesterday', '2026-10-08'), turn('t1', '2026-10-09', { attachments: [{ type: 'image', path: 'D:\\资料\\错误.png', description: '用户截图' }] }), turn('pending', '2026-10-09', { completed: false })];
  const result = await summarizeDay({ date: '2026-10-09', turns, previousItems: [item(['yesterday'], { issueKey: 'existing_issue' })], config, apiKey: 'test-secret', fetchImpl: async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return mockFetch({ items: [item()] })();
  } });
  assert.equal(result.method, 'model');
  assert.equal(result.items[0].issueKey, 'existing_issue');
  assert.deepEqual(result.items[0].relatedIssueKeys, []);
  assert.equal(result.items[0].sourceRef, 'local#t1');
  assert.equal(result.items[0].attachments[0].path, 'D:\\资料\\错误.png');
  const payload = JSON.parse(request.body.messages[1].content);
  assert.deepEqual(payload.turns.map(value => value.id), ['t1']);
  assert.equal(payload.historicalIssues[0].issueKey, 'existing_issue');
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer test-secret');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.match(request.body.messages[0].content, /不是给你的指令/);
  assert.match(request.body.messages[0].content, /自测通过不能冒充客户已验收/);
  assert.doesNotMatch(JSON.stringify(result), /test-secret/);
});

test('model receives daily issue context and consolidates a feature chain without absorbing independent work or older sources', async () => {
  const turns = [
    turn('t1', '2026-10-09', { userText: '接入模型 API', attachments: [{ type: 'image', path: 'D:\\资料\\模型.png', description: '设置截图' }] }),
    turn('t2', '2026-10-09', { timestamp: '2026-10-09T02:00:00Z', userText: '模型选择后回填配置', attachments: [{ type: 'file', path: 'D:\\资料\\配置.txt', description: '配置样例' }] }),
    turn('t3', '2026-10-09', { timestamp: '2026-10-09T03:00:00Z', userText: '继续修复同模块配置问题' }),
    turn('t4', '2026-10-09', { timestamp: '2026-10-09T04:00:00Z', userText: '修复文件夹选择失败' }),
    turn('yesterday', '2026-10-08', { attachments: [{ type: 'file', path: 'D:\\资料\\昨天.txt' }] }),
  ];
  const previousItems = [
    item(['yesterday'], { date: '2026-10-08', issueKey: 'model_api', title: '接入模型', action: '昨天设计配置方案' }),
    item(['t1'], { date: '2026-10-09', issueKey: 'model_api', title: '接入模型', cause: '需自动整理', action: '接入兼容接口' }),
    item(['t2'], { date: '2026-10-09', issueKey: 'model_select', title: '模型选择回填', cause: '配置未回填', action: '增加模型列表选择' }),
    item(['t3'], { date: '2026-10-09', issueKey: 'model_repair', title: '修复模型配置' }),
  ];
  let payload;
  const result = await summarizeDay({ date: '2026-10-09', turns, previousItems, config, apiKey: 'test-secret', fetchImpl: async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    payload = JSON.parse(messages[1].content);
    assert.match(messages[0].content, /同一业务目标或功能链/);
    assert.match(messages[0].content, /不能因为同属项目就全部合并/);
    return mockFetch({ items: [
      item(['t1', 't2', 't3'], { issueKey: 'new_model_group', title: '完善模型接入与配置', cause: '需自动整理与便捷配置', action: '接入模型，完善选择回填和相关修复', result: '自测通过，待客户测试', relatedIssueKeys: ['model_repair', 'model_select', 'model_api'] }),
      item(['t4'], { issueKey: 'folder_fix', title: '修复文件夹选择', action: '修正页面来源校验', result: '目录选择通过', status: '已完成' }),
    ] })();
  } });
  assert.equal(result.items.length, 2);
  const consolidated = result.items.find(value => value.issueKey === 'model_api');
  assert.ok(consolidated);
  assert.deepEqual(new Set(consolidated.relatedIssueKeys), new Set(['model_repair', 'model_select']));
  assert.deepEqual(consolidated.turnIds, ['t1', 't2', 't3']);
  assert.deepEqual(consolidated.attachments.map(value => value.path), ['D:\\资料\\模型.png', 'D:\\资料\\配置.txt']);
  assert.equal(consolidated.sourceRef, 'local#t1\nlocal#t2\nlocal#t3');
  assert.equal(consolidated.result, '自测通过，待客户测试');
  assert.doesNotMatch(JSON.stringify(result.items), /昨天|yesterday/);
  assert.equal(result.items.find(value => value.issueKey === 'folder_fix').turnIds[0], 't4');
  assert.equal(payload.historicalIssues[0].date, '2026-10-08');
  assert.equal(payload.historicalIssues[0].turnIds, undefined);
  assert.equal(payload.historicalIssues[1].turnIds, undefined);
  assert.equal(payload.historicalIssues[1].cause, '需自动整理');
  assert.equal(payload.historicalIssues[1].action, '接入兼容接口');
});

test('relation validation rejects invented aliases and hidden historical turn references', async () => {
  const previousItems = [
    item(['hidden'], { date: '2026-10-09', issueKey: 'existing_api', title: '接入模型', relatedIssueKeys: ['existing_list'] }),
    item(['hidden_rule'], { date: '2026-10-09', issueKey: 'existing_rules', title: '规则配置' }),
  ];
  const invalid = [
    { items: [item(['t1'], { relatedIssueKeys: ['invented_key'] })] },
    { items: [item(['t1'], { relatedIssueKeys: 'existing_api' })] },
    { items: [item(['hidden'], { issueKey: 'existing_api', title: '接入模型' })] },
    { items: [item(['t1'], { relatedIssueKeys: [], extraField: '不得增加' })] },
  ];
  for (const data of invalid) await assert.rejects(summarizeDay({ date: '2026-10-09', turns: [turn('t1'), turn('t2')], previousItems, config, apiKey: 'secret', fetchImpl: mockFetch(data) }), /模型/);
  const result = await summarizeDay({ date: '2026-10-09', turns: [turn('t1')], previousItems, config, apiKey: 'secret', fetchImpl: mockFetch({ items: [item(['t1'], { issueKey: 'existing_list', title: '完善模型配置' })] }) });
  assert.equal(result.items[0].issueKey, 'existing_api');
  assert.deepEqual(result.items[0].relatedIssueKeys, ['existing_list']);
});

test('unknown aliases get one constrained correction using the same source data and explicit allowed IDs', async () => {
  const previousItems = [item(['old'], { date: '2026-10-08', issueKey: 'known_import', relatedIssueKeys: ['known_format'] })];
  const requests = [];
  const result = await summarizeDay({ date: '2026-10-09', turns: [turn('t1')], previousItems, config, apiKey: 'secret', fetchImpl: async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    const input = JSON.parse(messages[1].content); requests.push(input);
    assert.match(messages[0].content, /只能逐字引用 allowedIssueKeys/);
    return mockFetch({ items: [item(['t1'], { relatedIssueKeys: requests.length === 1 ? ['invented_alias'] : ['known_import'] })] })();
  } });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].allowedIssueKeys, ['known_import', 'known_format']);
  assert.deepEqual(requests[0].allowedTurnIds, ['t1']);
  assert.equal(requests[0].correction, undefined);
  assert.match(requests[1].correction.error, /关联了不存在的事项/);
  const { correction, ...retriedData } = requests[1];
  assert.deepEqual(retriedData, requests[0], '纠正仍使用同一份原始资料和已验证上下文');
  assert.doesNotMatch(JSON.stringify(requests[1]), /invented_alias/, '不把未经验证的模型输出回传');
  assert.equal(result.items[0].issueKey, 'known_import');
  assert.deepEqual(result.items[0].turnIds, ['t1']);
});

test('second invalid correction preserves the first safe error without filtering claims or retrying again', async () => {
  let calls = 0;
  await assert.rejects(summarizeDay({ date: '2026-10-09', turns: [turn('t1')], config, apiKey: 'secret', fetchImpl: async () => {
    calls++;
    return mockFetch({ items: [calls === 1 ? item(['t1'], { relatedIssueKeys: ['invented_alias'] }) : item(['invented_turn'])] })();
  } }), error => {
    assert.equal(error.message, '模型整理关联了不存在的事项，未保存本次结果');
    return true;
  });
  assert.equal(calls, 2);
});

test('schema and real turn reference errors can each be corrected once without relaxing validation', async () => {
  for (const invalid of [item(['invented_turn']), item(['t1'], { status: '客户已验收' }), item(['t1'], { attachments: [] })]) {
    let calls = 0;
    const result = await summarizeDay({ date: '2026-10-09', turns: [turn('t1')], config, apiKey: 'secret', fetchImpl: async () => {
      calls++; return mockFetch({ items: [calls === 1 ? invalid : item(['t1'])] })();
    } });
    assert.equal(calls, 2);
    assert.deepEqual(result.items[0].turnIds, ['t1']);
    assert.equal(result.items[0].status, '待验证');
  }
});

test('self aliases are discarded as a no-op while other unknown aliases still require correction', async () => {
  let calls = 0;
  const result = await summarizeDay({ date: '2026-10-09', turns: [turn('t1')], config, apiKey: 'secret', fetchImpl: async () => {
    calls++; return mockFetch({ items: [item(['t1'], { relatedIssueKeys: ['import_fix'] })] })();
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.items[0].relatedIssueKeys, []);
});

test('request transport, rate limits, JSON and secret guard failures do not trigger correction requests', async () => {
  for (const respond of [
    async () => { throw new Error('network'); },
    async () => new Response('not exposed', { status: 401 }),
    async () => new Response('not exposed', { status: 429 }),
    async () => new Response(JSON.stringify({ choices: [{ message: { content: 'invalid JSON' } }] }), { status: 200 }),
    mockFetch({ items: [item(['t1'], { cause: 'private-model-key' })] }),
  ]) {
    let calls = 0;
    await assert.rejects(summarizeDay({ date: '2026-10-09', turns: [turn('t1')], config, apiKey: 'private-model-key', fetchImpl: async (...args) => { calls++; return respond(...args); } }), /模型|密钥/);
    assert.equal(calls, 1);
  }
});

test('rolling updates omit old source IDs safely while unrelated new groups leave old work intact', async () => {
  const turns = [turn('t1', '2026-10-09', { userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) }),
    turn('t2', '2026-10-09', { timestamp: '2026-10-09T02:00:00Z', userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) })];
  for (const update of ['same-identity', 'independent']) {
    const requests = [];
    const result = await summarizeDay({ date: '2026-10-09', turns, config, apiKey: 'secret', fetchImpl: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).messages[1].content); requests.push(input);
      if (requests.length === 2) return mockFetch({ items: [update === 'same-identity'
        ? item(['t2'], { issueKey: 'stable_import' })
        : item(['t2'], { issueKey: 'unrelated_new', title: '其他事项' })] })();
      return mockFetch({ items: [item(input.allowedTurnIds, { issueKey: 'stable_import' })] })();
    } });
    assert.equal(requests.length, 2, '省略旧来源或旧项不需要额外模型纠正');
    assert.deepEqual(requests[1].allowedIssueKeys, ['stable_import']);
    const stable = result.items.find(value => value.issueKey === 'stable_import');
    assert.deepEqual(stable.turnIds, update === 'same-identity' ? ['t1', 't2'] : ['t1']);
    assert.equal(result.items.length, update === 'same-identity' ? 1 : 2);
    assert.equal(requests[1].correction, undefined);
  }
});

test('duplicate stable identities recover as one latest outcome with all real source turns and attachments', async () => {
  const turns = [
    turn('t1', '2026-10-09', { attachments: [{ type: 'file', path: 'D:\\资料\\账单.xlsx', description: '客户账单' }] }),
    turn('t2', '2026-10-09', { timestamp: '2026-10-09T02:00:00Z', attachments: [{ type: 'image', path: 'D:\\资料\\回归.png', description: '测试截图' }] }),
    turn('t3', '2026-10-09', { timestamp: '2026-10-09T03:00:00Z' }),
  ];
  const result = await summarizeDay({ date: '2026-10-09', turns, config, apiKey: 'secret', fetchImpl: mockFetch({ items: [
    item(['t3'], { issueKey: 'bill_import', title: '完善账单导入', action: '修正导入与金额校验', result: '回归通过，待客户测试', status: '待验证' }),
    item(['t1'], { issueKey: 'bill_import', title: '账单导入', action: '逐个检查旧格式文件', result: '仍然失败', status: '未解决' }),
    item(['t2'], { issueKey: 'bill_import', title: '调整账单导入', action: '增加格式兼容', result: '导入通过', status: '已完成' }),
  ] }) });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].issueKey, 'bill_import');
  assert.equal(result.items[0].title, '完善账单导入');
  assert.equal(result.items[0].action, '修正导入与金额校验');
  assert.equal(result.items[0].result, '回归通过，待客户测试');
  assert.equal(result.items[0].status, '待验证');
  assert.deepEqual(result.items[0].turnIds, ['t1', 't2', 't3']);
  assert.deepEqual(result.items[0].attachments.map(value => value.path), ['D:\\资料\\账单.xlsx', 'D:\\资料\\回归.png']);
  assert.equal(result.items[0].sourceRef, 'local#t1\nlocal#t2\nlocal#t3');
});

test('overlapping validated historical aliases merge transitively using earliest stable identity', async () => {
  const previousItems = [
    item(['hidden'], { date: '2026-10-08', issueKey: 'first_api', title: '接入模型', relatedIssueKeys: ['first_list'] }),
    item(['hidden_rules'], { date: '2026-10-08', issueKey: 'second_rules', title: '规则设置' }),
    item(['hidden_config'], { date: '2026-10-08', issueKey: 'third_config', title: '配置回填' }),
  ];
  const turns = ['t1', 't2', 't3'].map((id, index) => turn(id, '2026-10-09', { timestamp: `2026-10-09T0${index + 1}:00:00Z` }));
  const result = await summarizeDay({ date: '2026-10-09', turns, previousItems, config, apiKey: 'secret', fetchImpl: mockFetch({ items: [
    item(['t1', 't3'], { issueKey: 'second_rules', title: '规则与回填', relatedIssueKeys: ['third_config'], result: '首次配置仍失败', status: '未解决' }),
    item(['t2', 't3'], { issueKey: 'first_list', title: '模型列表', result: '模型列表已回填', status: '已完成' }),
    item(['t3'], { issueKey: 'new_config', title: '完善模型配置', relatedIssueKeys: ['first_api', 'second_rules'], action: '完善接入、规则和配置回填', result: '样例通过，待客户测试' }),
  ] }) });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].issueKey, 'first_api');
  assert.deepEqual(new Set(result.items[0].relatedIssueKeys), new Set(['first_list', 'second_rules', 'third_config']));
  assert.deepEqual(result.items[0].turnIds, ['t1', 't2', 't3']);
  assert.equal(result.items[0].action, '完善接入、规则和配置回填');
  assert.equal(result.items[0].result, '样例通过，待客户测试');
  assert.doesNotMatch(JSON.stringify(result.items), /hidden/);
});

test('independent model identities stay separate even with matching titles and shared source turns', async () => {
  const result = await summarizeDay({ date: '2026-10-09', turns: [turn('t1')], config, apiKey: 'secret', fetchImpl: mockFetch({ items: [
    item(['t1'], { issueKey: 'import_bill', title: '完善校验', action: '校验账单金额' }),
    item(['t1'], { issueKey: 'security_config', title: '完善校验', action: '校验页面来源' }),
  ] }) });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map(value => value.issueKey), ['import_bill', 'security_config']);
  assert.ok(result.items.every(value => value.relatedIssueKeys.length === 0));
});

test('local fallback does not guess semantic relations between independent named outcomes', async () => {
  const turns = [
    turn('t1', '2026-10-09', { assistantText: '事项：接入模型\n原因：需要自动整理\n处理：增加模型配置\n结果：自测通过' }),
    turn('t2', '2026-10-09', { assistantText: '事项：文件夹选择\n原因：来源校验失败\n处理：修正来源校验\n结果：目录选择通过' }),
  ];
  const result = await summarizeDay({ date: '2026-10-09', turns, config: { ...config, enabled: false } });
  assert.equal(result.method, 'local');
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(value => value.relatedIssueKeys.length === 0));
});

test('strict model validation rejects invented turns, attachments, oversized content and bad statuses', async () => {
  const invalid = [
    { items: [item(['invented'])] },
    { items: [item(['t1'], { attachments: [{ path: 'C:\\invented.txt' }] })] },
    { items: [item(['t1'], { title: '长'.repeat(81) })] },
    { items: [item(['t1'], { status: '客户已验收' })] },
    { items: [item(['t1'], { cause: '' })] },
    { items: [item(['t1'], { issueKey: '../outside' })] },
    { items: [item(['t1'])], explanation: 'extra' },
  ];
  for (const data of invalid) await assert.rejects(summarizeDay({ date: '2026-10-09', turns: [turn('t1')], config, apiKey: 'secret', fetchImpl: mockFetch(data) }), /模型/);
});

test('provider errors never reflect API keys or response bodies and do not pretend local success', async () => {
  for (const [fetchImpl, pattern] of [
    [async () => { throw new Error('Bearer VERY_PRIVATE_KEY network https://secret'); }, /无法连接/],
    [async () => new Response('VERY_PRIVATE_KEY server error', { status: 401 }), /密钥无效/],
    [async () => new Response('VERY_PRIVATE_KEY server error', { status: 429 }), /过于频繁/],
    [async () => new Response(JSON.stringify(completion({ items: [] })).replace('"stop"', '"length"'), { status: 200 }), /未完整生成/],
    [async () => new Response(JSON.stringify({ choices: [{ message: { content: 'invalid JSON' } }] }), { status: 200 }), /有效 JSON/],
    [mockFetch({ items: [item(['t1'], { cause: 'VERY_PRIVATE_KEY' })] }), /敏感信息/],
    [async () => new Response('x'.repeat(100001), { status: 200 }), /无法读取/],
  ]) {
    await assert.rejects(summarizeDay({ date: '2026-10-09', turns: [turn('t1')], config, apiKey: 'VERY_PRIVATE_KEY', fetchImpl }), error => { assert.match(error.message, pattern); assert.doesNotMatch(error.message, /VERY_PRIVATE_KEY|Bearer|https:/); return true; });
  }
});

test('large days are compacted in bounded chunks and preserve earlier source turns', async () => {
  const turns = Array.from({ length: 5 }, (_, index) => turn(`t${index}`, '2026-10-09', { timestamp: `2026-10-09T0${index + 1}:00:00Z`, userText: '问'.repeat(4000), assistantText: '处理结果'.repeat(2400) }));
  const requests = [];
  const result = await summarizeDay({ date: '2026-10-09', turns, config, apiKey: 'secret', fetchImpl: async (url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    requests.push(input);
    return mockFetch({ items: [item(input.allowedTurnIds)] })();
  } });
  assert.ok(requests.length > 1);
  assert.ok(requests[1].dailySoFar.length > 0);
  assert.deepEqual(result.items[0].turnIds, turns.map(value => value.id));
  assert.equal(result.items.length, 1);
  let count = 0;
  const compact = await summarizeDay({ date: '2026-10-09', turns, config, apiKey: 'secret', fetchImpl: async (url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    count++;
    return mockFetch({ items: [item(count === 1 ? input.allowedTurnIds : input.turns.map(value => value.id))] })();
  } });
  assert.equal(count, requests.length);
  assert.deepEqual(compact.items[0].turnIds, turns.map(value => value.id));
});

test('rolling compaction preserves absorbed issue identities and keeps unrelated identity additions separate', async () => {
  const turns = [turn('t1', '2026-10-09', { userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) }),
    turn('t2', '2026-10-09', { timestamp: '2026-10-09T02:00:00Z', userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) })];
  const previousItems = [item(['t1'], { date: '2026-10-09', issueKey: 'model_api', title: '模型 API' }), item(['t1'], { date: '2026-10-09', issueKey: 'model_select', title: '模型选择' })];
  const seen = [];
  const result = await summarizeDay({ date: '2026-10-09', turns, previousItems, config, apiKey: 'secret', fetchImpl: async (_url, options) => {
    const data = JSON.parse(JSON.parse(options.body).messages[1].content);
    seen.push(data);
    return mockFetch({ items: [item(data.allowedTurnIds, { issueKey: seen.length === 1 ? 'model_api' : 'model_select', title: '完善模型配置', relatedIssueKeys: seen.length === 1 ? ['model_select'] : [] })] })();
  } });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].dailySoFar[0].relatedIssueKeys, ['model_select']);
  assert.equal(result.items[0].issueKey, 'model_api');
  assert.deepEqual(result.items[0].relatedIssueKeys, ['model_select']);
  assert.deepEqual(result.items[0].turnIds, ['t1', 't2']);
  let calls = 0;
  const independent = await summarizeDay({ date: '2026-10-09', turns, config, apiKey: 'secret', fetchImpl: async (_url, options) => {
    const data = JSON.parse(JSON.parse(options.body).messages[1].content);
    calls++;
    return mockFetch({ items: [item(data.allowedTurnIds, { issueKey: calls === 1 ? 'stable_api' : 'unrelated_new', title: calls === 1 ? '模型配置' : '另一个事项' })] })();
  } });
  assert.equal(calls, 2);
  assert.equal(independent.items.length, 2);
  assert.deepEqual(independent.items.find(value => value.issueKey === 'stable_api').turnIds, ['t1']);
  assert.deepEqual(independent.items.find(value => value.issueKey === 'unrelated_new').turnIds, ['t1', 't2']);
});

test('omitted groups survive multiple chunks; explicit related updates restore every source and preserve the latest outcome', async () => {
  const turns = ['t1', 't2', 't3', 't4'].map((id, index) => turn(id, '2026-10-09', { timestamp: `2026-10-09T0${index + 1}:00:00Z`, userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500),
    attachments: [{ type: 'file', path: `D:\\资料\\${id}.txt`, description: `${id}来源` }] }));
  const requests = [];
  const result = await summarizeDay({ date: '2026-10-09', turns, config, apiKey: 'secret', fetchImpl: async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    assert.match(messages[0].content, /程序会保留未提及的旧成果/);
    const input = JSON.parse(messages[1].content); requests.push(input);
    const next = [
      [item(['t1'], { issueKey: 'model_api', title: '接入模型', result: '接口已接入' })],
      [item(['t2'], { issueKey: 'model_list', title: '模型列表', result: '列表可选择' }), item(['t2'], { issueKey: 'folder', title: '修复目录选择', result: '目录选择通过', status: '已完成' })],
      [item(['t3'], { issueKey: 'new_model_group', title: '完善模型接入与配置', relatedIssueKeys: ['model_api', 'model_list'], action: '完善模型接入、列表选择与配置回填', result: '回归通过，待客户测试' })],
      [],
    ][requests.length - 1];
    return mockFetch({ items: next })();
  } });
  assert.equal(requests.length, 4);
  assert.equal(result.items.length, 2);
  const model = result.items.find(value => value.issueKey === 'model_api');
  assert.deepEqual(model.relatedIssueKeys, ['model_list']);
  assert.deepEqual(model.turnIds, ['t1', 't2', 't3']);
  assert.deepEqual(model.attachments.map(value => value.path), ['D:\\资料\\t1.txt', 'D:\\资料\\t2.txt', 'D:\\资料\\t3.txt']);
  assert.equal(model.sourceRef, 'local#t1\nlocal#t2\nlocal#t3');
  assert.equal(model.result, '回归通过，待客户测试');
  assert.deepEqual(result.items.find(value => value.issueKey === 'folder').turnIds, ['t2']);
  assert.equal(requests[3].dailySoFar.length, 2);
  assert.ok(requests.every(value => value.correction === undefined));
});

test('rolling groups are not absorbed solely because their titles or source turns match', async () => {
  const turns = ['t1', 't2'].map((id, index) => turn(id, '2026-10-09', { timestamp: `2026-10-09T0${index + 1}:00:00Z`, userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) }));
  let calls = 0;
  const result = await summarizeDay({ date: '2026-10-09', turns, config, apiKey: 'secret', fetchImpl: async () => {
    calls++;
    return mockFetch({ items: [item(calls === 1 ? ['t1'] : ['t1', 't2'], { issueKey: calls === 1 ? 'bill_validation' : 'page_security', title: '完善校验', action: calls === 1 ? '校验账单金额' : '校验页面来源' })] })();
  } });
  assert.equal(calls, 2);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map(value => value.issueKey), ['bill_validation', 'page_security']);
});

test('accumulated rolling and existing daily groups over 24 fail explicitly without silent truncation', async () => {
  const turns = ['t1', 't2'].map((id, index) => turn(id, '2026-10-09', { timestamp: `2026-10-09T0${index + 1}:00:00Z`, userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) }));
  let calls = 0;
  await assert.rejects(summarizeDay({ date: '2026-10-09', turns, config, apiKey: 'secret', fetchImpl: async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content); calls++;
    return mockFetch({ items: input.turns[0].id === 't1' ? Array.from({ length: 24 }, (_, index) => item(['t1'], { issueKey: `independent_${index}`, title: `独立事项${index}` }))
      : [item(['t2'], { issueKey: 'new_independent', title: '另一个独立事项' })] })();
  } }), /超过 24 项/);
  assert.equal(calls, 3, '超限只允许一次既有的格式纠正，不无限重试');
  const existingItems = Array.from({ length: 24 }, (_, index) => ({ ...item([`old-${index}`], { issueKey: `saved_${index}`, title: `已有事项${index}` }), attachments: [], sourceRef: `local#old-${index}` }));
  const snapshot = JSON.stringify(existingItems);
  await assert.rejects(summarizeDay({ date: '2026-10-09', turns: [turn('new')], existingItems, config, apiKey: 'secret', fetchImpl: mockFetch({ items: [item(['new'], { issueKey: 'new_independent', title: '另一独立事项' })] }) }), /超过 24 项/);
  assert.equal(JSON.stringify(existingItems), snapshot, '超限不更改调用方已保存的摘要');
});

test('preserving omitted groups never relaxes invented sources or aliases in a later chunk', async () => {
  const turns = ['t1', 't2'].map((id, index) => turn(id, '2026-10-09', { timestamp: `2026-10-09T0${index + 1}:00:00Z`, userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) }));
  for (const invalid of [item(['invented']), item(['t2'], { relatedIssueKeys: ['invented_alias'] })]) {
    let calls = 0;
    await assert.rejects(summarizeDay({ date: '2026-10-09', turns, config, apiKey: 'secret', fetchImpl: async () => {
      calls++; return mockFetch({ items: [calls === 1 ? item(['t1']) : invalid] })();
    } }), /不存在/);
    assert.equal(calls, 3);
  }
});

test('connection test uses real local HTTP API contract without a live paid provider', async t => {
  let seen;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(completion({ ok: true })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await testConnection({ config: { ...config, provider: 'compatible', baseUrl: `http://127.0.0.1:${port}/v1` }, apiKey: 'local-fixture-key' });
  assert.deepEqual(result, { ok: true, model: 'deepseek-flash' });
  assert.equal(seen.path, '/v1/chat/completions');
  assert.equal(seen.authorization, 'Bearer local-fixture-key');
  assert.doesNotMatch(JSON.stringify(seen.body), /客户|导入|local-fixture-key/);
});

test('Codex parser marks final/task-complete turns only, including task completion without repeated final text', async t => {
  const root = path.join(__dirname, '..', '.tmp');
  await fs.mkdir(root, { recursive: true });
  const home = await fs.mkdtemp(path.join(root, 'fde-completion-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sessions = path.join(home, 'sessions');
  await fs.mkdir(sessions);
  const timestamp = '2026-10-08T16:05:00Z';
  const rows = [{ type: 'session_meta', payload: { id: 'completion-thread', cwd: 'D:\\开发\\项目' } }];
  const event = (type, extra = {}) => ({ type: 'event_msg', timestamp, payload: { type, ...extra } });
  rows.push(event('task_started', { turn_id: 'complete' }), event('user_message', { message: '处理错误' }), event('agent_message', { message: '已经处理' }), event('task_complete', { turn_id: 'complete' }));
  rows.push(event('task_started', { turn_id: 'final' }), event('user_message', { message: '处理下一项' }), event('agent_message', { channel: 'final', message: '已完成下一项' }));
  rows.push(event('task_started', { turn_id: 'interrupted' }), event('user_message', { message: '继续处理' }), event('agent_message', { message: '检查了一部分' }));
  rows.push(event('task_started', { turn_id: 'pending' }), event('user_message', { message: '还在处理' }));
  await fs.writeFile(path.join(sessions, 'rollout-completion-thread.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const result = await readThread({ home, threadId: 'completion-thread', cwd: 'D:\\开发\\项目' });
  assert.deepEqual(result.turns.map(value => [value.id, value.completed]), [['complete', true], ['final', true], ['interrupted', false], ['pending', false]]);
  assert.deepEqual([...groupCompletedTurns(result.turns).values()][0].map(value => value.id), ['complete', 'final']);
  assert.equal(result.turns[0].date, '2026-10-09');
});
