'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listProjectThreads, projectDirectoryRelation } = require('../src/core/project-threads.cjs');

const thread = (id, cwd, updatedAt = '2026-10-09T01:00:00Z') => ({ id, cwd, title: `会话 ${id}`, path: `fixture-${id}.jsonl`, updatedAt });
function fixture(exact, catalog) {
  const calls = [];
  return { calls, reader: { listThreads: async input => { calls.push(input); return input ? exact : catalog; } } };
}

test('精确匹配优先，已有项目关联不会因父目录候选而改写或加载整个会话目录', async () => {
  const cwd = 'D:\\code\\客户甲\\应用项目', exact = [thread('exact', cwd)];
  const f = fixture(exact, [thread('parent', 'D:\\code\\客户甲')]);
  const result = await listProjectThreads({ cwd, reader: f.reader });
  assert.equal(result.threads, exact);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(f.calls, [{ cwd }]);
  assert.deepEqual(exact[0], thread('exact', cwd), '不得修改原会话身份或字段');
});

test('误选样例子目录时提供上一级真实应用会话建议，不自动绑定或读取正文', async () => {
  const root = 'D:\\code\\客户甲\\智能配载\\smart-load-distribution';
  const original = thread('main-chat', root);
  const f = fixture([], [original]);
  const result = await listProjectThreads({ cwd: root + '\\样例文件', reader: f.reader });
  assert.deepEqual(result.threads, []);
  assert.deepEqual(result.candidates, [{ ...original, relation: 'parent', distance: 1 }]);
  assert.equal(Object.hasOwn(original, 'relation'), false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1], undefined);
});

test('Windows大小写、斜杠、尾斜杠和路径归一化跨平台保持正确父子关系', async () => {
  const cwd = 'd:/CODE/客户甲/应用/样例/';
  const f = fixture([], [thread('parent-one', 'D:\\code\\客户甲\\应用\\'), thread('parent-two', 'd:/code/客户甲'),
    thread('child-one', 'D:\\CODE\\客户甲\\应用\\样例\\反馈'), thread('child-two', 'D:/code/客户甲/应用/样例/反馈/附件'),
    thread('same-normalized', 'D:\\code\\客户甲\\应用\\样例'), thread('normalized-parent', 'D:/code/客户甲/应用/暂存/..')]);
  const result = await listProjectThreads({ cwd, reader: f.reader });
  assert.deepEqual(result.candidates.map(item => [item.id, item.relation, item.distance]), [
    ['normalized-parent', 'parent', 1], ['parent-one', 'parent', 1], ['parent-two', 'parent', 2], ['child-one', 'child', 1], ['child-two', 'child', 2],
  ]);
});

test('拒绝仅文本前缀、兄弟项目、不同盘、超出两级与盘符根的候选', async () => {
  const cwd = 'D:\\code\\客户甲\\项目';
  const f = fixture([], [thread('prefix', cwd + '-副本'), thread('prefix-child', cwd + '-副本\\资料'),
    thread('sibling', 'D:\\code\\客户甲\\其他项目'), thread('another-drive', 'E:\\code\\客户甲'),
    thread('too-far-child', cwd + '\\a\\b\\c'), thread('drive', 'D:\\'), thread('code-root', 'D:\\code'),
    thread('valid-parent', 'D:\\code\\客户甲'), thread('valid-child', cwd + '\\资料')]);
  const result = await listProjectThreads({ cwd, reader: f.reader });
  assert.deepEqual(result.candidates.map(item => item.id), ['valid-parent', 'valid-child']);
});

test('盘根及顶层集合目录没有精确会话时不展开全目录推荐', async () => {
  for (const cwd of ['D:\\', 'D:\\code', '/', '/workspace']) {
    const f = fixture([], [thread('unrelated', 'D:\\code\\客户甲\\项目')]);
    assert.deepEqual(await listProjectThreads({ cwd, reader: f.reader }), { threads: [], candidates: [] });
    assert.deepEqual(f.calls, [{ cwd }]);
  }
});

