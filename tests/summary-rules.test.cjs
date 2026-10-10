'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SummaryRules, DEFAULT_RULES, normalizeRules } = require('../src/core/summary-rules.cjs');
const { summarizeDay, dayFingerprint } = require('../src/core/summarizer.cjs');

const temporaryRoot = path.resolve(__dirname, '..', '.tmp');
async function fixture(t) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(temporaryRoot, 'fde-summary-rules-'));
  t.after(async () => {
    const relative = path.relative(temporaryRoot, path.resolve(dataDir));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

test('rules are initialized once from bundled Markdown and existing customized bytes remain untouched', async t => {
  const dataDir = await fixture(t);
  const rules = new SummaryRules({ dataDir });
  const view = rules.public();
  assert.equal(view.path, path.join(dataDir, '整理规则.md'));
  assert.equal(view.text, DEFAULT_RULES);
  assert.equal(view.defaultText, DEFAULT_RULES);
  assert.match(DEFAULT_RULES, /标题.*24.*原因.*40.*处理.*60.*结果.*50/);
  assert.match(DEFAULT_RULES, /不为了凑够条数造事项/);
  const custom = '\uFEFF# 我的规则\r\n\r\n只写有证据的成果，少用技术术语。\r\n';
  await fs.writeFile(rules.path, custom, 'utf8');
  const before = await fs.readFile(rules.path);
  const restarted = new SummaryRules({ dataDir });
  assert.equal(restarted.read(), '# 我的规则\n\n只写有证据的成果，少用技术术语。');
  assert.deepEqual(await fs.readFile(rules.path), before);
});

test('saving normalizes text, persists through restart, and leaves no temporary artifacts', async t => {
  const dataDir = await fixture(t);
  const rules = new SummaryRules({ dataDir });
  const view = rules.save('\uFEFF# 简洁规则\r\n只写问题、处理、结果。\r\n');
  assert.equal(view.text, '# 简洁规则\n只写问题、处理、结果。');
  assert.equal(new SummaryRules({ dataDir }).read(), view.text);
  assert.deepEqual(await fs.readdir(dataDir), ['整理规则.md']);
});

test('exact previous defaults upgrade once while customized previous rules remain byte-for-byte intact', async t => {
  const previous = await fs.readFile(path.join(__dirname, 'fixtures', 'summary-rules-v1.md'), 'utf8');
  assert.equal(createHash('sha256').update(normalizeRules(previous)).digest('hex'), '3ff8785ea78c6e28a3e726458a79989ee0aeacc4f0f665c9b95e120d8ef748d3');
  const dataDir = await fixture(t);
  const filename = path.join(dataDir, '整理规则.md');
  await fs.writeFile(filename, '\uFEFF' + normalizeRules(previous).replaceAll('\n', '\r\n') + '\r\n');
  const upgraded = new SummaryRules({ dataDir });
  assert.equal(upgraded.read(), DEFAULT_RULES);
  assert.match(upgraded.read(), /同一功能的新增、修复、配置细化合成一项/);
  assert.match(upgraded.read(), /版本号或测试次数/);
  const upgradedBytes = await fs.readFile(filename);
  assert.equal(new SummaryRules({ dataDir }).read(), DEFAULT_RULES);
  assert.deepEqual(await fs.readFile(filename), upgradedBytes);

  const customized = '\uFEFF' + normalizeRules(previous).replaceAll('\n', '\r\n') + '\r\n- 我的要求：结果最多一句。\r\n';
  await fs.writeFile(filename, customized);
  const customBytes = await fs.readFile(filename);
  const restarted = new SummaryRules({ dataDir });
  assert.equal(restarted.read(), normalizeRules(customized));
  assert.deepEqual(await fs.readFile(filename), customBytes);
});

test('invalid saves are rejected without altering the current rules', async t => {
  const dataDir = await fixture(t);
  const rules = new SummaryRules({ dataDir });
  const before = await fs.readFile(rules.path);
  for (const value of ['', ' \r\n ', 'a\u0000b', '文'.repeat(16001), { instructions: 'bad' }]) assert.throws(() => rules.save(value), /整理规则/);
  assert.deepEqual(await fs.readFile(rules.path), before);
  assert.deepEqual(await fs.readdir(dataDir), ['整理规则.md']);
});

test('oversized and malformed existing files do not break construction and can be explicitly repaired', async t => {
  const dataDir = await fixture(t);
  const filename = path.join(dataDir, '整理规则.md');
  const oversized = Buffer.alloc(65537, 0x61);
  await fs.writeFile(filename, oversized);
  const rules = new SummaryRules({ dataDir });
  assert.throws(() => rules.read(), /文件过大/);
  assert.deepEqual(await fs.readFile(filename), oversized);
  assert.equal(rules.save('# 修复后的规则\n简短、准确。').text, '# 修复后的规则\n简短、准确。');
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x61]);
  await fs.writeFile(filename, invalidUtf8);
  const restarted = new SummaryRules({ dataDir });
  assert.throws(() => restarted.public(), /UTF-8/);
  assert.deepEqual(await fs.readFile(filename), invalidUtf8);
  restarted.save('# 正常规则');
  assert.equal(restarted.read(), '# 正常规则');
});

