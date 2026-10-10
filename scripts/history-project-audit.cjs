'use strict';

// Real historical rollout, read-only. Management writes go to one isolated copy;
// summarization is an in-process mock and never reads credentials or uses APIs.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const { SummaryService } = require('../src/core/summary-service.cjs');
const reader = require('../src/core/codex.cjs');
const realSummarizer = require('../src/core/summarizer.cjs');

const ROOT = path.resolve(__dirname, '..');
const REAL_STORE = path.join(require('../desktop/data-location.cjs').resolveDataDirectory(), 'store.json');
const DEV_DIR = process.env.FDE_AUDIT_DEV_DIR;
const THREAD_ID = process.env.FDE_AUDIT_THREAD_ID;
if (!DEV_DIR || !THREAD_ID) throw new Error('请设置 FDE_AUDIT_DEV_DIR 和 FDE_AUDIT_THREAD_ID 后进行只读历史审计');
const BASE_DATES = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-28', '2026-09-29'];
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const cwdKey = value => path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();

function realSnapshot() {
  const bytes = fs.readFileSync(REAL_STORE);
  const state = JSON.parse(bytes);
  const project = state.projects.find(item => cwdKey(item.devDir) === cwdKey(DEV_DIR) && item.codex?.threadId === THREAD_ID);
  assert.ok(project, '正式档案中未找到目标目录和已关联会话');
  return { project, hash: hash(bytes) };
}
function manualRecords(project) { return project.records.filter(item => item.manual || item.confirmed); }
function protectedData(project) {
  return {
    id: project.id, name: project.name, customer: project.customer,
    sourceDir: project.sourceDir, devDir: project.devDir, artifactDir: project.artifactDir,
    stage: project.stage, nextAction: project.nextAction, blocker: project.blocker,
    activeCycleId: project.activeCycleId, cycles: project.cycles, requirements: project.requirements,
    deliveries: project.deliveries, manualRecords: manualRecords(project), reports: project.reports,
    userDescriptions: project.files.filter(file => file.descriptionSource === 'user').map(file => ({ id: file.id, path: file.path, description: file.description })),
  };
}
async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function runService(service, id) {
  service.schedule(id, { delay: 10000 });
  clearTimeout(service.jobs.get(id).timer);
  await service.run(id);
}

