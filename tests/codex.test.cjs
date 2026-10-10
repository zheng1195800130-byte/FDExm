'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listThreads, readThread, extractDrafts } = require('../src/core/codex.cjs');

const ts = '2026-10-08T16:05:00Z';
const event = (type, payload = {}, timestamp = ts) => ({ type: 'event_msg', timestamp, payload: { type, ...payload } });
const message = (role, text, extra = {}) => ({ type: 'response_item', timestamp: ts, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra } });
const meta = (id, cwd) => ({ type: 'session_meta', timestamp: ts, payload: { id, cwd } });
const temporaryRoot = path.join(__dirname, '..', '.tmp');

async function fixture(t, rows, id = 'thread-1', cwd = 'D:\\开发\\客户甲') {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const home = await fs.mkdtemp(path.join(temporaryRoot, 'fde-codex-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sessions = path.join(home, 'sessions', '2026', '10', '08');
  await fs.mkdir(sessions, { recursive: true });
  const file = path.join(sessions, `rollout-${id}.jsonl`);
  await fs.writeFile(file, [meta(id, cwd), ...rows].map(row => JSON.stringify(row)).join('\n') + '\n');
  return { home, file, cwd, threadId: id };
}

test('desktop task and item formats retain final summary, filter analysis/tools and context', async t => {
  const args = await fixture(t, [
    event('task_started', { turn_id: 'turn-a' }),
    message('user', '# AGENTS.md instructions\n<INSTRUCTIONS>不要收录偏好</INSTRUCTIONS>\n<environment_context>private env</environment_context>\n<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),
    event('item_completed', { item: { type: 'UserMessage', id: 'u', content: [{ type: 'input_text', text: '需求：支持客户表格导入' }] } }),
    message('user', '需求：支持客户表格导入'),
    message('assistant', '不要保存内部推理', { channel: 'analysis' }),
    message('assistant', '不要保存过程解说', { phase: 'commentary' }),
    { type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', output: '不要保存工具输出' } },
    event('item_completed', { item: { type: 'AgentMessage', content: [{ type: 'output_text', text: '过渡回答' }] } }),
    event('task_complete', { turn_id: 'turn-a', last_agent_message: '事项：表格导入\n处理：完成字段映射\n结果：样例通过，待客户验证' }),
    event('task_started', { turn_id: 'turn-b' }, '2026-10-09T01:00:00Z'),
    { ...message('user', '客户说还是不能导入'), timestamp: '2026-10-09T01:00:00Z' },
    event('task_complete', { turn_id: 'turn-b', last_agent_message: '事项：表格导入\n原因：合并单元格\n处理：调整读取方式\n结果：已修复，待客户测试' }, '2026-10-09T01:05:00Z'),
  ]);
  const result = await readThread(args);
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].userText, '需求：支持客户表格导入');
  assert.equal(result.turns[0].date, '2026-10-09');
  assert.match(result.turns[0].assistantText, /样例通过/);
  assert.doesNotMatch(JSON.stringify(result), /不要保存|private env|不要收录/);
  const drafts = extractDrafts(result.turns);
  assert.equal(drafts.requirements.length, 1);
  assert.equal(drafts.records.length, 2);
  assert.equal(drafts.records[0].cause, '');
  assert.equal(drafts.records[1].cause, '合并单元格');
  assert.deepEqual(drafts.records[1].origin, { threadId: 'thread-1', turnId: 'turn-b' });
  assert.equal(drafts.records[1].status, '待确认');
  assert.match(result.warning, /兼容读取/);
});

test('old event mirrors do not duplicate turns; repeated questions after answers are separate', async t => {
  const args = await fixture(t, [
    event('user_message', { message: '为什么导入失败？' }),
    message('user', '为什么导入失败？'),
    event('agent_message', { message: '我先检查一下' }),
    event('agent_message', { message: '问题：导入失败\n处理：检查样例\n结果：仍在定位' }),
    event('user_message', { message: '为什么导入失败？' }, '2026-10-09T16:01:00Z'),
    event('agent_message', { message: '问题：导入失败\n原因：字段名称变化\n处理：更新映射\n结果：样例通过' }, '2026-10-09T16:02:00Z'),
  ]);
  const result = await readThread(args);
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[1].date, '2026-10-10');
  assert.match(result.turns[0].assistantText, /仍在定位/);
  assert.match(result.turns[1].assistantText, /样例通过/);
});

test('explicit final phase wins; media and huge base64 never returned', async t => {
  const data = 'A'.repeat(18000);
  const args = await fixture(t, [
    event('task_started', { turn_id: 'media' }),
    { type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: `问题：截图里的错误\ndata:image/png;base64,${data}` },
      { type: 'input_image', image_url: `data:image/png;base64,${data}` },
      { type: 'input_file', path: 'D:\\资料\\样例.xlsx' },
    ] } },
    message('assistant', '事项：截图里的错误\n处理：已检查\n结果：待验证', { phase: 'final_answer' }),
    message('assistant', '不应覆盖最终回答', { phase: 'commentary' }),
  ]);
  const { turns } = await readThread(args);
  assert.equal(turns[0].attachments.length, 2);
  assert.equal(turns[0].attachments[1].path, 'D:\\资料\\样例.xlsx');
  assert.doesNotMatch(JSON.stringify(turns), /A{512}/);
  assert.match(turns[0].assistantText, /待验证/);
});

