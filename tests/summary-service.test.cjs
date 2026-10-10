'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { SummaryService } = require('../src/core/summary-service.cjs');
const { ModelSettings } = require('../desktop/model-settings.cjs');
const real = require('../src/core/summarizer.cjs');

function fixture(t) {
  const base = path.resolve(__dirname, '../.test-tmp'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'summary-'));
  fs.mkdirSync(path.join(dir, 'source')); fs.mkdirSync(path.join(dir, 'dev'));
  const dataDir = path.join(dir, 'data');
  const store = new Store(dataDir);
  const p = store.createProject({ name: '自动整理验收', sourceDir: path.join(dir, 'source'), devDir: path.join(dir, 'dev') });
  store.updateProject(p.id, { codex: { threadId: 'thread' } });
  t.after(() => { assert.ok(dir.startsWith(base + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, p, dataDir };
}
const turn = (id, date) => ({ id, threadId: 'thread', date, completed: true, userText: '导入失败，请修复', assistantText: '已调整格式识别，样例通过', attachments: [], sourceRef: `session#${id}` });
const item = id => ({ issueKey: 'import', title: '修复表格导入', cause: '格式不兼容', action: '调整格式识别', result: '样例通过，待客户测试', status: '待验证', turnIds: [id], attachments: [], sourceRef: `session#${id}` });
function service({ store, turns, summarizeDay, getModel, getRules }) {
  return new SummaryService({ store, reader: { readThread: async () => ({ turns }) }, summarizer: { ...real, summarizeDay }, getRules, getModel: getModel || (() => ({ config: { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, apiKey: 'mock-secret' })), delay: 1 });
}
async function run(s, id, force = false, retryFailed = false) {
  s.schedule(id, { force, retryFailed, delay: 10000 }); clearTimeout(s.jobs.get(id).timer);
  await s.run(id);
}
test('后台按日生成工作与日报；未变化不重调，跨天单独保存，重启幂等', async t => {
  const { store, p, dataDir } = fixture(t);
  let calls = 0;
  const turns = [turn('one', '2026-10-08'), turn('two', '2026-10-09')];
  const adapter = async ({ turns }) => { calls++; return { method: 'model', items: [item(turns.at(-1).id)] }; };
  const s = service({ store, turns, summarizeDay: adapter }); t.after(() => s.stop());
  await run(s, p.id); assert.equal(calls, 2);
  const project = store.getState().projects[0];
  assert.equal(project.records.length, 2); assert.equal(project.codex.dailySummaries.length, 2);
  assert.match(store.generateReport(p.id, '2026-10-08').text, /修复表格导入/);
  await run(s, p.id); assert.equal(calls, 2);
  turns.push({ ...turn('unfinished', '2026-10-09'), completed: false });
  await run(s, p.id); assert.equal(calls, 2, '未结束一轮不触发整理');
  const restart = service({ store: new Store(dataDir), turns, summarizeDay: adapter }); t.after(() => restart.stop());
  await run(restart, p.id); assert.equal(calls, 2, '重启不会重复调用模型');
});
test('整理中解绑或模型设置改变，不回写过期结果', async t => {
  const { store, p } = fixture(t);
  let done, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const s = service({ store, turns: [turn('one', '2026-10-09')], summarizeDay: () => { started(); return new Promise(resolve => { done = resolve; }); } }); t.after(() => s.stop());
  const running = run(s, p.id); await waiting;
  store.updateProject(p.id, { codex: { threadId: 'another' } });
  done({ method: 'model', items: [item('one')] }); await running;
  assert.equal(store.getState().projects[0].records.length, 0);
});
test('模型失败保留已有日报和摘要，错误仅更新状态', async t => {
  const { store, p } = fixture(t);
  const turns = [turn('one', '2026-10-09')];
  const s = service({ store, turns, summarizeDay: async () => ({ method: 'model', items: [item('one')] }) }); t.after(() => s.stop());
  await run(s, p.id); store.saveReport(p.id, '2026-10-09', '人工修改的日报');
  s.summarizer = { ...s.summarizer, summarizeDay: async () => { throw new Error('模型暂时不可用'); } };
  turns.push(turn('two', '2026-10-09')); await run(s, p.id);
  const project = store.getState().projects[0];
  assert.equal(project.codex.dailySummaries[0].items.length, 1);
  assert.equal(project.reports[0].text, '人工修改的日报');
  assert.equal(project.codex.summaryStatus.state, 'error');
});
test('关闭模型或清除密钥，保留已整理的模型成果', async t => {
  const { store, p } = fixture(t);
  let enabled = true, calls = 0;
  const s = service({ store, turns: [turn('one', '2026-10-09')], getModel: () => ({ config: { enabled, model: 'deepseek-flash' }, apiKey: enabled ? 'mock' : '' }), summarizeDay: async () => { calls++; return { method: 'model', items: [item('one')] }; } });
  t.after(() => s.stop()); await run(s, p.id); enabled = false; await run(s, p.id, true);
  assert.equal(calls, 1); assert.equal(store.getState().projects[0].records.length, 1);
  assert.equal(store.getState().projects[0].codex.dailySummaries[0].method, 'model');
});
test('读取范围受限时保留未读到的旧成果，不用部分会话清空历史', async t => {
  const { store, p } = fixture(t);
  store.applyDailySummary(p.id, { date: '2026-10-09', threadId: 'thread', method: 'model', fingerprint: 'old', items: [{ ...item('old-turn'), issueKey: 'old-issue', title: '此前已完成的工作' }] });
  const s = service({ store, turns: [turn('new-turn', '2026-10-09')], summarizeDay: async () => ({ method: 'model', items: [item('new-turn')] }) }); t.after(() => s.stop());
  s.reader = { readThread: async () => ({ truncated: true, turns: [turn('new-turn', '2026-10-09')] }) };
  await run(s, p.id);
  const project = store.getState().projects[0];
  assert.equal(project.records.length, 2); assert.match(project.codex.summaryStatus.message, /部分历史未读取/);
});
test('模型密钥只交系统加密，公开状态和store不含密钥，端点改变不沿用密钥', t => {
  const { store, dataDir } = fixture(t);
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(n => n ^ 173), decryptString: b => Buffer.from(b).map(n => n ^ 173).toString() };
  const settings = new ModelSettings({ dataDir, store, safeStorage });
  const config = { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
  const result = settings.save({ config, apiKey: 'secret-test-key-123' });
  assert.equal(result.keyConfigured, true);
  assert.equal(settings.key(), 'secret-test-key-123');
  assert.doesNotMatch(JSON.stringify({ result, state: store.getState() }), /secret-test-key/);
  assert.ok(!fs.readFileSync(settings.path).includes(Buffer.from('secret-test-key')));
  settings.save({ config: { ...config, baseUrl: 'https://other.example/v1' } });
  assert.equal(settings.public().keyConfigured, false);
  settings.save({ config, clearKey: true }); assert.equal(settings.public().keyConfigured, false);
});
test('旧版加密密钥继续可用，切换协议前绑定原协议，切回时恢复', t => {
  const { store, dataDir } = fixture(t);
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(n => n ^ 173), decryptString: b => Buffer.from(b).map(n => n ^ 173).toString() };
  const settings = new ModelSettings({ dataDir, store, safeStorage });
  const config = { enabled: true, provider: 'compatible', baseUrl: 'https://example.test/v1', model: 'example-model' };
  store.saveSummarizerSettings(config);
  fs.writeFileSync(settings.path, safeStorage.encryptString(JSON.stringify({ baseUrl: config.baseUrl, apiKey: 'legacy-test-key' })));
  assert.equal(settings.key(), 'legacy-test-key');
  assert.equal(settings.key({ ...config, provider: 'anthropic' }), '');
  settings.save({ config: { ...config, provider: 'anthropic' } });
  assert.equal(settings.public().keyConfigured, false);
  settings.save({ config }); assert.equal(settings.key(), 'legacy-test-key');
  assert.doesNotMatch(JSON.stringify(store.getState()), /legacy-test-key/);
});
test('本机模型无需密钥也进入后台模型整理，远程不允许匿名调用', async t => {
  const { store, p, dataDir } = fixture(t);
  const safeStorage = { isEncryptionAvailable: () => true };
  const settings = new ModelSettings({ dataDir, store, safeStorage });
  settings.save({ config: { enabled: true, provider: 'compatible', baseUrl: 'http://localhost:11434/v1', model: 'local-model' } });
  assert.equal(settings.public().keyRequired, false); assert.equal(settings.public().keyConfigured, false);
  let called = false;
  const s = service({ store, turns: [turn('one', '2026-10-09')], getModel: () => ({ config: settings.config(), apiKey: '' }), summarizeDay: async ({ config }) => { called = config.enabled; return { method: 'model', items: [item('one')] }; } });
  t.after(() => s.stop()); await run(s, p.id);
  assert.equal(called, true); assert.equal(store.getState().projects[0].codex.dailySummaries[0].method, 'model');
});
test('规则变更不自动重算，用户手动重整才生效，人工内容保留', async t => {
  const { store, p } = fixture(t);
  let rules = '每项简述问题、处理、结果。', calls = 0;
  const seen = [];
  const s = service({ store, turns: [turn('one', '2026-10-09')], getRules: () => rules,
    summarizeDay: async input => { calls++; seen.push(input.rules); return { method: 'model', items: [{ ...item('one'), action: calls === 1 ? '调整格式识别' : '补充验证样例' }] }; } });
  t.after(() => s.stop()); await run(s, p.id);
  const first = store.getState().projects[0];
  store.upsertRecord(p.id, { ...first.records[0], action: '人工核对的处理', confirmed: true });
  store.saveReport(p.id, '2026-10-09', '人工保存的日报');
  rules = '每项只写一句关键处理和结果。';
  await run(s, p.id); await run(s, p.id);
  assert.equal(calls, 1, '规则变化没有新成果时不调用模型');
  await run(s, p.id, true);
  const after = store.getState().projects[0];
  assert.equal(calls, 2); assert.deepEqual(seen, ['每项简述问题、处理、结果。', rules]);
  assert.notEqual(after.codex.dailySummaries[0].fingerprint, first.codex.dailySummaries[0].fingerprint);
  assert.equal(after.codex.dailySummaries[0].items[0].action, '补充验证样例');
  assert.equal(after.records[0].action, '人工核对的处理'); assert.equal(after.records[0].confirmed, true);
  assert.equal(after.reports[0].text, '人工保存的日报');
});
test('外部编辑规则后丢弃在途旧结果，再按新快照整理', async t => {
  const { store, p } = fixture(t);
  let rules = '旧规则', started, finish, calls = 0;
  const waiting = new Promise(resolve => { started = resolve; });
  const s = service({ store, turns: [turn('one', '2026-10-09')], getRules: () => rules,
    summarizeDay: async input => { calls++; assert.equal(input.rules, calls === 1 ? '旧规则' : '新规则');
      if (calls === 1) { started(); return new Promise(resolve => { finish = resolve; }); }
      return { method: 'model', items: [item('one')] };
    } });
  t.after(() => s.stop()); const running = run(s, p.id); await waiting;
  rules = '新规则'; finish({ method: 'model', items: [item('one')] }); await running;
  assert.equal(store.getState().projects[0].records.length, 0, '过期规则结果不能落盘');
  await run(s, p.id); assert.equal(calls, 2); assert.equal(store.getState().projects[0].records.length, 1);
});
test('规则读取失败保留成果，恢复同一规则后清除旧错误且不重复请求', async t => {
  const { store, p } = fixture(t);
  let broken = false, calls = 0;
  const s = service({ store, turns: [turn('one', '2026-10-09')],
    getRules: () => { if (broken) throw new Error('整理规则文件无效'); return '固定规则'; },
    summarizeDay: async () => { calls++; return { method: 'model', items: [item('one')] }; } });
  s.reader = { readThread: async () => ({ turns: [turn('one', '2026-10-09')], coverage: { sourceStamp: 'stable-history' } }) };
  t.after(() => s.stop()); await run(s, p.id); broken = true; await run(s, p.id);
  assert.equal(store.getState().projects[0].codex.summaryStatus.state, 'error');
  assert.equal(store.getState().projects[0].records.length, 1);
  broken = false; await run(s, p.id);
  assert.equal(calls, 1); assert.equal(store.getState().projects[0].codex.summaryStatus.state, 'ready');
});
test('截断读取时吸收关联旧事项的真实来源和媒体，不复活拆分卡片', async t => {
  const { store, p } = fixture(t);
  store.applyDailySummary(p.id, { date: '2026-10-09', threadId: 'thread', method: 'model', fingerprint: 'split', items: [
    { ...item('old-one'), issueKey: 'model-access', title: '模型接入', attachments: [{ path: 'D:\\sample\\one.png', description: '旧来源一' }] },
    { ...item('old-two'), issueKey: 'model-selection', title: '模型选择', attachments: [{ path: 'D:\\sample\\two.png', description: '旧来源二' }] },
  ] });
  const s = service({ store, turns: [turn('new', '2026-10-09')], summarizeDay: async ({ previousItems }) => {
    assert.ok(previousItems.every(item => item.date === '2026-10-09'));
    return { method: 'model', items: [{ ...item('new'), issueKey: 'model-access', title: '完善模型功能', relatedIssueKeys: ['model-selection'] }] };
  } }); t.after(() => s.stop());
  s.reader = { readThread: async () => ({ truncated: true, turns: [turn('new', '2026-10-09')] }) };
  await run(s, p.id);
  const after = store.getState().projects[0];
  assert.equal(after.records.length, 1); assert.equal(after.codex.dailySummaries[0].items.length, 1);
  assert.deepEqual(new Set(after.records[0].turnIds), new Set(['old-one', 'old-two', 'new']));
  assert.equal(after.records[0].attachments.length, 2);
  assert.equal(after.records[0].action, item('new').action, '不把每轮旧处理重新堆入短记录');
});

test('历史某日整理失败不阻塞后续日期，重试只补失败日期', async t => {
  const { store, p } = fixture(t);
  const dates = ['2026-09-21', '2026-09-22', '2026-09-23'];
  const turns = dates.map((date, index) => turn(`history-${index}`, date));
  let broken = true; const calls = [];
  const s = service({ store, turns, summarizeDay: async input => {
    calls.push(input.date);
    if (broken && input.date === dates[1]) throw new Error('模型整理格式不符合要求，请重试或更换模型');
    return { method: 'model', items: [item(input.turns[0].id)] };
  } }); t.after(() => s.stop());
  s.reader = { readThread: async input => { assert.equal(input.history, true); return { turns, discoveredDates: dates, workTruncated: false }; } };
  await run(s, p.id);
  let project = store.getState().projects[0];
  assert.deepEqual(calls, dates);
  assert.deepEqual(project.codex.history.dates, dates);
  assert.deepEqual(project.codex.history.completedDates, [dates[0], dates[2]]);
  assert.equal(project.codex.history.failedDates[0].date, dates[1]);
  assert.equal(project.codex.summaryStatus.state, 'error');
  await run(s, p.id); assert.equal(calls.length, 3, '无新成果不反复请求失败日');
  broken = false;
  await run(s, p.id, false, true);
  project = store.getState().projects[0];
  assert.deepEqual(calls, [...dates, dates[1]], '成功日期不重调');
  assert.deepEqual(project.codex.history.completedDates, dates);
  assert.deepEqual(project.codex.history.failedDates, []);
  assert.equal(project.codex.summaryStatus.state, 'ready');
});

test('超出总轮次缓存的历史按日补读，全部恢复后不误报历史截断', async t => {
  const { store, p } = fixture(t);
  const dates = ['2026-09-21', '2026-09-29'], seen = [];
  const s = service({ store, turns: [], summarizeDay: async input => ({ method: 'model', items: [item(input.turns[0].id)] }) }); t.after(() => s.stop());
  s.reader = { readThread: async input => {
    seen.push(input.date || 'catalog');
    if (!input.date) return { turns: [turn('recent', dates[1])], discoveredDates: dates, truncated: true, workTruncated: true, coverage: { scanComplete: true, sourceStamp: 'thread:260000000:1' } };
    return { turns: [turn(input.date === dates[0] ? 'old' : 'recent', input.date)], workTruncated: false, coverage: { scanComplete: true } };
  } };
  await run(s, p.id);
  const project = store.getState().projects[0];
  assert.deepEqual(seen, ['catalog', ...dates]);
  assert.deepEqual(project.codex.history.completedDates, dates);
  assert.equal(project.codex.history.truncated, false);
  assert.doesNotMatch(project.codex.summaryStatus.message, /未读取/);
  assert.deepEqual(project.records.map(record => record.turnIds[0]), ['old', 'recent']);
  await run(s, p.id);
  assert.deepEqual(seen, ['catalog', ...dates, 'catalog'], '源文件未变时不逐日重新扫描大历史');
});

test('历史服务连接失败只请求一次并退避，不对每个日期重复失败请求', async t => {
  const { store, p } = fixture(t); let calls = 0;
  const turns = ['2026-09-21', '2026-09-22', '2026-09-23'].map((date, i) => turn(`network-${i}`, date));
  const s = service({ store, turns, summarizeDay: async () => { calls++; throw new Error('无法连接模型服务，请检查网络和接口地址'); } }); t.after(() => s.stop());
  await run(s, p.id); await run(s, p.id);
  assert.equal(calls, 1);
  const project = store.getState().projects[0];
  assert.equal(project.codex.history.dates.length, 3);
  assert.equal(project.codex.history.failedDates.length, 1);
  assert.equal(project.codex.summaryStatus.state, 'error');
});

test('历史目录与会话绑定隔离，重新关联不会展示旧会话进度', t => {
  const { store, p } = fixture(t);
  store.setCodexHistory(p.id, { threadId: 'thread', dates: ['2026-09-21'], completedDates: [], failedDates: [], truncated: false });
  assert.throws(() => store.setCodexHistory(p.id, { threadId: 'other', dates: [] }), /会话已变化/);
  assert.throws(() => store.setCodexHistory(p.id, { threadId: 'thread', dates: ['2026-02-30'] }), /日期无效/);
  store.updateProject(p.id, { codex: { threadId: 'other' } });
  assert.equal(store.getState().projects[0].codex.history, null);
});

test('厂商429的中文安全错误按服务退避，而非请求所有历史日期', async t => {
  const { store, p } = fixture(t); let calls = 0;
  const turns = ['2026-09-21', '2026-09-22', '2026-09-23'].map((date, i) => turn(`rate-${i}`, date));
  const s = service({ store, turns, summarizeDay: async () => { calls++; throw new Error('模型请求过于频繁，请稍后重试'); } }); t.after(() => s.stop());
  await run(s, p.id); await run(s, p.id);
  assert.equal(calls, 1);
  assert.equal(store.getState().projects[0].codex.summaryStatus.state, 'error');
});

test('新成果仅发送增量轮次和已有摘要，同ID修订可再次整理', async t => {
  const { store, p } = fixture(t), turns = [turn('one', '2026-10-09')], seen = [];
  const s = service({ store, turns, summarizeDay: async input => {
    seen.push(input);
    return { method: 'model', items: [{ ...item(input.turns.at(-1).id), turnIds: [...new Set([...input.existingItems.flatMap(item => item.turnIds), ...input.turns.map(turn => turn.id)])] }] };
  } }); t.after(() => s.stop());
  await run(s, p.id);
  turns.push(turn('two', '2026-10-09')); await run(s, p.id);
  assert.deepEqual(seen[1].turns.map(turn => turn.id), ['two']);
  assert.equal(seen[1].existingItems[0].title, '修复表格导入');
  assert.deepEqual(store.getState().projects[0].records[0].turnIds, ['one', 'two']);
  turns[1] = { ...turns[1], assistantText: '修订真实结果：仍失败' }; await run(s, p.id);
  assert.deepEqual(seen[2].turns.map(turn => turn.id), ['two']);
  assert.equal(Object.keys(store.getState().projects[0].codex.dailySummaries[0].processedTurns).length, 2);
});

test('失败锁定持久化：跨时间重启无新成果不重试，有完成轮才释放', async t => {
  const { store, p, dataDir } = fixture(t), turns = [turn('one', '2026-10-09')];
  let calls = 0, broken = true;
  const adapter = async input => { calls++; if (broken) throw new Error('无法连接模型服务，请检查网络和接口地址'); return { method: 'model', items: [item(input.turns.at(-1).id)] }; };
  const s = service({ store, turns, summarizeDay: adapter }); t.after(() => s.stop());
  await run(s, p.id); await run(s, p.id); assert.equal(calls, 1);
  assert.match(store.getState().projects[0].codex.history.blockedSourceFingerprint, /^[a-f0-9]{64}$/);
  const restarted = service({ store: new Store(dataDir), turns, summarizeDay: adapter }); t.after(() => restarted.stop());
  broken = false; await run(restarted, p.id); assert.equal(calls, 1, '恢复网络或重启都不是新成果');
  turns.push({ ...turn('two', '2026-10-09'), completed: false }); await run(restarted, p.id); assert.equal(calls, 1);
  turns.at(-1).completed = true; await run(restarted, p.id); assert.equal(calls, 2);
  assert.deepEqual(restarted.store.getState().projects[0].codex.history.failedDates, []);
});

test('已成功旧版本摘要只迁移内容指纹，不重新发送历史或改正文', async t => {
  const { store, p } = fixture(t), turns = [turn('one', '2026-10-09')];
  const config = { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
  store.applyDailySummary(p.id, { date: turns[0].date, threadId: 'thread', method: 'model', fingerprint: real.dayFingerprint(turns, config), items: [item('one')] });
  const before = store.getState().projects[0].codex.dailySummaries[0]; let calls = 0;
  const s = service({ store, turns, summarizeDay: async () => { calls++; throw new Error('不应调用'); } }); t.after(() => s.stop());
  await run(s, p.id);
  const after = store.getState().projects[0].codex.dailySummaries[0];
  assert.equal(calls, 0); assert.deepEqual(after.items, before.items); assert.equal(after.updatedAt, before.updatedAt);
  assert.deepEqual(after.processedTurns, real.turnCheckpoints(turns));
});

test('文件元数据变化、模型切换、规则变化都不能重算已有完整成果', async t => {
  const { store, p } = fixture(t), turns = [turn('one', '2026-10-09')];
  let calls = 0, stamp = 'initial', model = 'one', rules = 'old';
  const s = service({ store, turns, getRules: () => rules, getModel: () => ({ config: { enabled: true, model }, apiKey: 'mock' }), summarizeDay: async () => { calls++; return { method: 'model', items: [item('one')] }; } });
  s.reader = { readThread: async () => ({ turns, coverage: { sourceStamp: stamp } }) }; t.after(() => s.stop());
  await run(s, p.id); stamp = 'tool-output-only'; await run(s, p.id);
  model = 'two'; rules = 'new'; await run(s, p.id, false, true);
  assert.equal(calls, 1);
  await run(s, p.id, true); assert.equal(calls, 2, '显式重整可重算旧成果');
});

test('规则保存撤销排队的旧重整，迟到请求后不会自动续算', async t => {
  const { store, p } = fixture(t);
  let finish, started, calls = 0;
  const waiting = new Promise(resolve => { started = resolve; });
  const s = service({ store, turns: [turn('one', '2026-10-09')], summarizeDay: async () => {
    calls++; started(); return new Promise(resolve => { finish = resolve; });
  } }); t.after(() => s.stop());
  const running = run(s, p.id); await waiting;
  s.schedule(p.id, { force: true, delay: 0 }); s.invalidate();
  finish({ method: 'model', items: [item('one')] }); await running;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1); assert.equal(store.getState().projects[0].records.length, 0);
});

test('状态写入期间规则发生变化，模型请求开始前再次拒绝旧任务', async t => {
  const { store, p } = fixture(t); let calls = 0;
  const s = service({ store, turns: [turn('one', '2026-10-09')], summarizeDay: async () => { calls++; return { method: 'model', items: [item('one')] }; } });
  t.after(() => s.stop());
  const status = s.status.bind(s);
  s.status = async (...args) => { await status(...args); if (args[1] === 'running') s.invalidate(); };
  await run(s, p.id); assert.equal(calls, 0); assert.equal(store.getState().projects[0].records.length, 0);
});