async function main() {
  const begin = realSnapshot();
  const args = { threadId: THREAD_ID, cwd: DEV_DIR };
  const threads = await reader.listThreads({ cwd: DEV_DIR });
  const thread = threads.find(item => item.id === THREAD_ID);
  assert.ok(thread, '只读会话发现应包含已关联的目标历史会话');
  const rolloutBefore = await hashFile(thread.path);
  const recent = await reader.readThread(args);
  const history = await reader.readThread({ ...args, history: true });
  const completed = history.turns.filter(turn => turn.completed);
  const grouped = realSummarizer.groupCompletedTurns(history.turns);
  const DATES = [...grouped.keys()].sort();
  assert.ok(recent.turns.length >= 37 && recent.turns.length < history.turns.length, '尾部读取仍遗漏旧工作；允许会话继续增长');
  assert.equal(recent.truncated, true);
  assert.ok(history.turns.length >= 93);
  assert.ok(completed.length >= 91);
  assert.ok(BASE_DATES.every(date => DATES.includes(date)), '原六个历史日期必须完整恢复');
  assert.deepEqual(history.discoveredDates, DATES);
  assert.deepEqual([...grouped.keys()].sort(), DATES);
  assert.equal(history.truncated, false);
  assert.equal(history.workTruncated, false);
  assert.equal(history.coverage.scanComplete, true);
  const earliest = await reader.readThread({ ...args, date: DATES[0] });
  assert.equal(earliest.turns.length, 8);
  assert.ok(earliest.turns.every(turn => turn.date === DATES[0]));

  const temporaryBase = path.join(ROOT, '.test-tmp');
  await fsp.mkdir(temporaryBase, { recursive: true });
  const fixture = await fsp.mkdtemp(path.join(temporaryBase, 'real-history-audit-'));
  assert.ok(fixture.startsWith(temporaryBase + path.sep));
  const dataDir = path.join(fixture, 'data');
  await fsp.mkdir(dataDir);
  // Copy only this project's management state, with synthetic settings. No key
  // files, global settings, credentials, or other projects are copied.
  const projectCopy = clone(begin.project);
  for (const report of projectCopy.reports) report.path = path.join(dataDir, 'projects', projectCopy.id, '日报', `${report.date}.md`);
  const config = { enabled: true, provider: 'compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'history-audit-in-process-mock' };
  await fsp.writeFile(path.join(dataDir, 'store.json'), JSON.stringify({ version: 1, settings: { summarizer: config }, projects: [projectCopy] }, null, 2));
  const store = new Store(dataDir), id = projectCopy.id;
  const copiedProtection = hash(protectedData(store.getState().projects[0]));
  const calls = [];
  let networkAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('真实历史验收禁止网络调用'); };
  const makeService = currentStore => new SummaryService({
    store: currentStore, reader,
    summarizer: { ...realSummarizer, summarizeDay: async ({ date, turns }) => {
      assert.ok(turns.length && turns.every(turn => turn.completed && turn.date === date));
      calls.push(date);
      return { method: 'model', items: [{
        issueKey: 'history-audit-sample', title: '历史读取验收样例', cause: '历史上下文读取验收',
        action: '在隔离管理档案中回补当日有效来源', result: '仅为读取链路验收，不代表项目业务完成',
        status: '待验证', turnIds: turns.map(turn => turn.id), attachments: [], sourceRef: turns[0].sourceRef,
      }] };
    } },
    getRules: () => '隔离测试，每日仅生成一项样例，使用真实来源编号，禁止调用网络。',
    getModel: () => ({ config, apiKey: '' }), delay: 1,
  });
  let first, restarted;
  let finalProject, callsBeforeRestart, sourceEnd;
  try {
    first = makeService(store);
    await runService(first, id);
    const after = store.getState().projects[0];
    assert.deepEqual(calls, DATES, '六个历史日期都应整理落地');
    assert.deepEqual(after.codex.history.dates, DATES);
    assert.deepEqual(after.codex.history.completedDates, DATES);
    assert.deepEqual(after.codex.history.failedDates, []);
    assert.equal(after.codex.history.truncated, false);
    assert.equal(hash(protectedData(after)), copiedProtection, '原有人工记录、日报和业务管理字段应保留');
    for (const date of DATES) {
      assert.ok(fs.existsSync(path.join(dataDir, 'projects', id, '自动整理', `${date}.md`)));
      assert.ok(after.codex.dailySummaries.find(summary => summary.date === date)?.items.length);
    }
    // Add explicit human edits to this isolated copy and prove they survive both
    // the in-memory idle pass and the next fresh Store + SummaryService instance.
    const firstAuto = after.records.find(record => record.autoGenerated && record.date === DATES[0]);
    assert.ok(firstAuto);
    store.upsertRecord(id, { ...firstAuto, action: '隔离验收人工保留处理', confirmed: true });
    const savedDate = DATES.find(date => !after.reports.some(report => report.date === date)) || '2026-09-30';
    store.saveReport(id, savedDate, '# 隔离验收人工定稿\n\n此内容必须保留。');
    const humanProtection = hash(protectedData(store.getState().projects[0]));
    await runService(first, id);
    assert.equal(calls.length, DATES.length, '未变化会话不能重复调用整理器');
    first.stop();
    callsBeforeRestart = calls.length;
    const reopened = new Store(dataDir);
    restarted = makeService(reopened);
    await runService(restarted, id);
    finalProject = reopened.getState().projects[0];
    assert.equal(calls.length, callsBeforeRestart, '重启不应重复整理成功日期');
    assert.equal(hash(protectedData(finalProject)), humanProtection, '重启后人工编辑记录和日报应原样保留');
    assert.equal(networkAttempts, 0);
    sourceEnd = realSnapshot();
    assert.equal(await hashFile(thread.path), rolloutBefore, '只读验收不能修改原始会话');
  } finally {
    first?.stop(); restarted?.stop(); globalThis.fetch = originalFetch;
  }
  const sourceProtectionBefore = hash(protectedData(begin.project));
  const sourceProtectionAfter = hash(protectedData(sourceEnd.project));
  const report = {
    passed: true, createdAt: new Date().toISOString(), projectId: id, threadId: THREAD_ID,
    sourceMode: '正式项目管理数据副本 + 真实只读 Codex 会话 + 进程内模拟整理器',
    recent: { turns: recent.turns.length, truncated: recent.truncated, retainedDates: recent.coverage.retainedDates },
    history: { turns: history.turns.length, completedTurns: completed.length, dates: history.discoveredDates, truncated: history.truncated, scanComplete: history.coverage.scanComplete,
      completedByDate: Object.fromEntries([...grouped].map(([date, turns]) => [date, turns.length])) },
    earliestDate: { date: DATES[0], turns: earliest.turns.length },
    isolatedResult: { dailySummaries: finalProject.codex.dailySummaries.length, completedDates: finalProject.codex.history.completedDates,
      mockSummarizeCalls: calls.length, extraCallsAfterRestart: calls.length - callsBeforeRestart, existingHumanDataPreserved: true, syntheticHumanEditsPreserved: true, credentialsCopied: false, networkAttempts },
    readOnlyEvidence: { rolloutHash: rolloutBefore, rolloutUnchanged: true, realStoreHashBefore: begin.hash, realStoreHashAfter: sourceEnd.hash,
      protectedBusinessHashBefore: sourceProtectionBefore, protectedBusinessHashAfter: sourceProtectionAfter,
      protectedBusinessUnchanged: sourceProtectionBefore === sourceProtectionAfter,
      concurrentFormalStoreUpdate: begin.hash !== sourceEnd.hash, formalDataWrittenByAudit: false, customerDirectoryWrittenByAudit: false },
    fixture: path.relative(ROOT, fixture),
  };
  const output = path.join(ROOT, 'test-output', 'history-project-audit.json');
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
main().catch(error => {
  // Assertions and adapter errors are structural; never dump a real data object.
  process.stderr.write(`历史项目只读验收失败：${String(error.message).slice(0, 500)}\n`);
  process.exitCode = 1;
});