test('POSIX路径按真实路径段和区分大小写规则匹配，不把同名前缀当子目录', async () => {
  const cwd = '/workspace/client/app/samples';
  const f = fixture([], [thread('parent', '/workspace/client/app/'), thread('two-parent', '/workspace/client'),
    thread('child', cwd + '/feedback'), thread('upper', '/workspace/Client/app'), thread('prefix', '/workspace/client/application'),
    thread('windows', 'D:\\workspace\\client\\app')]);
  const result = await listProjectThreads({ cwd, reader: f.reader });
  assert.deepEqual(result.candidates.map(item => [item.id, item.relation, item.distance]), [['parent', 'parent', 1], ['two-parent', 'parent', 2], ['child', 'child', 1]]);
});

test('UNC共享路径仅匹配相同server/share且不会推荐共享根', async () => {
  const cwd = '\\\\server\\share\\客户甲\\应用\\样例';
  const f = fixture([], [thread('parent', '\\\\SERVER\\SHARE\\客户甲\\应用'), thread('share-root', '\\\\server\\share\\'),
    thread('another-share', '\\\\server\\other\\客户甲\\应用'), thread('another-server', '\\\\other\\share\\客户甲\\应用')]);
  const result = await listProjectThreads({ cwd, reader: f.reader });
  assert.deepEqual(result.candidates.map(item => item.id), ['parent']);
});

test('相关建议去重并有数量限制，保持原始标题、路径与更新时间', async () => {
  const cwd = 'D:\\code\\客户甲\\项目', catalog = [];
  for (let index = 0; index < 55; index++) catalog.push(thread(`candidate-${String(index).padStart(2, '0')}`, cwd + '\\资料', `2026-10-09T01:${String(index).padStart(2, '0')}:00Z`));
  catalog.push(catalog[0]);
  const f = fixture([], catalog);
  const result = await listProjectThreads({ cwd, reader: f.reader });
  assert.equal(result.candidates.length, 40);
  assert.equal(new Set(result.candidates.map(item => item.id)).size, 40);
  assert.equal(result.candidates[0].id, 'candidate-54');
  assert.equal(result.candidates[0].title, '会话 candidate-54');
  assert.equal(result.candidates[0].path, 'fixture-candidate-54.jsonl');
});

test('无效或非绝对项目路径不触发会话发现，读取器异常如实交给调用方处理', async () => {
  for (const cwd of [undefined, '', 'relative/app', 'D:relative', '\u0000bad', '\\\\?\\D:\\code\\app']) {
    const f = fixture([], []);
    await assert.rejects(listProjectThreads({ cwd, reader: f.reader }), /项目开发目录无效/);
    assert.deepEqual(f.calls, []);
  }
  const error = new Error('isolated catalog failure');
  await assert.rejects(listProjectThreads({ cwd: 'D:\\code\\客户甲\\项目', reader: { listThreads: async () => { throw error; } } }), error);
});

test('目录关系helper与候选限制一致，精确目录需调用方继续走严格关联校验', () => {
  const cwd = 'D:\\code\\客户甲\\项目\\样例';
  assert.deepEqual(projectDirectoryRelation(cwd, 'd:/CODE/客户甲/项目/'), { relation: 'parent', distance: 1 });
  assert.deepEqual(projectDirectoryRelation(cwd, cwd + '\\反馈'), { relation: 'child', distance: 1 });
  assert.equal(projectDirectoryRelation(cwd, cwd), null);
  assert.equal(projectDirectoryRelation(cwd, 'D:\\code\\客户甲\\兄弟项目'), null);
  assert.equal(projectDirectoryRelation(cwd, 'D:\\code'), null);
  assert.equal(projectDirectoryRelation('D:\\', 'D:\\code\\项目'), null);
  assert.equal(projectDirectoryRelation(undefined, cwd), null);
});