test('bounded summaries, malformed trailing JSON, and no speculative AI extraction', async t => {
  const args = await fixture(t, [
    message('user', '请处理这个问题'),
    message('assistant', '解释'.repeat(20000)),
  ]);
  await fs.appendFile(args.file, '{"type":');
  const { turns } = await readThread(args);
  assert.equal(turns[0].assistantText.length, 10000);
  assert.deepEqual(extractDrafts(turns), { requirements: [], records: [] });
  assert.deepEqual(extractDrafts([{ id: 'a', userText: '需求：支持表格导入？', assistantText: '' }]), { requirements: [], records: [] });
});

test('project matching is exact and credential/config files are never read or modified', async t => {
  const args = await fixture(t, [message('user', '支持表格导入')]);
  const credentials = path.join(args.home, 'auth.json');
  const config = path.join(args.home, 'config.toml');
  await fs.writeFile(credentials, 'SECRET_SHOULD_NOT_APPEAR');
  await fs.writeFile(config, 'CONFIG_SHOULD_NOT_APPEAR');
  const before = await fs.readFile(args.file, 'utf8');
  const threads = await listThreads({ home: args.home, cwd: 'd:/开发/客户甲/' });
  assert.equal(threads.length, 1);
  assert.equal((await listThreads({ home: args.home, cwd: 'D:\\开发\\客户甲副本' })).length, 0);
  await assert.rejects(readThread({ ...args, threadId: '../auth.json' }), /没有找到/);
  const result = await readThread(args);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|CONFIG/);
  assert.equal(await fs.readFile(args.file, 'utf8'), before);
  assert.equal(await fs.readFile(credentials, 'utf8'), 'SECRET_SHOULD_NOT_APPEAR');
  assert.equal(await fs.readFile(config, 'utf8'), 'CONFIG_SHOULD_NOT_APPEAR');
});

test('missing Codex home is a usable empty list and requires explicit thread selection', async () => {
  const home = path.join(os.tmpdir(), `fde-no-such-home-${Date.now()}`);
  assert.deepEqual(await listThreads({ home }), []);
  await assert.rejects(readThread({ home }), /主动关联/);
});

