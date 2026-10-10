'use strict';

// Native event scheduling + incremental model requests, using only isolated
// sessions/data and a loopback mock. No real model settings or keys are loaded.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');
const DATE = '2026-10-09';
const INTERNAL = 'NEVER_SEND_EVENTS_INTERNAL_PROCESS';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const time = number => `${DATE}T02:${String(number).padStart(2, '0')}:00Z`;
const beginTurn = (id, number, text) => [
  { type: 'event_msg', timestamp: time(number), payload: { type: 'task_started', turn_id: id } },
  { type: 'response_item', timestamp: time(number), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
];
const finishTurn = (id, number) => [
  { type: 'response_item', timestamp: time(number), payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: `${id} 已完成本轮处理，等待客户测试。` }] } },
  { type: 'event_msg', timestamp: time(number), payload: { type: 'task_complete', turn_id: id } },
];
const turn = (id, number, text = `${id} 请继续修复同一个导入功能`) => [...beginTurn(id, number, text), ...finishTurn(id, number)];
const irrelevant = number => [
  { type: 'response_item', timestamp: time(number), payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: INTERNAL }] } },
  { type: 'response_item', timestamp: time(number), payload: { type: 'function_call_output', output: INTERNAL } },
];

async function snapshotRealData() {
  const file = path.join(ROOT, 'release', 'FDE Desk-win32-x64', 'data', 'store.json');
  try {
    const bytes = await fs.readFile(file), state = JSON.parse(bytes);
    const business = state.projects.map(project => ({ id: project.id, name: project.name, sourceDir: project.sourceDir, devDir: project.devDir,
      artifactDir: project.artifactDir, stage: project.stage, activeCycleId: project.activeCycleId, cycles: project.cycles,
      requirements: project.requirements, deliveries: project.deliveries, reports: project.reports,
      records: project.records.filter(record => record.manual || record.confirmed) }));
    return { hash: hash(bytes), businessHash: hash(JSON.stringify(business)) };
  } catch (error) { if (error.code === 'ENOENT') return { hash: null, businessHash: null }; throw error; }
}

