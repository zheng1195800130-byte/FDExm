'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { externalUrl } = require('../src/core/external-links.cjs');
function fixture(t) {
  const base = path.resolve(__dirname, '../.test-tmp'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'related-'));
  fs.mkdirSync(path.join(dir, 'source')); fs.mkdirSync(path.join(dir, 'dev'));
  const store = new Store(path.join(dir, 'data'));
  const p = store.createProject({ name: '关联事项', sourceDir: path.join(dir, 'source'), devDir: path.join(dir, 'dev') });
  store.updateProject(p.id, { codex: { threadId: 'related-thread' } });
  t.after(() => { assert.ok(dir.startsWith(base + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  const apply = (items, fingerprint, date = '2026-10-09') => store.applyDailySummary(p.id, { date, fingerprint, items, method: 'model', threadId: 'related-thread' });
  return { store, p, apply };
}
const a = { issueKey: 'model-access', title: '模型接入', cause: '需要多个服务', action: '增加模型列表', result: '可获取模型', status: '待验证', turnIds: ['one'], attachments: [] };
const b = { issueKey: 'model-select', title: '模型选择修复', cause: '选择未回填', action: '修复回填', result: '样例通过', status: '已完成', turnIds: ['two'], attachments: [] };
const independent = { issueKey: 'file-index', title: '资料检索', action: '补充文件介绍', result: '仍有文件无法解析，未解决', status: '未解决', turnIds: ['one'], attachments: [] };
const merged = { ...a, title: '完善模型接入与选择', relatedIssueKeys: [b.issueKey], action: '增加模型列表并修复选择回填', result: '已完成修改，待客户测试', turnIds: ['one', 'two'] };

test('关联事项替换旧自动拆分项，独立同轮任务和跨日记录保留', t => {
  const { store, p, apply } = fixture(t);
  apply([a], 'yesterday', '2026-10-08');
  const prior = apply([a, b, independent], 'split');
  const stableId = prior.records.find(record => record.date === '2026-10-09' && record.issueKey === a.issueKey).id;
  const after = apply([merged, independent], 'merged');
  assert.equal(after.records.filter(record => record.date === '2026-10-09').length, 2);
  assert.equal(after.records.find(record => record.date === '2026-10-09' && record.issueKey === a.issueKey).id, stableId);
  assert.equal(after.records.filter(record => record.date === '2026-10-08').length, 1);
  assert.equal(after.records.filter(record => record.issueKey === b.issueKey).length, 0);
  const report = store.generateReport(p.id, '2026-10-09');
  assert.equal((report.text.match(/^- /gm) || []).length, 2);
  assert.doesNotMatch(report.text, /状态：|待核对|日报草稿/);
  assert.match(report.text, /待客户测试/); assert.match(report.text, /未解决/);
  assert.doesNotMatch(after.codex.dailySummaries.find(summary => summary.date === '2026-10-09').reportText, /状态：|待核对/);
  assert.equal(report.needsReview, true, '核对元数据仍供管理界面使用');
});
test('已人工接管的旧子事项按关联编号保护，不新建重复自动记录', t => {
  const { store, p, apply } = fixture(t);
  const before = apply([a, b, independent], 'split');
  const original = before.records.find(record => record.issueKey === b.issueKey);
  store.upsertRecord(p.id, { id: original.id, title: '人工修正的模型事项', result: '客户仍反馈异常，未解决', status: '未解决', confirmed: true });
  store.saveReport(p.id, '2026-10-09', '人工定稿原文');
  const after = apply([merged, independent], 'merged');
  assert.equal(after.records.length, 2);
  const manual = after.records.find(record => record.id === original.id);
  assert.equal(manual.result, '客户仍反馈异常，未解决'); assert.equal(manual.confirmed, true);
  assert.equal(after.records.some(record => record.issueKey === a.issueKey), false);
  assert.equal(after.reports[0].text, '人工定稿原文');
  assert.match(store.generateReport(p.id, '2026-10-09').text, /客户仍反馈异常/);
  assert.match(after.codex.dailySummaries[0].reportText, /客户仍反馈异常/);
});
test('已删除的子事项不借合并复活，其他旧自动事项不会被一并删除', t => {
  const { store, p, apply } = fixture(t);
  const before = apply([a, b, independent], 'split');
  store.removeRecord(p.id, before.records.find(record => record.issueKey === b.issueKey).id);
  const after = apply([merged, independent], 'merged');
  assert.deepEqual(after.records.map(record => record.issueKey).sort(), [a.issueKey, independent.issueKey].sort());
  assert.equal(after.records.find(record => record.issueKey === a.issueKey).title, a.title);
  assert.equal(after.codex.dailySummaries[0].items.some(item => item.issueKey === b.issueKey || item.relatedIssueKeys.includes(b.issueKey)), false);
});
test('删除合并事项会屏蔽其所有旧编号，冲突的关联分组被拒绝', t => {
  const { store, p, apply } = fixture(t);
  const before = apply([merged, independent], 'merged');
  store.removeRecord(p.id, before.records.find(record => record.issueKey === a.issueKey).id);
  const after = apply([a, b, independent], 'resplit');
  assert.deepEqual(after.records.map(record => record.issueKey), [independent.issueKey]);
  const snapshot = store.getState();
  assert.throws(() => apply([merged, b], 'conflict'), /重复分组/);
  assert.deepEqual(store.getState(), snapshot);
});
test('Markdown 外链只能打开无凭据的 HTTP(S) 网页', () => {
  assert.equal(externalUrl('https://example.com/docs?q=1#part'), 'https://example.com/docs?q=1#part');
  assert.equal(externalUrl('http://localhost:8080/docs'), 'http://localhost:8080/docs');
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///D:/secret.txt', 'mailto:test@example.com', 'https://user:pass@example.com', 'https://example.com/\nfile', '//example.com', null]) assert.throws(() => externalUrl(value));
});
