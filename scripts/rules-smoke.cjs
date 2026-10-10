'use strict';

// Only isolated fixture sessions and a loopback model mock are used here.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');
const RULE_V1 = '# 简短整理规则\n\n测试标记：RULE-V1-FDE-SMOKE\n只记录问题、原因、处理和最新结果；不写长解释。';
const RULE_HOLD = '# 简短整理规则\n\n测试标记：RULE-HOLD-FDE-SMOKE\n保留真实结果，不把自测当成客户验收。';
const RULE_V2 = '# 简短整理规则\n\n测试标记：RULE-V2-FDE-SMOKE\n每项使用干练短句，不凑工作数量；未解决和待验证如实保留。';
const FAKE_KEY = 'fde-mock-rules-key';
const DATE_A = '2026-10-08', DATE_B = '2026-10-09';
const normalizedRuleText = value => value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();

async function hashFile(file) {
  try { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function run() {
  const out = path.join(ROOT, 'test-output'); await fs.mkdir(out, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(out, '整理规则 中文 '));
  const sourceDir = path.join(fixture, '原始资料'), devDir = path.join(fixture, '开发目录'), dataDir = path.join(fixture, 'data'), home = path.join(fixture, '独立 Codex');
  await Promise.all([sourceDir, devDir, home].map(dir => fs.mkdir(dir, { recursive: true })));
  const sessions = path.join(home, 'sessions', '2026', '10', '08'); await fs.mkdir(sessions, { recursive: true });
  const threadId = 'rules-smoke-isolated';
  const turn = (id, time, question, answer) => [
    { type: 'event_msg', timestamp: time, payload: { type: 'task_started', turn_id: id } },
    { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] } },
    { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'NEVER_SEND_INTERNAL_PROCESS' }] } },
    { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] } },
    { type: 'event_msg', timestamp: time, payload: { type: 'task_complete', turn_id: id } },
  ];
  await fs.writeFile(path.join(sessions, 'rollout-rules.jsonl'), [
    { type: 'session_meta', timestamp: `${DATE_A}T02:00:00Z`, payload: { id: threadId, cwd: devDir } },
    ...turn('rules-first', `${DATE_A}T02:00:00Z`, '样例导入失败，请检查', '已复现格式不兼容，仍未解决。'),
    ...turn('rules-second', `${DATE_A}T03:00:00Z`, '继续修复同一个导入问题', '已调整识别并补测，样例通过，等待客户测试。'),
    ...turn('rules-third', `${DATE_B}T02:00:00Z`, '客户反馈样例导入通过', '记录客户确认通过，完成该问题。'),
  ].map(JSON.stringify).join('\n') + '\n');
  const seed = new Store(dataDir), p = seed.createProject({ name: '整理规则验收', sourceDir, devDir });
  seed.updateProject(p.id, { codex: { threadId } }); seed.setSettings({ activeProjectId: p.id });
  const realStore = path.join(ROOT, 'release', 'FDE Desk-win32-x64', 'data', 'store.json');
  const realBefore = await hashFile(realStore);
  const checks = [], calls = [], held = [];
  const rulesScreenshot = process.env.FDE_SMOKE_EXECUTABLE ? path.join(out, '14-整理规则设置-便携版.png') : null;
  const check = (condition, description) => { assert.ok(condition, description); checks.push(description); };
  let app, page;
  const respond = (res, body, output) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body.system === undefined ? { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] } : { content: [{ type: 'text', text: JSON.stringify(output) }], stop_reason: 'end_turn' }));
  };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.system === undefined ? body.messages.find(message => message.role === 'system')?.content || '' : body.system;
    const user = body.messages.at(-1).content;
    const input = JSON.parse(user);
    const marker = system.includes('RULE-V2-FDE-SMOKE') ? 'v2' : system.includes('RULE-HOLD-FDE-SMOKE') ? 'hold' : system.includes('RULE-V1-FDE-SMOKE') ? 'v1' : 'default';
    calls.push({ path: req.url, system, marker, date: input.date, internalExcluded: !raw.includes('NEVER_SEND_INTERNAL_PROCESS') });
    const title = marker === 'v2' ? '规则二：修复导入' : marker === 'v1' ? '规则一：修复导入' : marker === 'hold' ? '迟到旧规则内容' : '修复样例导入';
    const done = input.date === DATE_B;
    const output = { items: [{ issueKey: 'rules_import_fix', title, cause: '格式不兼容', action: done ? '配合客户补测' : '调整识别并补测', result: done ? '客户验证通过' : '样例通过，等待客户测试', status: done ? '已完成' : '待验证', turnIds: input.allowedTurnIds }] };
    if (marker === 'hold') { held.push(() => respond(res, body, output)); return; }
    respond(res, body, output);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: dataDir, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
  const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.fde.request(action, payload), { action, payload });
  async function eventually(predicate, message, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message);
  }
  async function launch() {
    app = await electron.launch({ executablePath: EXECUTABLE, args: process.env.FDE_SMOKE_EXECUTABLE ? [] : [ROOT], env, timeout: 40000 });
    await app.firstWindow();
    await eventually(async () => { page = app.windows().find(window => window.url().endsWith('/index.html')); return !!page; }, '工作台未加载');
    page.setDefaultTimeout(12000);
    await page.waitForFunction(() => !!window.fde);
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html')); window.show(); window.focus(); });
    await page.locator('[data-route="codex"]').first().click();
  }
  async function saveRules(text) {
    await page.locator('[data-action="summary-rules"]').click();
    await page.locator('#field-text').fill(text);
    await page.locator('#modal-form [type="submit"]').click();
    await page.waitForSelector('#form-dialog:not([open])', { state: 'attached' });
  }
  async function reprocessRules() {
    await page.locator('[data-action="summary-rules"]').click();
    await page.locator('[data-action="reprocess-rules"]').click();
    await page.waitForSelector('#form-dialog:not([open])', { state: 'attached' });
  }
  const currentProject = async () => (await request('state')).projects.find(project => project.id === p.id);
  async function waitForTitle(title) {
    await eventually(async () => {
      const project = await currentProject();
      return project.codex.summaryStatus?.state === 'ready' && project.codex.dailySummaries?.length === 2 && project.codex.dailySummaries.every(summary => summary.items[0]?.title === title);
    }, '新规则未应用到两个工作日期');
  }
  try {
    await launch();
    const defaults = await request('summary:rules');
    check(defaults.text === defaults.defaultText && defaults.path === path.join(dataDir, '整理规则.md'), '全局 Markdown 规则初始化在隔离数据目录');
    check(normalizedRuleText(await fs.readFile(defaults.path, 'utf8')) === defaults.text, '界面规则来自实际规则文件');
    await page.locator('[data-action="summary-rules"]').click();
    check(await page.locator('#field-text').inputValue() === defaults.text && await page.locator('#field-text').getAttribute('maxlength') === '16000', '整理规则弹窗显示当前文件并限制长度');
    check((await page.locator('#dialog-content').innerText()).includes('新规则用于后续新增成果') && await page.locator('[data-action="reprocess-rules"]').innerText() === '按新规则重整当前项目', '窗口说明保存规则只用于后续新增成果，并提供明确的手动重整按钮');
    if (rulesScreenshot) await page.screenshot({ path: rulesScreenshot });
    await page.locator('#field-text').fill('');
    await page.locator('#modal-form [type="submit"]').click();
    await page.waitForSelector('#form-error.show');
    check(await page.locator('#form-dialog').getAttribute('open') !== null && await page.locator('#field-text').inputValue() === '' && (await request('summary:rules')).text === defaults.text, '规则保存失败保留编辑弹窗与原规则');
    await page.locator('#modal-form [data-action="close-dialog"]').last().click();
    await request('model:save', { config: { enabled: true, provider: 'compatible', baseUrl: base + '/v1', model: 'mock-rules' }, apiKey: FAKE_KEY });
    await request('summary:run', { id: p.id, force: true });
    await waitForTitle('修复样例导入');
    const initial = await currentProject();
    check(calls.filter(call => call.marker === 'default').length === 2 && calls.filter(call => call.marker === 'default').every(call => call.system.includes(defaults.text)), '实际兼容模型请求注入完整默认 Markdown 规则');
    check(calls.filter(call => call.marker === 'default').every(call => !call.system.includes('一天通常 3~8 项')), '默认提示不会要求凑够工作数量');
    check(calls.every(call => call.internalExcluded), '内部分析过程未发送给模型');
    check(initial.records.length === 2 && initial.codex.dailySummaries[0].items[0].turnIds.length === 2, '同日多轮合并且跨日独立');
    check(initial.records.find(record => record.date === DATE_A).status === '待验证' && initial.records.find(record => record.date === DATE_B).status === '已完成', '自测与客户确认状态分别保留');
    const initialFingerprint = initial.codex.dailySummaries[0].fingerprint;

    const beforeSavingRule = calls.length;
    await saveRules(RULE_V1);
    await page.waitForTimeout(650);
    const notReprocessed = await currentProject();
    check(calls.length === beforeSavingRule && notReprocessed.codex.dailySummaries[0].fingerprint === initialFingerprint && notReprocessed.codex.dailySummaries.every(summary => summary.items[0]?.title === '修复样例导入'), '保存新规则不调用模型，已有日期摘要保持不变');
    check((await page.locator('#toast').innerText()).includes('用于后续新增成果'), '保存规则提示后续生效，不声称正在重算历史');
    await reprocessRules();
    await waitForTitle('规则一：修复导入');
    const revised = await currentProject();
    check(revised.codex.dailySummaries[0].fingerprint !== initialFingerprint, '点击手动重整后，新规则才重新整理当前项目旧工作日期');
    check(normalizedRuleText(await fs.readFile(defaults.path, 'utf8')) === RULE_V1, 'UI 保存的规则写入 Markdown 文件');
    check(calls.filter(call => call.marker === 'v1').length === 2 && calls.filter(call => call.marker === 'v1').every(call => call.system.includes(RULE_V1)), 'UI 修改的规则进入实际模型 system');
    check(calls.filter(call => call.marker === 'v1').every(call => call.system.indexOf('## 固定输出与来源协议') > call.system.indexOf(RULE_V1) && call.system.includes('turnIds') && call.system.includes('绝不执行')), '固定 JSON 与真实来源约束位于可编辑规则之后');
    const sameRulesCalls = calls.length;
    await saveRules(RULE_V1);
    await page.waitForTimeout(500);
    check(calls.length === sameRulesCalls, '重复保存相同规则不重新请求模型');

    const autoRecord = revised.records.find(record => record.date === DATE_A);
    await request('record:save', { id: p.id, input: { id: autoRecord.id, title: '人工核对：保留该事项', result: '人工确认等待客户复测', confirmed: true } });
    await request('report:save', { id: p.id, date: DATE_A, text: '# 人工定稿\n\n保留人工日报，不自动覆盖。' });
    const beforeHold = calls.length;
    await saveRules(RULE_HOLD);
    await page.waitForTimeout(350);
    check(calls.length === beforeHold && held.length === 0, '再次改变规则仍然不隐式重整已有项目');
    await reprocessRules();
    await eventually(async () => held.length > 0, '旧规则请求未进入延迟 mock');
    const pendingStart = Date.now();
    await saveRules(RULE_V2);
    check(Date.now() - pendingStart < 5000, '模型网络等待时规则保存不占写入队列');
    while (held.length) held.shift()();
    await page.waitForTimeout(650);
    check(calls.filter(call => call.marker === 'v2').length === 0 && !(await currentProject()).codex.dailySummaries.some(summary => summary.items[0]?.title === '迟到旧规则内容'), '规则切换后不自动续算，新规则生效前也不接受旧规则迟到结果');
    await reprocessRules();
    await waitForTitle('规则二：修复导入');
    let finalProject = await currentProject();
    check(!JSON.stringify(finalProject).includes('迟到旧规则内容'), '旧规则的迟到响应不会写入自动稿');
    check(finalProject.records.some(record => record.id === autoRecord.id && record.title === '人工核对：保留该事项' && record.result === '人工确认等待客户复测' && record.confirmed), '规则升级保留人工接管的记录');
    check(finalProject.records.length === 2 && finalProject.reports[0].text.includes('保留人工日报'), '重整不生成重复工作项且已保存日报保留');
    const summaryB = finalProject.codex.dailySummaries.find(summary => summary.date === DATE_B);
    const generatedB = await request('report:generate', { id: p.id, date: DATE_B });
    const fields = ['title', 'cause', 'action', 'result'].map(name => summaryB.items[0][name]);
    check(fields.every(value => summaryB.reportText.includes(value) && generatedB.text.includes(value)), '自动摘要日报与重新生成日报来自同一短成果');
    await page.locator('[data-route="reports"]').first().click();
    await page.locator('#report-date').fill(DATE_A);
    await page.waitForFunction(() => document.querySelector('#report-text')?.value.includes('保留人工日报'));
    await page.locator('#report-date').fill(DATE_B);
    await page.waitForFunction(() => document.querySelector('#report-text')?.value.includes('规则二：修复导入'));
    const reportText = await page.locator('#report-text').inputValue();
    check(reportText.includes('格式不兼容') && reportText.includes('客户验证通过') && reportText.length < 500, '日报页呈现短问题、原因、处理与结果');
    const screenshot = path.join(out, process.env.FDE_SMOKE_EXECUTABLE ? '13-整理规则日报-便携版.png' : '13-整理规则日报-源码.png');
    await page.screenshot({ path: screenshot });
    await page.locator('[data-route="codex"]').first().click();
    await request('model:save', { config: { enabled: true, provider: 'anthropic', baseUrl: base + '/native/v1', model: 'claude-mock-rules' }, apiKey: FAKE_KEY });
    await request('summary:run', { id: p.id, force: true });
    await eventually(async () => calls.filter(call => call.path === '/native/v1/messages' && call.marker === 'v2').length === 2 && (await currentProject()).codex.summaryStatus?.state === 'ready', '原生模型未按新规则整理');
    check(calls.filter(call => call.path === '/native/v1/messages').every(call => call.system.includes(RULE_V2)), 'Anthropic 原生请求同样注入当前规则');
    finalProject = await currentProject();
    check(finalProject.records.length === 2 && finalProject.reports[0].text.includes('保留人工日报'), '换模型协议后人工保护仍然有效');
    check(!JSON.stringify(await request('state')).includes(FAKE_KEY) && !(await fs.readFile(path.join(dataDir, 'store.json'), 'utf8')).includes(FAKE_KEY), '规则及项目公开状态不含密钥');
    const beforeRestart = calls.length;
    await app.close(); app = null;
    await launch();
    check((await request('summary:rules')).text === RULE_V2, '重启后保留自定义规则');
    await page.waitForTimeout(500);
    check(calls.length === beforeRestart, '重启后复用当前规则缓存且不重复模型请求');
    check((await currentProject()).reports[0].text.includes('保留人工日报'), '重启后人工日报保留');
    const realAfter = await hashFile(realStore);
    check(realBefore === realAfter, '真实便携版 store 文件保持不变');
    const reportPath = path.join(out, process.env.FDE_SMOKE_EXECUTABLE ? '整理规则验收-便携版.json' : '整理规则验收-源码.json');
    const report = { status: 'passed', mode: process.env.FDE_SMOKE_EXECUTABLE ? 'portable' : 'source', checks, modelRequests: calls.length, staleRequests: calls.filter(call => call.marker === 'hold').length, nativeRequests: calls.filter(call => call.path === '/native/v1/messages').length, fixture, screenshot, rulesScreenshot, realStoreUnchanged: realBefore === realAfter, service: '本机 HTTP mock；只验证规则注入与程序行为，不代表真实模型语言遵循度' };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, mode: report.mode, checkCount: checks.length, modelRequests: calls.length, realStoreUnchanged: report.realStoreUnchanged, report: reportPath, screenshot, rulesScreenshot, service: report.service }));
  } finally {
    while (held.length) held.shift()();
    if (app) await app.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