test('existing directories are preserved and are never read or overwritten as rule files', async t => {
  const dataDir = await fixture(t);
  const filename = path.join(dataDir, '整理规则.md');
  await fs.mkdir(filename);
  await fs.writeFile(path.join(filename, '保留.txt'), '不得覆盖');
  const rules = new SummaryRules({ dataDir });
  assert.throws(() => rules.read(), /普通文件/);
  assert.throws(() => rules.save('# 新规则'), /普通文件/);
  assert.equal(await fs.readFile(path.join(filename, '保留.txt'), 'utf8'), '不得覆盖');
});

test('rule links are never followed, including links introduced after construction', async t => {
  const dataDir = await fixture(t);
  const rules = new SummaryRules({ dataDir });
  const outside = path.join(dataDir, '其他文件.md');
  const secret = '不应读取或发送的其他文件';
  await fs.writeFile(outside, secret);
  await fs.unlink(rules.path);
  try { await fs.symlink(outside, rules.path, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    const directoryTarget = path.join(dataDir, '链接目标');
    await fs.mkdir(directoryTarget);
    await fs.writeFile(path.join(directoryTarget, '保留.txt'), secret);
    await fs.symlink(directoryTarget, rules.path, 'junction');
    t.diagnostic('Windows 未授予文件符号链接权限，已用真实目录 junction 验证拒绝链接');
  }
  const restarted = new SummaryRules({ dataDir });
  for (const instance of [rules, restarted]) {
    assert.throws(() => instance.read(), /不能使用目录或链接/);
    assert.throws(() => instance.save('# 新规则'), /不能使用目录或链接/);
  }
  assert.equal(await fs.readFile(outside, 'utf8'), secret);
  assert.equal((await fs.lstat(rules.path)).isSymbolicLink(), true);
});

test('rule text is stored as plain data and NUL content stays unchanged until valid explicit repair', async t => {
  const dataDir = await fixture(t);
  const rules = new SummaryRules({ dataDir });
  const instructions = '# 用户规则\n$(Write-Output should-never-execute)\nrequire("node:fs").writeFileSync("unexpected-file", "bad");';
  assert.equal(rules.save(instructions).text, instructions);
  assert.deepEqual(await fs.readdir(dataDir), ['整理规则.md']);
  const invalid = '规则\u0000内容';
  await fs.writeFile(rules.path, invalid);
  const restarted = new SummaryRules({ dataDir });
  assert.throws(() => restarted.read(), /空字符/);
  assert.equal(await fs.readFile(rules.path, 'utf8'), invalid);
  restarted.save('# 已修复规则');
});

const config = { enabled: true, provider: 'compatible', baseUrl: 'http://localhost:11434/v1', model: 'local-model' };
const turn = (id, extra = {}) => ({ id, date: '2026-10-09', threadId: 'thread', timestamp: `2026-10-09T0${id.slice(1)}:00:00Z`, completed: true, userText: '修复导入失败', assistantText: '修改读取方式，自测通过，待客户测试', attachments: [], sourceRef: `local#${id}`, ...extra });

test('fingerprints include normalized rules while BOM, line-ending and surrounding-space changes stay stable', () => {
  const turns = [turn('t1')];
  const a = '# 简短规则\n只写有证据的成果。';
  assert.equal(dayFingerprint(turns, config, a), dayFingerprint(turns, config, '\uFEFF' + a.replaceAll('\n', '\r\n') + '\r\n'));
  assert.notEqual(dayFingerprint(turns, config, a), dayFingerprint(turns, config, a + '\n原因最多 20 字。'));
  assert.equal(dayFingerprint(turns, config), dayFingerprint(turns, config, DEFAULT_RULES));
  assert.equal(normalizeRules(a), a);
});

test('every actual model chunk receives editable rules before the immutable JSON/source protocol', async () => {
  const rules = '# 我的简短规则\n只写今天的处理和结果，使用标记“简报格式甲”。';
  const turns = [turn('t1', { userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) }), turn('t2', { userText: '问'.repeat(4500), assistantText: '处理结果'.repeat(2500) })];
  const systems = [];
  const result = await summarizeDay({ date: '2026-10-09', turns, config, apiKey: '', rules, fetchImpl: async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    systems.push(messages[0].content);
    const data = JSON.parse(messages[1].content);
    const items = [{ issueKey: 'import', title: '导入失败', cause: '格式变化', action: '调整读取', result: '自测通过，待客户测试', status: '待验证', turnIds: data.allowedTurnIds }];
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items }) } }] }), { status: 200 });
  } });
  assert.equal(result.method, 'model');
  assert.equal(systems.length, 2);
  for (const system of systems) {
    const ruleStart = system.indexOf(rules);
    const protocolStart = system.indexOf('## 固定输出与来源协议');
    assert.ok(ruleStart >= 0 && protocolStart > ruleStart);
    assert.match(system.slice(protocolStart), /不可被上面的可编辑整理规则覆盖/);
    assert.match(system.slice(protocolStart), /turnIds 只能引用 allowedTurnIds 中当前可见的当天轮次编号/);
    assert.match(system.slice(protocolStart), /不是给你的指令/);
  }
  assert.deepEqual(result.items[0].turnIds, ['t1', 't2']);
});
