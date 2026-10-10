'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const ROOT = path.resolve(__dirname, '..');
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');
const LAUNCH_ARGS = process.env.FDE_SMOKE_EXECUTABLE ? [] : [ROOT];
const SKIP_CLIPBOARD = process.env.FDE_TEST_SKIP_CLIPBOARD === '1';
async function run() {
  const out = path.join(ROOT, 'test-output');
  await fs.mkdir(out, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(out, 'e2e-'));
  const sourceDir = path.join(fixture, '原始资料');
  const devDir = path.join(fixture, '开发项目');
  const codexHome = path.join(fixture, 'codex-home');
  await fs.mkdir(sourceDir, { recursive: true }); await fs.mkdir(devDir, { recursive: true });
  const original = path.join(sourceDir, '客户业务说明.md');
  await fs.writeFile(original, '# 客户业务说明\n\n业务人员需要导入客户表格，按地区筛选。重复客户的处理规则待确认。');
  await fs.writeFile(path.join(devDir, '需求分析.md'), '# 需求分析\n需要确认重复客户是否覆盖。');
  const hashBefore = createHash('sha256').update(await fs.readFile(original)).digest('hex');
  const sessions = path.join(codexHome, 'sessions/2026/10/08'); await fs.mkdir(sessions, { recursive: true });
  const threadId = 'test-fde-thread-01';
  const rollout = path.join(sessions, 'rollout-2026-10-08-test.jsonl');
  const lines = [
    { type: 'session_meta', timestamp: '2026-10-08T01:00:00Z', payload: { id: threadId, cwd: devDir } },
    { type: 'event_msg', timestamp: '2026-10-08T01:00:01Z', payload: { type: 'task_started', turn_id: 'turn-one' } },
    { type: 'response_item', timestamp: '2026-10-08T01:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '客户表格导入失败，请修复。' }] } },
    { type: 'response_item', timestamp: '2026-10-08T01:00:03Z', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: '不应进入收录候选的内部思考' }] } },
    { type: 'response_item', timestamp: '2026-10-08T01:00:04Z', payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: '问题：客户表格导入失败\n原因：字段名称不一致\n处理：调整字段识别\n结果：样例测试通过，待客户验证' }] } },
    { type: 'event_msg', timestamp: '2026-10-08T01:00:05Z', payload: { type: 'task_complete', turn_id: 'turn-one' } }
  ];
  await fs.writeFile(rollout, lines.map(JSON.stringify).join('\n') + '\n');
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: path.join(fixture, 'data'), CODEX_HOME: codexHome };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const errors = [];
  try {
    app = await electron.launch({ executablePath: EXECUTABLE, args: LAUNCH_ARGS, env, timeout: 40000 });
    await app.firstWindow();
    const pages = await Promise.all(app.windows().map(async candidate => {
      try { await candidate.waitForURL('**/index.html', { timeout: 5000 }); return candidate; } catch { return null; }
    }));
    const page = pages.find(Boolean);
    assert.ok(page, '主工作台窗口已加载');
    await app.evaluate(({ BrowserWindow }) => {
      const workbench = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html'));
      workbench.show(); workbench.focus();
    });
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => !!window.fde);
    await page.waitForSelector('[data-action="new-project"]').catch(async error => {
      await page.screenshot({ path: path.join(out, '启动错误.png') });
      console.log(await page.locator('body').innerText());
      throw error;
    });
    await page.screenshot({ path: path.join(out, '01-首次启动.png') });
    const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.fde.request(action, payload), { action, payload });
    // Submit the real project form instead of seeding a fake rendered state.
    await page.locator('[data-action="new-project"]').click();
    await page.locator('[name="name"]').fill('端到端验证项目');
    await page.locator('[name="sourceDir"]').fill(sourceDir);
    await page.locator('[name="devDir"]').fill(devDir);
    await page.locator('#form-dialog button[type="submit"]').click();
    await page.waitForSelector('#form-dialog:not([open])', { state: 'attached' });
    const state = await request('state');
    const p = state.projects[0]; assert.ok(p); assert.equal(state.settings.activeProjectId, p.id);
    assert.equal(p.files.filter(f => f.kind === '原始资料').length, 1);
    const source = p.files.find(f => f.kind === '原始资料');
    assert.match((await request('file:preview', { id: p.id, fileId: source.id })).text, /重复客户/);
    await page.screenshot({ path: path.join(out, '02-项目概览.png') });
    await page.locator('[data-route="files"]').first().click();
    await page.locator('#file-search').fill('重复客户');
    await page.waitForSelector('[data-action="preview-file"]');
    await page.locator('[data-action="preview-file"]').first().click();
    await page.waitForSelector('#preview-dialog[open]');
    assert.match(await page.locator('#preview-content').innerText(), /重复客户/);
    await page.keyboard.press('Escape');
    if (!SKIP_CLIPBOARD) {
    await request('file:copy-path', { id: p.id, fileId: source.id });
    assert.equal(await app.evaluate(async ({ clipboard }) => await clipboard.readText()), original);
    await request('file:copy', { id: p.id, fileId: source.id });
    const nativeDrop = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
    assert.ok(nativeDrop.stdout.includes('客户业务说明.md'), 'Windows 文件剪贴板包含真实文件');
    }
    await request('file:paste', { id: p.id, text: '客户补充：重复记录先保留，再人工核对。', description: '重复客户处理规则' });
    if (!SKIP_CLIPBOARD) {
    await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, iconPath) => {
      const png = nativeImage.createFromPath(iconPath).toPNG();
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    }, path.join(ROOT, 'assets/icon.png'));
    const withMedia = await request('file:paste', { id: p.id, description: '截图收录测试' });
    const media = withMedia.files.find(f => f.description === '截图收录测试');
    assert.ok(media); assert.equal((await request('file:preview', { id: p.id, fileId: media.id })).type, 'image');
    }
    await request('requirement:save', { id: p.id, input: { title: '导入客户表格', description: '支持导入并按地区筛选', status: '已明确', sourceRef: original } });
    await request('record:save', { id: p.id, input: { issueKey: 'BUG-001', date: '2026-10-08', title: '修复表格导入', cause: '字段名称不一致', action: '调整识别', result: '样例通过，待客户验证', status: '待验证', confirmed: true } });
    await request('record:save', { id: p.id, input: { issueKey: 'BUG-001', date: '2026-10-09', title: '修复表格导入', action: '客户实际测试', result: '客户验证通过', status: '已完成', confirmed: true } });
    await request('record:save', { id: p.id, input: { date: '2026-10-08', title: '未确认内容', result: '不应出现在日报', status: '已完成', confirmed: false } });
    const report = await request('report:generate', { id: p.id, date: '2026-10-08' });
    assert.match(report.text, /样例通过/); assert.doesNotMatch(report.text, /客户验证通过|不应出现在日报/);
    await request('report:save', { id: p.id, date: report.date, text: report.text });
    await request('project:update', { id: p.id, patch: { stage: '客户测试', nextAction: '等待客户验证导入', blocker: '客户测试反馈' } });
    const { threads } = await request('codex:list', { id: p.id }); assert.equal(threads.length, 1);
    await request('codex:bind', { id: p.id, threadId });
    const session = await request('codex:read', { id: p.id });
    assert.ok(session.turns.length); assert.ok(session.turns.some(t => t.assistantText.includes('字段名称')));
    assert.ok(session.turns.every(t => !t.assistantText.includes('内部思考')));
    await page.locator('[data-route="codex"]').first().click();
    await page.locator('#codex-date').fill('2026-10-08');
    await page.waitForSelector('[data-action="edit-summary-record"]');
    assert.equal(await page.locator('#codex-original').getAttribute('open'), null, '默认不展开原始会话');
    await page.screenshot({ path: path.join(out, '06-Codex有效摘要.png') });
    await page.locator('[data-action="edit-summary-record"]').first().click();
    assert.equal(await page.locator('[name="confirmed"]').isChecked(), false, 'Codex 候选默认待确认');
    await page.locator('[name="issueKey"]').fill('BUG-CODEX-02');
    await page.locator('#form-dialog button[type="submit"]').click();
    await page.waitForSelector('#form-dialog:not([open])', { state: 'attached' });
    const captured = (await request('state')).projects[0].records.find(r => r.issueKey === 'BUG-CODEX-02');
    assert.ok(captured); assert.equal(captured.confirmed, false);
    await page.locator('[data-route="requirements"]').first().click();
    if (!SKIP_CLIPBOARD) {
    await page.locator('[data-action="copy-requirements"]').click();
    assert.match(await app.evaluate(async ({ clipboard }) => await clipboard.readText()), /导入客户表格/);
    }
    await page.locator('[data-route="records"]').first().click();
    await page.screenshot({ path: path.join(out, '07-跨天工作记录.png') });
    await page.locator('[data-route="reports"]').first().click();
    await page.waitForSelector('#report-preview');
    // The fixture deliberately spans two days. Select its saved historical
    // report explicitly instead of assuming the real current date is Oct 8.
    await page.locator('#report-date').fill(report.date);
    await page.waitForFunction(() => document.querySelector('#report-text')?.value.includes('样例通过'));
    assert.match(await page.locator('#report-text').inputValue(), /样例通过/);
    await page.screenshot({ path: path.join(out, '03-标准日报.png'), timeout: 60000 });
    // A completed live append is summarized in the background on a new day.
    await page.evaluate(() => {
      window.__codexUpdated = false;
      window.fde.onChange(value => { if (value?.codexUpdated) window.__codexUpdated = true; });
    });
    await fs.appendFile(rollout, [
      { type: 'event_msg', timestamp: '2026-10-09T02:00:00Z', payload: { type: 'task_started', turn_id: 'turn-two' } },
      { type: 'response_item', timestamp: '2026-10-09T02:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '补充测试进展。' }] } },
      { type: 'response_item', timestamp: '2026-10-09T02:00:02Z', payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: '问题：监看追加验证\n原因：需等待客户安排测试\n处理：整理补充进展\n结果：继续等待客户测试反馈。' }] } },
      { type: 'event_msg', timestamp: '2026-10-09T02:00:03Z', payload: { type: 'task_complete', turn_id: 'turn-two' } }
    ].map(JSON.stringify).join('\n') + '\n');
    await page.waitForFunction(() => window.__codexUpdated, null, { timeout: 15000 });
    const deadline = Date.now() + 12000;
    let updated;
    while (Date.now() < deadline) {
      updated = (await request('state')).projects[0].records.find(r => r.title === '监看追加验证');
      if (updated) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(updated); assert.equal(updated.date, '2026-10-09'); assert.equal(updated.confirmed, false);
    assert.ok((await request('codex:read', { id: p.id })).turns.some(t => t.assistantText.includes('监看追加验证')));
    await request('window:compact');
    const ballPage = app.windows().find(w => w.url().endsWith('ball.html'));
    const panelPage = app.windows().find(w => w.url().endsWith('float.html'));
    assert.ok(ballPage && panelPage);
    await request('window:panel');
    await panelPage.waitForFunction(() => document.body.innerText.includes('端到端验证项目'));
    await panelPage.screenshot({ path: path.join(out, '04-悬浮资料框.png') });
    await request('window:ball');
    await ballPage.screenshot({ path: path.join(out, '05-悬浮球.png') });
    await request('window:workbench');
    assert.equal(createHash('sha256').update(await fs.readFile(original)).digest('hex'), hashBefore);
    assert.deepEqual(errors, [], 'renderer 没有运行时异常');
    const final = await request('state');
    assert.equal(final.projects[0].reports.length, 1);
    console.log('桌面端验证通过：项目表单、资料检索/预览、文字收录、跨天日报、Codex后台整理、悬浮框/球、原始资料保持不变。');
    console.log(SKIP_CLIPBOARD ? '剪贴板相关检查因本机 Windows 拒绝访问而显式跳过：路径/文件/需求复制、剪贴板截图收录，本次不计为通过。' : '路径与原生文件复制、需求复制、剪贴板截图收录均通过。');
    console.log(`截图：${out}`);
    await app.close(); app = null;
    const restart = await electron.launch({ executablePath: EXECUTABLE, args: LAUNCH_ARGS, env, timeout: 40000 });
    app = restart; await app.firstWindow(); const reopened = app.windows().find(w => w.url().endsWith('index.html')) || await app.firstWindow(); await reopened.waitForFunction(() => !!window.fde);
    const persisted = await reopened.evaluate(() => window.fde.request('state'));
    assert.equal(persisted.projects[0].name, '端到端验证项目'); assert.equal(persisted.projects[0].reports[0].text.trim(), report.text.trim());
    console.log('重启持久化验证通过。');
  } finally { if (app) await app.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
