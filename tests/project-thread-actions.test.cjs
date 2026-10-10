'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { MemoStore } = require('../src/core/memos.cjs');
const { createProjectThreadActions } = require('../desktop/project-thread-actions.cjs');

function fixture(t, { sourceIsRoot = false } = {}) {
  const base = path.resolve(__dirname, '../.test-tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'project-binding-'));
  const appDir = path.join(root, '应用项目'), sampleDir = path.join(appDir, '样例文件');
  const sourceDir = sourceIsRoot ? appDir : path.join(root, '原始资料');
  for (const directory of [sampleDir, sourceDir]) fs.mkdirSync(directory, { recursive: true });
  const store = new Store(path.join(root, 'data'));
  const p = store.createProject({ name: '目录候选关联', sourceDir, devDir: sampleDir });
  const catalog = [], calls = [];
  const normalized = value => path.resolve(value).toLowerCase();
  const reader = { listThreads: async input => {
    calls.push(input);
    return catalog.filter(thread => !input?.cwd || normalized(thread.cwd) === normalized(input.cwd));
  } };
  const actions = createProjectThreadActions({ store, reader });
  const thread = (id, cwd) => ({ id, cwd, title: `隔离会话 ${id}`, path: path.join(root, `${id}.jsonl`), updatedAt: '2026-10-09T01:00:00Z' });
  const current = () => store.getState().projects.find(project => project.id === p.id);
  const disk = () => fs.readFileSync(path.join(root, 'data', 'store.json'), 'utf8');
  t.after(() => { assert.ok(root.startsWith(`${base}${path.sep}`)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, appDir, sampleDir, sourceDir, store, p, catalog, calls, actions, thread, current, disk };
}

test('精确会话仍按旧流程关联，列表读取不写项目或自动替换已有绑定', async t => {
  const f = fixture(t); f.catalog.push(f.thread('first', f.sampleDir), f.thread('chosen', f.sampleDir), f.thread('parent', f.appDir));
  f.store.bindCodexThread(f.p.id, { threadId: 'chosen' });
  const before = f.disk(), result = await f.actions.list(f.p.id);
  assert.deepEqual(result.threads.map(thread => thread.id), ['first', 'chosen']); assert.deepEqual(result.candidates, []);
  assert.equal(f.disk(), before); assert.equal(f.current().codex.threadId, 'chosen');
  const bound = await f.actions.bind(f.p.id, { threadId: 'first' });
  assert.equal(bound.codex.threadId, 'first'); assert.equal(bound.devDir, f.sampleDir);
});

test('父子候选必须显式 adoptCwd:true；兄弟、任意cwd和无效同意不改项目', async t => {
  const f = fixture(t), sibling = path.join(f.root, '其他项目'); fs.mkdirSync(sibling);
  f.catalog.push(f.thread('parent', f.appDir), f.thread('sibling', sibling));
  const before = f.disk();
  assert.deepEqual((await f.actions.list(f.p.id)).candidates.map(thread => thread.id), ['parent']);
  await assert.rejects(f.actions.bind(f.p.id, { threadId: 'parent', cwd: f.appDir }), /不属于/);
  await assert.rejects(f.actions.bind(f.p.id, { threadId: 'parent', adoptCwd: 'true' }), /关联无效/);
  await assert.rejects(f.actions.bind(f.p.id, { threadId: 'sibling', adoptCwd: true, cwd: f.appDir }), /推荐会话已变化/);
  await assert.rejects(f.actions.bind(f.p.id, { threadId: 'unknown', adoptCwd: true }), /推荐会话已变化/);
  assert.equal(f.disk(), before); assert.equal(f.current().codex.threadId, '');
});

test('显式纠正目录与绑定单次commit，默认成果目录同步且忽略renderer任意cwd', async t => {
  const f = fixture(t); f.catalog.push(f.thread('parent', f.appDir));
  let commits = 0; const original = f.store._commit;
  f.store._commit = function (...args) { commits++; return original.apply(this, args); };
  const bound = await f.actions.bind(f.p.id, { threadId: 'parent', adoptCwd: true, cwd: 'D:\\任意传入目录' });
  assert.equal(commits, 1); assert.equal(bound.devDir, f.appDir); assert.equal(bound.artifactDir, f.appDir);
  assert.equal(bound.codex.threadId, 'parent'); assert.equal(bound.sourceDir, f.sourceDir);
  assert.deepEqual(f.calls.at(-1), { cwd: f.appDir }, '纠正前重新进行候选目录的精确身份验证');
  const persisted = new Store(f.store.dataDir).getState().projects.find(project => project.id === f.p.id);
  assert.equal(persisted.devDir, f.appDir); assert.equal(persisted.codex.threadId, 'parent');
});

test('纠正保留合法成果关注子目录、原始资料介绍、人工工作与独立备忘录', async t => {
  const f = fixture(t), focus = path.join(f.sampleDir, '关注成果'); fs.mkdirSync(focus);
  const originalFile = path.join(f.sourceDir, '客户业务.md'); fs.writeFileSync(originalFile, '隔离原始业务资料');
  f.store.updateProject(f.p.id, { artifactDir: focus }); await f.store.scanProject(f.p.id);
  const source = f.current().files.find(file => file.path === originalFile);
  f.store.updateFile(f.p.id, source.id, { description: '人工业务用途介绍' });
  f.store.upsertRecord(f.p.id, { date: '2026-10-09', issueKey: 'manual', title: '人工核对客户反馈', result: '等待客户复测', confirmed: true });
  f.store.upsertRequirement(f.p.id, { title: '客户需求', description: '保持来源对应', status: '待确认' });
  const memos = new MemoStore({ projectFolder: id => f.store.projectFolder(id) }); memos.save(f.p.id, { text: '个人随手记' });
  const before = f.current(), note = memos.get(f.p.id), sourceText = fs.readFileSync(originalFile, 'utf8');
  f.catalog.push(f.thread('parent', f.appDir));
  const bound = await f.actions.bind(f.p.id, { threadId: 'parent', adoptCwd: true });
  assert.equal(bound.artifactDir, focus); assert.equal(bound.id, before.id); assert.equal(bound.sourceDir, before.sourceDir);
  assert.deepEqual(bound.files.find(file => file.id === source.id), before.files.find(file => file.id === source.id));
  assert.deepEqual(bound.records, before.records); assert.deepEqual(bound.requirements, before.requirements);
  assert.deepEqual(memos.get(f.p.id), note); assert.equal(fs.readFileSync(originalFile, 'utf8'), sourceText);
});

test('纠正目录时旧自动成果归档，人工接管记录和手工日报继续保留', async t => {
  const f = fixture(t); f.store.bindCodexThread(f.p.id, { threadId: 'old-bound' });
  f.store.applyDailySummary(f.p.id, { date: '2026-10-09', threadId: 'old-bound', fingerprint: 'old-summary', method: 'model', items: [
    { issueKey: 'automatic', title: '旧自动处理', action: '完成旧工作', result: '待客户复测', status: '待验证', turnIds: ['one'] },
    { issueKey: 'manual-protected', title: '待人工核对', action: '处理第二项', result: '已定位', status: '待验证', turnIds: ['two'] },
  ] });
  const original = f.current(), protectedRecord = original.records.find(record => record.issueKey === 'manual-protected');
  f.store.upsertRecord(f.p.id, { id: protectedRecord.id, title: '人工核对结论', confirmed: true });
  f.store.saveReport(f.p.id, '2026-10-09', '人工已确认日报');
  f.catalog.push(f.thread('parent', f.appDir));
  const bound = await f.actions.bind(f.p.id, { threadId: 'parent', adoptCwd: true });
  assert.equal(bound.codex.threadId, 'parent'); assert.equal(bound.codex.dailySummaries.length, 0);
  assert.equal(bound.codex.summaryArchives.length, 1); assert.equal(bound.codex.summaryArchives[0].threadId, 'old-bound');
  assert.deepEqual(bound.codex.summaryArchives[0].dailySummaries, original.codex.dailySummaries);
  assert.deepEqual(bound.codex.summaryArchives[0].records.map(record => record.issueKey), ['automatic']);
  assert.equal(bound.records.length, 1); assert.equal(bound.records[0].id, protectedRecord.id); assert.equal(bound.records[0].title, '人工核对结论');
  assert.equal(bound.reports[0].text, '人工已确认日报');
});

test('候选在提交前或第二次精确验证时消失，拒绝半更新', async t => {
  const f = fixture(t); f.catalog.push(f.thread('parent', f.appDir)); await f.actions.list(f.p.id);
  const before = f.disk(); f.catalog.length = 0;
  await assert.rejects(f.actions.bind(f.p.id, { threadId: 'parent', adoptCwd: true }), /推荐会话已变化/);
  assert.equal(f.disk(), before);
  const actions = createProjectThreadActions({ store: f.store, reader: { listThreads: async input => input?.cwd ? [] : [f.thread('parent', f.appDir)] } });
  await assert.rejects(actions.bind(f.p.id, { threadId: 'parent', adoptCwd: true }), /会话目录已变化/);
  assert.equal(f.disk(), before);
});

test('候选目录不能与原始资料目录相同，失败保留原目录和原绑定', async t => {
  const f = fixture(t, { sourceIsRoot: true }); f.store.bindCodexThread(f.p.id, { threadId: 'existing' });
  f.catalog.push(f.thread('parent', f.appDir)); const before = f.disk();
  await assert.rejects(f.actions.bind(f.p.id, { threadId: 'parent', adoptCwd: true }), /不能相同/);
  assert.equal(f.disk(), before); assert.equal(f.current().devDir, f.sampleDir); assert.equal(f.current().codex.threadId, 'existing');
});

test('普通项目目录编辑仍清空绑定，不能借codex字段绕过显式关联校验', t => {
  const f = fixture(t); f.store.bindCodexThread(f.p.id, { threadId: 'existing' });
  const other = path.join(f.root, '另一个开发目录'); fs.mkdirSync(other);
  const updated = f.store.updateProject(f.p.id, { devDir: other, codex: { threadId: 'forged' } });
  assert.equal(updated.devDir, other); assert.equal(updated.codex.threadId, ''); assert.equal(updated.artifactDir, other);
});

test('解除关联无需候选并保持开发目录，错误项目和空候选确认均拒绝', async t => {
  const f = fixture(t); f.store.bindCodexThread(f.p.id, { threadId: 'existing' });
  const unbound = await f.actions.bind(f.p.id, { threadId: '' }); assert.equal(unbound.codex.threadId, ''); assert.equal(unbound.devDir, f.sampleDir);
  const before = f.disk(); await assert.rejects(f.actions.bind(f.p.id, { threadId: '', adoptCwd: true }), /请先选择/);
  await assert.rejects(f.actions.bind('missing-project', { threadId: 'unknown' }), /项目不存在/);
  assert.throws(() => f.actions.list('missing-project'), /项目不存在/); assert.equal(f.disk(), before);
});
