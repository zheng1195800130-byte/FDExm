'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');
const ROOT = path.resolve(__dirname, '..');
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');
async function run() {
  const out = path.join(ROOT, 'test-output'); await fs.mkdir(out, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(out, '自动整理-'));
  const sourceDir = path.join(fixture, '原始资料'), devDir = path.join(fixture, '开发目录'), dataDir = path.join(fixture, 'data');
  await fs.mkdir(sourceDir); await fs.mkdir(devDir);
  const home = path.join(fixture, 'codex'), sessions = path.join(home, 'sessions/2026/10/08'); await fs.mkdir(sessions, { recursive: true });
  const threadId = 'summary-e2e', rollout = path.join(sessions, 'rollout-summary.jsonl');
  const turns = (id, time, question, answer) => [
    { type: 'event_msg', timestamp: time, payload: { type: 'task_started', turn_id: id } },
    { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] } },
    { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: '绝不能发送的工具和内部过程' }] } },
    { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] } },
    { type: 'event_msg', timestamp: time, payload: { type: 'task_complete', turn_id: id } }
  ];
  await fs.writeFile(rollout, [
    { type: 'session_meta', timestamp: '2026-10-08T02:00:00Z', payload: { id: threadId, cwd: devDir } },
    ...turns('first', '2026-10-08T02:00:00Z', '导入失败，请检查', '发现格式不兼容，调整后样例通过，等待客户测试。'),
    ...turns('second', '2026-10-08T03:00:00Z', '还有一个样例失败', '继续调整识别规则，第二个样例也通过。'),
    ...turns('third', '2026-10-09T02:00:00Z', '客户反馈导入成功', '记录客户测试通过，完成本次导入修复。')
  ].map(JSON.stringify).join('\n') + '\n');
  const seed = new Store(dataDir); const p = seed.createProject({ name: '自动整理测试', sourceDir, devDir });
  seed.updateProject(p.id, { codex: { threadId } }); seed.setSettings({ activeProjectId: p.id });
  let calls = 0, app, remoteError = false; const payloads = [], requests = [];
  async function eventually(check, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('自动整理状态未在预期时间内更新');
  }
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls++; payloads.push(raw);
    const authenticated = req.headers.authorization === 'Bearer secret-e2e';
    requests.push({ path: req.url, authenticated });
    if (!authenticated) { res.writeHead(401); res.end('authentication required'); return; }
    if (remoteError) { res.writeHead(503); res.end('Do not echo bearer secret-e2e'); return; }
    const body = JSON.parse(raw), user = body.messages.at(-1).content;
    let output = { ok: true };
    if (user.startsWith('{')) {
      const input = JSON.parse(user), done = input.date === '2026-10-09';
      output = { items: [{ issueKey: 'import-fix', title: '修复客户表格导入', cause: '格式不兼容', action: done ? '配合客户完成测试' : '调整识别并验证两个样例', result: done ? '客户验证通过' : '样例通过，等待客户测试', status: done ? '已完成' : '待验证', turnIds: input.allowedTurnIds }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { enabled: true, provider: 'compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock-summary' };
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: dataDir, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
  async function launch() {
    app = await electron.launch({ executablePath: EXECUTABLE, args: process.env.FDE_SMOKE_EXECUTABLE ? [] : [ROOT], env, timeout: 40000 });
    await app.firstWindow();
    const page = app.windows().find(w => w.url().endsWith('index.html')) || await app.firstWindow();
    await page.waitForFunction(() => !!window.fde);
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html')); w.show(); w.focus(); });
    return page;
  }
  try {
    let page = await launch();
    const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.fde.request(action, payload), { action, payload });
    await page.locator('[data-route="codex"]').first().click();
    await page.locator('[data-action="model-settings"]').click();
    await page.locator('#field-provider').selectOption('compatible');
    await page.locator('#field-baseUrl').fill(config.baseUrl);
    await page.locator('#field-model').fill(config.model);
    await page.locator('#field-apiKey').fill('secret-e2e');
    await page.locator('[data-action="test-model"]').click();
    await page.waitForFunction(() => document.querySelector('#model-key-status')?.textContent.includes('连接成功'));
    assert.equal(await page.locator('#field-apiKey').inputValue(), '', '测试后密钥字段清空');
    const testedCalls = calls;
    await page.locator('#field-baseUrl').fill(config.baseUrl + '/different');
    await page.locator('[data-action="test-model"]').click();
    await page.waitForSelector('#form-error.show');
    assert.equal(calls, testedCalls + 1, '本机端点允许无密钥尝试');
    assert.equal(requests.at(-1).authenticated, false, '端点变化不能复用暂存密钥');
    await page.locator('#field-baseUrl').fill(config.baseUrl);
    await page.locator('#field-apiKey').fill('secret-e2e');
    await page.locator('[data-action="test-model"]').click();
    await page.waitForFunction(() => document.querySelector('#model-key-status')?.textContent.includes('连接成功'));
    await page.screenshot({ path: path.join(out, '11-模型设置.png') });
    await page.locator('#form-dialog button[type="submit"]').click();
    await page.waitForSelector('#form-dialog:not([open])', { state: 'attached' });
    await page.locator('[data-route="overview"]').first().click();
    await eventually(async () => (await request('state')).projects[0].codex.dailySummaries?.filter(s => s.method === 'model').length === 2);
    let state = await request('state'), project = state.projects[0];
    assert.equal(project.records.length, 2, '同日两轮合成一项；跨日两项');
    assert.equal(project.codex.dailySummaries[0].items[0].turnIds.length, 2);
    assert.equal(project.codex.dailySummaries[1].items[0].status, '已完成');
    assert.doesNotMatch(JSON.stringify(state), /secret-e2e/);
    assert.doesNotMatch(await fs.readFile(path.join(dataDir, 'store.json'), 'utf8'), /secret-e2e/);
    assert.ok(!(await fs.readFile(path.join(dataDir, 'model-key.encrypted'))).includes(Buffer.from('secret-e2e')));
    assert.ok(payloads.every(raw => !raw.includes('绝不能发送')), '分析过程没有发往模型');
    const report = await request('report:generate', { id: p.id, date: '2026-10-08' });
    assert.match(report.text, /两个样例/); assert.doesNotMatch(report.text, /客户验证通过/);
    await request('report:save', { id: p.id, date: '2026-10-08', text: '人工编辑保留的日报' });
    await page.locator('[data-route="codex"]').first().click();
    await page.locator('#codex-date').fill('2026-10-08');
    await page.waitForSelector('.summary-card');
    assert.equal(await page.locator('.summary-card').count(), 1);
    assert.equal(await page.locator('#codex-original').getAttribute('open'), null);
    await page.waitForFunction(() => !document.body.innerText.includes('还有一个样例失败'));
    await page.screenshot({ path: path.join(out, '10-按日自动整理.png') });
    // Continue in the same thread while a different page is open.
    await page.locator('[data-route="overview"]').first().click();
    const before = calls;
    await fs.appendFile(rollout, turns('fourth', '2026-10-09T03:00:00Z', '增加了一次补测', '补测通过，维持已完成。').map(JSON.stringify).join('\n') + '\n');
    await eventually(async () => (await request('state')).projects[0].codex.dailySummaries.find(s => s.date === '2026-10-09')?.items[0]?.turnIds.includes('fourth'));
    assert.equal(calls, before + 1, '仅重新整理变化的日期');
    const savedFingerprint = (await request('state')).projects[0].codex.dailySummaries.find(s => s.date === '2026-10-09').fingerprint;
    remoteError = true;
    await request('summary:run', { id: p.id, force: true });
    await eventually(async () => (await request('state')).projects[0].codex.summaryStatus?.state === 'error');
    project = (await request('state')).projects[0];
    assert.equal(project.codex.dailySummaries.find(s => s.date === '2026-10-09').fingerprint, savedFingerprint);
    assert.equal(project.reports[0].text, '人工编辑保留的日报');
    assert.doesNotMatch(project.codex.summaryStatus.message, /secret-e2e|bearer/);
    remoteError = false; const beforeRestart = calls;
    await app.close(); app = null; page = await launch();
    await page.waitForTimeout(1000);
    state = await request('state'); assert.equal(state.modelSettings.keyConfigured, true);
    assert.equal(calls, beforeRestart, '重启不重复已整理请求');
    assert.equal(state.projects[0].reports[0].text, '人工编辑保留的日报');
    console.log('自动整理桌面验收通过：后台收录、同日合并/跨日独立、变化增量更新、日报草稿、人工保护、DPAPI密钥、模型失败保留、重启不重复。模型服务使用本地 mock，未调用真实 DeepSeek。');
  } finally { if (app) await app.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
