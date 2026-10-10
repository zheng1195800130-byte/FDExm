'use strict';
// Real stored summaries + read-only rollouts, isolated writes, no real key/API.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const { SummaryService } = require('../src/core/summary-service.cjs');
const reader = require('../src/core/codex.cjs');
const summarizer = require('../src/core/summarizer.cjs');
const root = path.resolve(__dirname, '..');
const realData = path.join(root, 'release/FDE Desk-win32-x64/data');
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const original = fs.readFileSync(path.join(realData, 'store.json'));
const state = JSON.parse(original), rules = fs.readFileSync(path.join(realData, '整理规则.md'), 'utf8');
const base = path.join(root, '.test-tmp'); fs.mkdirSync(base, { recursive: true });
const fixture = fs.mkdtempSync(path.join(base, 'legacy-checkpoint-'));
const dataDir = path.join(fixture, 'data'); fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(dataDir, 'store.json'), original);
let modelCalls = 0, networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error('验收禁止网络'); };
const makeService = store => new SummaryService({ store, reader,
  summarizer: { ...summarizer, summarizeDay: async () => { modelCalls++; throw new Error('成功旧摘要不应重新调用模型'); } },
  getModel: () => ({ config: state.settings.summarizer, apiKey: 'isolated-fake-key' }), getRules: () => rules,
});
const run = async (service, id) => { service.schedule(id, { delay: 10000 }); clearTimeout(service.jobs.get(id).timer); await service.run(id); };
const summaryContent = p => p.codex.dailySummaries.map(({ processedTurns, ...summary }) => summary);
(async () => {
  let service;
  try {
    let store = new Store(dataDir); service = makeService(store);
    for (const p of state.projects.filter(p => p.codex.threadId)) await run(service, p.id);
    const migrated = store.getState();
    const results = state.projects.filter(p => p.codex.threadId).map(before => {
      const after = migrated.projects.find(p => p.id === before.id);
      assert.equal(hash(summaryContent(after)), hash(summaryContent(before)), '摘要正文与原更新时间必须保留');
      assert.equal(hash(after.records), hash(before.records), '迁移不能修改工作记录');
      assert.equal(hash(after.reports), hash(before.reports), '迁移不能修改已保存日报');
      assert.ok(after.codex.dailySummaries.every(summary => !!summary.processedTurns));
      return { projectId: before.id, preservedDates: after.codex.dailySummaries.length, checkpointTurns: after.codex.dailySummaries.reduce((n, s) => n + Object.keys(s.processedTurns).length, 0) };
    });
    assert.equal(modelCalls, 0); service.stop();
    store = new Store(dataDir); service = makeService(store);
    for (const p of state.projects.filter(p => p.codex.threadId)) await run(service, p.id);
    assert.equal(modelCalls, 0); assert.equal(networkCalls, 0);
    assert.equal(hash(fs.readFileSync(path.join(realData, 'store.json'))), hash(original), '验收不能改正式档案');
    const report = { passed: true, checkedAt: new Date().toISOString(), projects: results, modelCalls, networkCalls, extraCallsAfterRestart: 0,
      originalStoreUnchanged: true, originalRecordsAndSummariesPreserved: true, realCredentialsRead: false, fixture: path.relative(root, fixture) };
    fs.writeFileSync(path.join(root, 'test-output/旧摘要增量迁移验收.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { service?.stop(); globalThis.fetch = originalFetch; }
})().catch(error => { console.error(`旧摘要迁移验收失败：${String(error.message).slice(0, 200)}`); process.exitCode = 1; });