test('symlinked session directories cannot escape Codex home', async t => {
  const args = await fixture(t, [message('user', '正常会话')]);
  const outside = await fs.mkdtemp(path.join(temporaryRoot, 'fde-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'outside.jsonl'), [meta('outside', args.cwd), message('user', '不应读取')].map(row => JSON.stringify(row)).join('\n'));
  try { await fs.symlink(outside, path.join(args.home, 'sessions', 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前系统不能创建测试链接'); return; } throw error; }
  const threads = await listThreads(args);
  assert.deepEqual(threads.map(thread => thread.id), ['thread-1']);
});

test('draft extraction deduplicates mirrors and preserves distinct dated outcomes', () => {
  const item = { id: 't1', threadId: 's', date: '2026-10-08', userText: '补充需求：需要导出 PDF 文件', assistantText: '**事项：** 导出失败\n**处理：** 更新导出方式\n**结果：** 尚未验证', sourceRef: 'local#t1' };
  const drafts = extractDrafts([item, item, { ...item, id: 't2', date: '2026-10-09', assistantText: '事项：导出失败\n处理：完成复测\n结果：已通过样例测试' }]);
  assert.equal(drafts.requirements.length, 1);
  assert.equal(drafts.records.length, 2);
  assert.equal(drafts.records[0].cause, '');
});

test('oldest root metadata and bare message entries remain readable', async t => {
  const args = await fixture(t, []);
  await fs.writeFile(args.file, [
    { id: args.threadId, cwd: args.cwd, timestamp: ts },
    { type: 'message', timestamp: ts, role: 'user', content: [{ type: 'input_text', text: '需求：支持文字记录' }] },
    { type: 'message', timestamp: ts, role: 'assistant', content: [{ type: 'output_text', text: '事项：文字记录\n处理：已完成\n结果：待验证' }] },
  ].map(row => JSON.stringify(row)).join('\n'));
  const { turns } = await readThread(args);
  assert.equal(turns.length, 1);
  assert.equal(extractDrafts(turns).records.length, 1);
});

test('multiple issue blocks do not leak a previous cause into the next issue', () => {
  const drafts = extractDrafts([{ id: 't', date: '2026-10-08', assistantText: '问题：问题甲\n原因：甲的原因\n处理：甲的处理\n问题：问题乙\n处理：乙的处理\n结果：乙尚未验证' }]);
  assert.equal(drafts.records.length, 1);
  assert.equal(drafts.records[0].title, '问题乙');
  assert.equal(drafts.records[0].cause, '');
});

test('unchanged reads are independent snapshots and appended turns invalidate cache', async t => {
  const args = await fixture(t, [
    event('task_started', { turn_id: 'first' }),
    message('user', '问题：导入错误'),
    event('task_complete', { turn_id: 'first', last_agent_message: '事项：导入错误\n处理：复现\n结果：尚未修复' }),
  ]);
  const first = await readThread(args);
  first.thread.title = 'consumer mutation';
  first.turns[0].userText = 'changed by consumer';
  first.turns.push({ id: 'fake' });
  const second = await readThread(args);
  assert.equal(second.turns.length, 1);
  assert.equal(second.turns[0].userText, '问题：导入错误');
  assert.notEqual(second.thread.title, 'consumer mutation');
  second.turns[0].assistantText = 'changed again';
  const third = await readThread(args);
  assert.match(third.turns[0].assistantText, /尚未修复/);
  await fs.appendFile(args.file, [
    event('task_started', { turn_id: 'second' }),
    message('user', '继续处理导入错误'),
    event('task_complete', { turn_id: 'second', last_agent_message: '事项：导入错误\n处理：更新读取\n结果：样例通过' }),
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const refreshed = await readThread(args);
  assert.equal(refreshed.turns.length, 2);
  assert.match(refreshed.turns[1].assistantText, /样例通过/);
});

test('partially written trailing line becomes visible when completed after cached read', async t => {
  const args = await fixture(t, [message('user', '处理导入错误')]);
  const line = JSON.stringify(event('agent_message', { message: '事项：导入错误\n处理：调整读取\n结果：已完成' }));
  const split = Math.floor(line.length / 2);
  await fs.appendFile(args.file, line.slice(0, split));
  const partial = await readThread(args);
  assert.equal(partial.turns[0].assistantText, '');
  await fs.appendFile(args.file, line.slice(split) + '\n');
  const complete = await readThread(args);
  assert.match(complete.turns[0].assistantText, /已完成/);
});

test('spawned same-cwd rollouts cannot impersonate their inherited parent conversation', async t => {
  const parentId = '11111111-1111-7111-8111-111111111111';
  const childId = '22222222-2222-7222-8222-222222222222';
  const args = await fixture(t, [
    event('task_started', { turn_id: 'main-work' }),
    message('user', '主会话的问题'),
    event('task_complete', { turn_id: 'main-work', last_agent_message: '主会话的有效结果' }),
  ], parentId);
  const childFile = path.join(path.dirname(args.file), `rollout-${childId}.jsonl`);
  await fs.writeFile(childFile, [
    { ...meta(childId, args.cwd), payload: { id: childId, session_id: parentId, cwd: args.cwd, source: { subagent: { thread_spawn: { parent_thread_id: parentId } } } } },
    meta(parentId, args.cwd),
    event('task_started', { turn_id: 'inherited-work' }),
    message('user', '继承的主会话问题'),
    event('task_complete', { turn_id: 'inherited-work', last_agent_message: '继承的主会话结果' }),
    event('task_started', { turn_id: 'child-work' }),
    message('user', '子智能体任务'),
    event('task_complete', { turn_id: 'child-work', last_agent_message: '子智能体结果' }),
  ].map(row => JSON.stringify(row)).join('\n'));
  const newer = new Date(Date.now() + 10000);
  await fs.utimes(childFile, newer, newer);
  const threads = await listThreads(args);
  assert.deepEqual(threads.map(thread => thread.id), [parentId]);
  assert.equal(threads[0].path, args.file);
  const result = await readThread(args);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].assistantText, '主会话的有效结果');
  assert.match(result.turns[0].sourceRef, new RegExp(parentId));
  await assert.rejects(readThread({ ...args, threadId: childId }), /没有找到/);
});

test('human fork keeps first own metadata and is not renamed by inherited metadata', async t => {
  const forkId = '33333333-3333-7333-8333-333333333333';
  const inheritedId = '44444444-4444-7444-8444-444444444444';
  const args = await fixture(t, [
    meta(inheritedId, 'D:\\其他开发目录'),
    message('user', '人工分支继续工作'),
    message('assistant', '人工分支的结果', { phase: 'final_answer' }),
  ], forkId);
  const threads = await listThreads(args);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, forkId);
  assert.equal(threads[0].cwd, args.cwd);
  assert.equal((await readThread(args)).turns[0].assistantText, '人工分支的结果');
});

test('UUID filename inconsistent with first metadata is rejected rather than relabeled', async t => {
  const args = await fixture(t, [message('user', '不可信身份')], '55555555-5555-7555-8555-555555555555');
  await fs.writeFile(args.file, [meta('66666666-6666-7666-8666-666666666666', args.cwd), message('user', '不可信身份')].map(row => JSON.stringify(row)).join('\n'));
  assert.deepEqual(await listThreads(args), []);
  await assert.rejects(readThread(args), /没有找到/);
});

test('history reads work before a 96 MiB compaction snapshot without returning replay bodies', async t => {
  const earlier = '2026-09-21T01:00:00Z', later = '2026-09-29T01:00:00Z';
  const args = await fixture(t, [
    event('task_started', { turn_id: 'historical' }, earlier),
    { ...message('user', '历史导入需求'), timestamp: earlier },
    event('task_complete', { turn_id: 'historical', last_agent_message: '历史导入已完成' }, earlier),
  ]);
  const handle = await fs.open(args.file, 'a');
  try {
    await handle.write('{"timestamp":"2026-09-24T01:00:00Z","ordinal":1234,"type":"compacted","payload":{"snapshot":"');
    const block = 'X'.repeat(1024 * 1024);
    for (let index = 0; index < 97; index++) await handle.write(block);
    await handle.write('"}}\n');
    await handle.write([
      event('task_started', { turn_id: 'latest' }, later),
      { ...message('user', '后续导出需求'), timestamp: later },
      event('task_complete', { turn_id: 'latest', last_agent_message: '后续导出已完成' }, later),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
  } finally { await handle.close(); }
  const recent = await readThread(args);
  assert.deepEqual(recent.turns.map(turn => turn.id), ['latest']);
  assert.equal(recent.workTruncated, true);
  assert.equal(recent.coverage.scanComplete, false);
  const history = await readThread({ ...args, history: true });
  assert.deepEqual(history.turns.map(turn => turn.id), ['historical', 'latest']);
  assert.equal(history.truncated, false);
  assert.equal(history.workTruncated, false);
  assert.equal(history.coverage.scanComplete, true);
  assert.deepEqual(history.discoveredDates, ['2026-09-21', '2026-09-29']);
  assert.doesNotMatch(JSON.stringify(history), /X{512}|snapshot/);
  const oldDate = await readThread({ ...args, date: '2026-09-21' });
  assert.deepEqual(oldDate.turns.map(turn => turn.id), ['historical']);
  assert.equal(oldDate.coverage.mode, 'date');
  assert.equal(oldDate.workTruncated, false);
  assert.deepEqual((await readThread(args)).turns.map(turn => turn.id), ['latest']);
  assert.deepEqual((await readThread({ ...args, history: true })).turns.map(turn => turn.id), ['historical', 'latest']);
});

test('history discovers old work dates after the bounded turn buffer drops them; selected day restores them', async t => {
  const oldDate = '2026-09-21T01:00:00Z', newDate = '2026-09-29T01:00:00Z';
  const rows = [];
  for (let index = 0; index < 510; index++) {
    const timestamp = index < 10 ? oldDate : newDate;
    rows.push(event('task_started', { turn_id: `work-${index}` }, timestamp));
    rows.push({ ...message('user', `需求${index}`), timestamp });
    rows.push(event('task_complete', { turn_id: `work-${index}`, last_agent_message: `处理完成${index}` }, timestamp));
  }
  const args = await fixture(t, rows);
  const history = await readThread({ ...args, history: true });
  assert.equal(history.turns.length, 500);
  assert.equal(history.workTruncated, true);
  assert.equal(history.coverage.scanComplete, true);
  assert.deepEqual(history.coverage.retainedDates, ['2026-09-29']);
  assert.deepEqual(history.discoveredDates, ['2026-09-21', '2026-09-29']);
  const day = await readThread({ ...args, date: '2026-09-21' });
  assert.equal(day.turns.length, 10);
  assert.equal(day.workTruncated, false);
  assert.ok(day.turns.every(turn => turn.date === '2026-09-21' && turn.completed));
  const absent = await readThread({ ...args, date: '2026-09-23' });
  assert.deepEqual(absent.turns, []);
  assert.deepEqual(absent.discoveredDates, history.discoveredDates);
});

test('date selection uses Shanghai turn start day, validates dates, and preserves snapshot isolation', async t => {
  const args = await fixture(t, [
    event('task_started', { turn_id: 'night-work' }, '2026-09-21T16:05:00Z'),
    { ...message('user', '夜间修复'), timestamp: '2026-09-21T16:05:01Z' },
    event('task_complete', { turn_id: 'night-work', last_agent_message: '修复完成' }, '2026-09-22T16:05:00Z'),
  ]);
  const selected = await readThread({ ...args, date: '2026-09-22' });
  assert.equal(selected.turns.length, 1);
  assert.equal(selected.turns[0].date, '2026-09-22');
  selected.discoveredDates.push('1900-01-01');
  selected.coverage.retainedDates.length = 0;
  const fresh = await readThread({ ...args, date: '2026-09-22' });
  assert.deepEqual(fresh.discoveredDates, ['2026-09-22']);
  assert.deepEqual(fresh.coverage.retainedDates, ['2026-09-22']);
  assert.deepEqual((await readThread({ ...args, date: '2026-09-23' })).turns, []);
  for (const date of ['2026-02-31', '2026-1-1', '', null, '../auth.json']) await assert.rejects(readThread({ ...args, date }), /日期格式/);
});

test('an oversized original message is reported as omitted work rather than silently marked complete', async t => {
  const args = await fixture(t, [
    event('task_started', { turn_id: 'large-original' }),
    message('user', '原始媒体说明' + 'X'.repeat(3 * 1024 * 1024)),
    event('task_complete', { turn_id: 'large-original', last_agent_message: '已读取附件，待客户核对' }),
  ]);
  const history = await readThread({ ...args, history: true });
  assert.equal(history.workTruncated, true);
  assert.equal(history.truncated, true);
  assert.equal(history.coverage.scanComplete, true);
  assert.match(history.warning, /超长消息/);
  assert.equal(history.turns[0].userText, '');
  assert.doesNotMatch(JSON.stringify(history), /X{512}/);
});