async function run() {
  const out = path.join(ROOT, 'test-output'); await fs.mkdir(out, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(out, '事件驱动 增量验收 '));
  const dataDir = path.join(fixture, 'data'), home = path.join(fixture, '独立 Codex'), sessions = path.join(home, 'sessions', '2026', '10', '09');
  await fs.mkdir(sessions, { recursive: true });
  const realBefore = await snapshotRealData();
  const checks = [], calls = [], pageErrors = [];
  let failNextA = false, app, page;
  const check = (condition, message) => { assert.ok(condition, message); checks.push(message); };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      assert.equal(req.url, '/v1/chat/completions');
      const body = JSON.parse(raw), input = JSON.parse(body.messages.at(-1).content);
      assert.ok(Array.isArray(input.turns) && input.turns.length);
      const project = input.turns[0].id.startsWith('a-') ? 'a' : 'b';
      assert.ok(input.turns.every(item => item.id.startsWith(project + '-')));
      const failed = project === 'a' && failNextA;
      if (failed) failNextA = false;
      calls.push({ project, input, internalExcluded: !raw.includes(INTERNAL), failed });
      if (failed) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'ISOLATED_MOCK_UNAVAILABLE' } })); return; }
      const output = { items: [{ issueKey: `${project}_import`, title: `${project.toUpperCase()} 项目导入修复`, cause: '样例格式需要调整',
        action: `已处理 ${input.turns.map(item => item.id).join('、')}`, result: '样例自测通过，等待客户测试', status: '待验证', turnIds: input.allowedTurnIds }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
    } catch (error) {
      pageErrors.push(`mock: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"MOCK_ASSERTION_FAILED"}}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const seed = new Store(dataDir), projects = [], rollout = {};
  for (const label of ['a', 'b']) {
    const sourceDir = path.join(fixture, `${label}-source`), devDir = path.join(fixture, `${label}-dev`);
    await Promise.all([sourceDir, devDir].map(directory => fs.mkdir(directory, { recursive: true })));
    const project = seed.createProject({ name: `事件验收 ${label.toUpperCase()}`, sourceDir, devDir });
    const threadId = `events-${label}-isolated`;
    seed.updateProject(project.id, { codex: { threadId } });
    projects.push(project);
    rollout[label] = path.join(sessions, `rollout-events-${label}.jsonl`);
    await fs.writeFile(rollout[label], encode([
      { type: 'session_meta', timestamp: time(0), payload: { id: threadId, cwd: devDir } },
      ...turn(`${label}-0`, 0, `${label.toUpperCase()}-BOOTSTRAP-ORIGINAL 首次导入修复`),
    ]));
  }
  seed.saveSummarizerSettings({ enabled: true, provider: 'compatible', baseUrl, model: 'mock-native-events' });
  seed.setSettings({ activeProjectId: projects[0].id });
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: dataDir, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
  const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.fde.request(action, payload), { action, payload });
  const state = () => request('state');
  const projectState = async label => (await state()).projects.find(project => project.id === projects[label === 'a' ? 0 : 1].id);
  async function eventually(predicate, message, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await predicate()) return; await pause(50); }
    throw new Error(message);
  }
  async function launch() {
    app = await electron.launch({ executablePath: EXECUTABLE, args: process.env.FDE_SMOKE_EXECUTABLE ? [] : [ROOT], env, timeout: 40000 });
    await app.firstWindow();
    await eventually(async () => { page = app.windows().find(window => window.url().endsWith('/index.html')); return !!page; }, '隔离工作台未加载');
    await page.waitForFunction(() => !!window.fde);
    page.on('pageerror', error => pageErrors.push(error.message));
    check((await state()).dataDir === dataDir, 'Electron 确实使用独立管理数据目录');
  }
  async function waitForSources(label, ids) {
    await eventually(async () => {
      const project = await projectState(label);
      return project.codex.summaryStatus?.state === 'ready' && project.records.length === 1 && ids.every(id => project.records[0].turnIds.includes(id));
    }, `${label} 项目未自动整理预期的完成轮次`);
  }
  const assertQuiet = async (count, message, duration = 750) => { await pause(duration); check(calls.length === count, message); };
  try {
    await launch();
    await waitForSources('a', ['a-0']); await waitForSources('b', ['b-0']);
    check(calls.length === 2 && calls.filter(call => call.project === 'a').length === 1 && calls.filter(call => call.project === 'b').length === 1, '启动时每个已关联项目仅首次补齐一次，包括非当前项目');
    check((await state()).settings.activeProjectId === projects[0].id, '两个项目已关联，界面只有 A 是当前项目');
    await assertQuiet(2, '空闲时没有额外模型调用');
    await fs.appendFile(rollout.a, encode(irrelevant(1)));
    await assertQuiet(2, '追加分析和工具输出不触发模型请求');
    await fs.appendFile(rollout.a, encode(beginTurn('a-1', 2, 'A-DELTA-ONE 继续处理同一导入问题')));
    await assertQuiet(2, '未完成的一轮对话不触发模型请求');
    await fs.appendFile(rollout.a, encode(finishTurn('a-1', 2)));
    await waitForSources('a', ['a-0', 'a-1']);
    const firstDelta = calls.at(-1);
    check(calls.length === 3 && firstDelta.project === 'a' && firstDelta.input.turns.length === 1 && firstDelta.input.turns[0].id === 'a-1', '完成一轮后原生文件事件只触发一次新增轮次请求');
    check(firstDelta.input.existingIssues.some(item => item.issueKey === 'a_import') && !JSON.stringify(firstDelta.input.turns).includes('A-BOOTSTRAP-ORIGINAL'), '增量请求只发新增原文，已有成果通过 existingIssues 简短提供');
    check((await projectState('a')).records.length === 1, '同一任务更新原记录并合回旧真实来源');
    await fs.appendFile(rollout.a, encode(turn('a-2', 3)));
    await pause(10);
    await fs.appendFile(rollout.a, encode(turn('a-3', 4)));
    await waitForSources('a', ['a-0', 'a-1', 'a-2', 'a-3']);
    check(calls.length === 4 && new Set(calls.at(-1).input.turns.map(item => item.id)).size === 2 && calls.at(-1).input.turns.every(item => ['a-2', 'a-3'].includes(item.id)), '短间隔连续完成两轮会去抖为一次请求，仅包含两轮新增内容');
    await fs.appendFile(rollout.b, encode(turn('b-1', 5)));
    await waitForSources('b', ['b-0', 'b-1']);
    check(calls.length === 5 && (await state()).settings.activeProjectId === projects[0].id, '非当前 B 项目也由自己的会话文件事件自动更新');
    await app.close(); app = null; await launch();
    await assertQuiet(5, '重启后成功摘要与增量检查点不会重复调用模型', 1000);

    failNextA = true;
    await fs.appendFile(rollout.a, encode(turn('a-4', 6)));
    await eventually(async () => calls.length === 6 && (await projectState('a')).codex.summaryStatus?.state === 'error', '模拟服务失败未记录状态');
    check(calls.at(-1).failed && !(await projectState('a')).records[0].turnIds.includes('a-4'), '模型失败保留此前成果，失败轮次未假装整理完成');
    await assertQuiet(6, '失败后空闲不会定时重试');
    await fs.appendFile(rollout.a, encode(irrelevant(7)));
    await assertQuiet(6, '失败后只有分析或工具输出仍不会重试');
    await app.close(); app = null; await launch();
    await assertQuiet(6, '失败状态持久化，重启不会自动再请求', 1000);
    await fs.appendFile(rollout.a, encode(beginTurn('a-5', 8, 'A-NEW-COMPLETED-EVENT 继续修复')));
    await assertQuiet(6, '失败后出现未完成轮次也不会释放重试');
    await fs.appendFile(rollout.a, encode(finishTurn('a-5', 8)));
    await waitForSources('a', ['a-0', 'a-1', 'a-2', 'a-3', 'a-4', 'a-5']);
    const recovered = await projectState('a');
    check(calls.length === 7 && new Set(calls.at(-1).input.turns.map(item => item.id)).size === 2 && calls.at(-1).input.turns.every(item => ['a-4', 'a-5'].includes(item.id)), '新的完成轮次出现后仅重试未成功内容与新内容，并恢复同一工作项');
    check(recovered.codex.history.failedDates.length === 0 && recovered.records.length === 1, '恢复成功清除失败日期，相关任务仍只有一条记录');
    check(calls.every(call => call.internalExcluded), '所有模型请求均排除内部分析和工具输出');
    check(pageErrors.length === 0, '事件调度验收没有渲染器或 mock 未处理异常');
    const realAfter = await snapshotRealData();
    check(realBefore.businessHash === realAfter.businessHash, '验收期间正式数据的人工记录、日报及业务管理内容保持一致');
    const report = { status: 'passed', mode: process.env.FDE_SMOKE_EXECUTABLE ? 'portable' : 'source', checks,
      requests: calls.map(call => ({ project: call.project, date: call.input.date, turns: call.input.turns.map(item => item.id), existingIssues: call.input.existingIssues.map(item => item.issueKey), failed: call.failed, internalExcluded: call.internalExcluded })),
      modelCalls: calls.length, fixture, boundary: '独立 Electron 数据与 Codex home，仅使用 loopback 模拟模型，无真实密钥；短观察验证无隐式重试，未用时间加速伪造定时器行为',
      realBusinessUnchanged: realBefore.businessHash === realAfter.businessHash, realStoreHashBefore: realBefore.hash, realStoreHashAfter: realAfter.hash,
      concurrentFormalStoreUpdate: realBefore.hash !== realAfter.hash };
    const reportPath = path.join(out, process.env.FDE_SMOKE_EXECUTABLE ? '事件驱动增量验收-便携版.json' : '事件驱动增量验收-源码.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, checks: checks.length, modelCalls: calls.length, report: reportPath, realBusinessUnchanged: report.realBusinessUnchanged }));
  } finally {
    if (app) await app.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
