'use strict';
// Read the selected real project and current conversation; all edits stay in
// a disposable management-data copy under test-output.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const REAL_STORE = path.join(require('../desktop/data-location.cjs').resolveDataDirectory(), 'store.json');
const THREAD_ID = process.env.FDE_AUDIT_THREAD_ID;
if (!THREAD_ID || !process.env.FDE_AUDIT_PROJECT_ID) throw new Error('请设置 FDE_AUDIT_THREAD_ID 和 FDE_AUDIT_PROJECT_ID 后进行只读项目审计');
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');
const canonical = value => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
const counts = p => ({ files: p.files.length, requirements: p.requirements.length, records: p.records.length, reports: p.reports.length });
const sha = value => createHash('sha256').update(value).digest('hex');
const projectFrom = data => data.projects.find(p => p.id === process.env.FDE_AUDIT_PROJECT_ID);
const nextDay = day => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const mediaPaths = turn => {
  const direct = (turn.attachments || []).filter(item => item.path).map(item => item.path);
  const text = turn.userText.match(/[A-Za-z]:[\\/][^\r\n<>"`]+?\.(?:png|jpe?g|gif|webp)/gi) || [];
  return [...new Set([...direct, ...text])];
};

async function run() {
  const out = path.join(ROOT, 'test-output');
  await fs.mkdir(out, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(out, '真实项目验收-'));
  const dataDir = path.join(fixture, 'data');
  await fs.mkdir(dataDir);
  const beforeBytes = await fs.readFile(REAL_STORE);
  const originalState = JSON.parse(beforeBytes);
  const original = projectFrom(originalState);
  assert.ok(original, '找到已建立的 FDE 项目，不访问其他项目正文');
  const originalCounts = counts(original);
  const copied = JSON.parse(JSON.stringify(original));
  await fs.writeFile(path.join(dataDir, 'store.json'), JSON.stringify({ version: originalState.version, settings: { activeProjectId: copied.id }, projects: [copied] }));
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: dataDir, CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), '.codex') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, page, panel;
  const rendererErrors = [];
  const checks = [];
  let report;
  async function launch() {
    app = await electron.launch({ executablePath: EXECUTABLE, args: process.env.FDE_SMOKE_EXECUTABLE ? [] : [ROOT], env, timeout: 40000 });
    await app.firstWindow();
    const deadline = Date.now() + 12000;
    while ((!page || !panel) && Date.now() < deadline) {
      page = app.windows().find(w => w.url().endsWith('/index.html'));
      panel = app.windows().find(w => w.url().endsWith('/float.html'));
      if (!page || !panel) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(page && panel, '工作台和悬浮资料框已加载');
    page.setDefaultTimeout(20000); panel.setDefaultTimeout(20000);
    for (const window of [page, panel]) window.on('pageerror', error => rendererErrors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
      main.show(); main.focus();
    });
    await page.waitForSelector('[data-action="edit-project"]');
  }
  const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.fde.request(action, payload), { action, payload });
  const current = async () => (await request('state')).projects.find(p => p.id === copied.id);
  const protectedCounts = p => ({ requirements: p.requirements.length, manualOrConfirmedRecords: p.records.filter(record => record.manual || record.confirmed).length, reports: p.reports.length });
  async function settleSummary() {
    const before = (await current()).codex.summaryStatus?.updatedAt || '';
    await request('summary:run', { id: copied.id, force: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const p = await current();
      const status = p.codex.summaryStatus;
      if (status?.state === 'ready') return p;
      if (status?.updatedAt !== before && status?.state === 'error') throw new Error('隔离副本的本地自动整理失败');
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error('隔离副本的自动整理未在预期时间内结束');
  }
  try {
    await launch();
    await page.locator('[data-action="edit-project"]').click();
    await page.locator('[name="artifactDir"]').fill(ROOT);
    assert.equal(await page.locator('[name="sourceDir"]').inputValue(), original.sourceDir);
    assert.equal(await page.locator('[name="devDir"]').inputValue(), original.devDir);
    await page.locator('#form-dialog [type="submit"]').click();
    await page.waitForSelector('#form-dialog:not([open])', { state: 'attached' });
    let p = await current();
    assert.equal(canonical(p.artifactDir), canonical(ROOT));
    assert.equal(canonical(p.devDir), canonical(original.devDir));
    assert.equal(canonical(p.sourceDir), canonical(original.sourceDir));
    const artifacts = p.files.filter(file => file.kind === '开发成果');
    assert.ok(artifacts.length, '存在开发成果索引');
    const noise = file => {
      const relative = path.relative(ROOT, file.path);
      const parts = relative.split(/[\\/]+/);
      return relative.startsWith('..') || path.isAbsolute(relative)
        || parts.some(part => /^(?:test-output|release|\.fde-build|\.pack-tmp|\.tmp)$/i.test(part))
        || /\.log$/i.test(file.path) || /^store(?:\.[^.]+)*\.json$/i.test(path.basename(file.path))
        || /(?:^|[\\/])YaNeng(?:[\\/]|$)/i.test(file.path);
    };
    assert.equal(artifacts.filter(noise).length, 0, '开发索引只限成果目录，并已清除旧噪声');
    assert.equal(p.files.filter(file => /(?:^|[\\/])YaNeng(?:[\\/]|$)/i.test(file.path)).length, 0);
    checks.push('编辑真实项目副本，成果关注目录与 Codex 开发目录分离；新旧索引噪声均已排除');

    const { threads } = await request('codex:list', { id: p.id });
    assert.ok(threads.some(thread => thread.id === THREAD_ID), '当前真实会话可关联');
    await request('codex:bind', { id: p.id, threadId: THREAD_ID });
    const beforeRead = protectedCounts(await current());
    const read = await request('codex:read', { id: p.id });
    const afterRead = protectedCounts(await current());
    assert.deepEqual(afterRead, beforeRead, '读取或后台整理不会擅自增加已人工确认的工作、需求或定稿日报');
    const summarized = await settleSummary();
    assert.deepEqual(protectedCounts(summarized), beforeRead, '后台自动稿不会擅自升级为人工确认记录');
    assert.ok(summarized.records.filter(record => record.managedBy === 'codex-auto').every(record => record.confirmed === false));
    const versionTurns = read.turns.filter(turn => /0\.1\.1/.test(turn.assistantText) && /修复|目录|页面/.test(turn.assistantText));
    assert.ok(versionTurns.length, '保留 0.1.1 真实修复答复');
    const fixTurn = versionTurns.find(turn => mediaPaths(turn).length || turn.attachments?.length) || versionTurns[0];
    const attachmentTurn = read.turns.find(turn => mediaPaths(turn).some(value => value.includes('codex-clipboard-98b5ec0c-8f40-402c-8669-8d8545d767ad')))
      || read.turns.find(turn => mediaPaths(turn).length) || fixTurn;
    const retainedMedia = mediaPaths(attachmentTurn);
    assert.ok(retainedMedia.length || read.turns.some(turn => turn.attachments?.length), '保留用户图片路径或媒体引用');
    checks.push('真实当前会话可列出、关联、读取；保留修复结果和图片引用，后台整理只生成待核对草稿');

    await app.evaluate(({ shell }) => {
      globalThis.__fdeRevealAudit = [];
      shell.showItemInFolder = filePath => { globalThis.__fdeRevealAudit.push(filePath); };
    });
    await request('window:panel');
    await panel.waitForSelector('[data-action="reveal"]');
    const reveal = panel.locator('[data-action="reveal"]').first();
    const fileId = await reveal.getAttribute('data-file');
    const target = (await current()).files.find(file => file.id === fileId);
    assert.ok(target);
    await reveal.click();
    await panel.waitForFunction(() => document.getElementById('toast').textContent === '已打开文件所在目录');
    assert.notEqual(await panel.locator('#toast').innerText(), '路径已复制');
    assert.deepEqual(await app.evaluate(() => globalThis.__fdeRevealAudit), [target.path]);
    const overflow = [];
    for (const width of [430, 380]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/float.html'));
        // The production floating window is intentionally fixed-size. Enable
        // host-side resizing only in the audit to exercise its 380px layout.
        win.setResizable(true); win.setContentSize(width, 620); win.show(); win.focus();
      }, width);
      await panel.waitForFunction(expected => Math.abs(window.innerWidth - expected) <= 1, width).catch(async () => {
        const actual = await panel.evaluate(() => ({ innerWidth, outerWidth, devicePixelRatio }));
        throw new Error(`悬浮框验收宽度未生效：${JSON.stringify({ requested: width, ...actual })}`);
      });
      const measured = await panel.evaluate(() => ({ width: window.innerWidth, horizontal: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth, filesHorizontal: document.getElementById('float-files').scrollWidth - document.getElementById('float-files').clientWidth }));
      assert.ok(measured.horizontal <= 1 && measured.filesHorizontal <= 1, '悬浮框无横向溢出');
      overflow.push(measured);
      await panel.screenshot({ path: path.join(out, width === 430 ? '08-真实项目悬浮框.png' : '09-真实项目悬浮框-380.png') });
    }
    checks.push('悬浮框真实点击打开目录，调用路径正确；系统资源管理器调用已 mock，430/380 宽均无横向溢出');
    await request('window:workbench');

    const input = {
      date: fixTurn.date, issueKey: 'FDE-0.1.1-目录选择修复', title: '修复选择项目目录时的页面来源报错',
      cause: '首页链接改变页面锚点，来源校验将正常页面拒绝。',
      action: '修正页面来源校验和首页导航，补充目录选择回归验证。',
      result: '0.1.1 已验证目录选择与项目保存正常。', status: '已完成', confirmed: false,
      sourceRef: fixTurn.sourceRef, origin: { threadId: THREAD_ID, turnId: fixTurn.id },
      attachments: retainedMedia.map(value => ({ path: value, name: path.basename(value), description: '用户报告目录选择失败时提供的原会话截图引用；未复制或读取媒体内容。' }))
    };
    const recordsBeforeManual = (await current()).records;
    const baselineRecords = recordsBeforeManual.length;
    const matchingAuto = recordsBeforeManual.find(record => record.managedBy === 'codex-auto' && record.date === input.date && [record.origin, ...(record.originRefs || [])].some(origin => origin?.threadId === THREAD_ID && origin?.turnId === fixTurn.id));
    let changed = await request('record:save', { id: p.id, input: { ...input, ...(matchingAuto ? { id: matchingAuto.id } : {}) } });
    const saved = changed.records.find(record => record.issueKey === input.issueKey && record.date === input.date);
    assert.ok(saved);
    const unconfirmedReport = await request('report:generate', { id: p.id, date: input.date });
    if (matchingAuto) {
      assert.ok(unconfirmedReport.needsReview && unconfirmedReport.text.includes(input.title), '自动稿人工编辑后仍以待核对草稿参与日报');
    } else assert.ok(!unconfirmedReport.text.includes(input.title), '独立未确认人工记录不进入日报');
    changed = await request('record:save', { id: p.id, input: { ...input, id: saved.id, confirmed: true } });
    let generated = await request('report:generate', { id: p.id, date: input.date });
    for (const value of [input.title, input.cause, input.action, input.result]) assert.ok(generated.text.includes(value));
    const summaryLine = generated.text.split('\n').find(line => line.includes(input.title));
    assert.ok(summaryLine.length < 600, '日报仅包含已核对简要结果');
    if (fixTurn.assistantText.length > 1000) assert.ok(!generated.text.includes(fixTurn.assistantText), '未保存整段答复到日报');
    changed = await request('record:save', { id: p.id, input: { issueKey: input.issueKey, title: input.title, date: input.date, action: input.action, confirmed: true, result: input.result } });
    assert.equal(changed.records.filter(record => record.issueKey === input.issueKey && record.date === input.date).length, 1, '同日同事项更新不重复');
    const firstDay = changed.records.find(record => record.id === saved.id);
    changed = await request('record:save', { id: p.id, input: { ...input, id: saved.id, date: nextDay(input.date), confirmed: true, action: '保留该事项后续日期的核对进展。', result: '原日修复记录已保留，后续进展单独存档。', status: '待验证' } });
    assert.equal(changed.records.length, baselineRecords + (matchingAuto ? 1 : 2));
    assert.deepEqual(changed.records.find(record => record.id === saved.id), firstDay, '跨日续条不覆盖前日快照');
    assert.ok(changed.records.find(record => record.id === saved.id).attachments.length);
    generated = await request('report:generate', { id: p.id, date: input.date });
    await request('report:save', { id: p.id, date: input.date, text: generated.text });
    const protectedRecord = (await current()).records.find(record => record.id === saved.id);
    const afterRefresh = await settleSummary();
    assert.deepEqual(afterRefresh.records.find(record => record.id === saved.id), protectedRecord, '后台再次整理不能覆盖人工接管或确认的记录');
    const beforeRestart = await current();
    checks.push('基于真实修复事实核对摘要；自动稿标明待核对、确认后四项齐全、同日合并、跨日保留、媒体来源和人工保护均通过');
    await app.close(); app = null; page = null; panel = null;
    await launch();
    const restarted = await current();
    assert.deepEqual(counts(restarted), counts(beforeRestart));
    assert.equal(restarted.artifactDir, ROOT);
    assert.equal(restarted.codex.threadId, THREAD_ID);
    assert.ok(restarted.reports.some(value => value.date === input.date && value.text.trim() === generated.text.trim()));
    assert.deepEqual(restarted.records.find(record => record.id === saved.id).attachments, beforeRestart.records.find(record => record.id === saved.id).attachments);
    checks.push('关闭后重启，副本目录设置、会话绑定、摘要、附件和日报均保留');
    assert.deepEqual(rendererErrors, []);
    report = {
      mode: process.env.FDE_SMOKE_EXECUTABLE ? '便携版真实项目副本验收' : '源码真实项目副本验收', result: '通过',
      project: { name: original.name, id: original.id, sourceDir: original.sourceDir, devDir: original.devDir, artifactDir: ROOT },
      index: { originalFiles: originalCounts.files, activeFiles: p.files.length, artifacts: artifacts.length, noiseFiles: 0 },
      conversation: { threadId: THREAD_ID, turns: read.turns.length, versionRepairTurns: versionTurns.length, mediaReferences: retainedMedia.length, requirementCandidates: read.drafts.requirements.length, recordCandidates: read.drafts.records.length, readCreatedManualRecords: 0, automaticDraftRecords: summarized.records.filter(record => record.managedBy === 'codex-auto').length, automaticSummaryDays: summarized.codex.dailySummaries.length, modelConfigured: false },
      reportValidation: { date: input.date, nextDate: nextDay(input.date), recordsBefore: baselineRecords, recordsAfter: restarted.records.length, concise: true, manuallyConfirmed: true },
      float: { revealedFile: target.path, systemExplorer: 'mock，仅验证真实 UI → IPC 的目标路径和成功提示', overflow },
      fixture, checks
    };
  } finally {
    if (app) await app.close();
    const afterBytes = await fs.readFile(REAL_STORE);
    const afterProject = projectFrom(JSON.parse(afterBytes));
    assert.ok(afterProject);
    const businessCounts = value => ({ requirements: value.requirements.length, records: value.records.length, reports: value.reports.length });
    assert.deepEqual(businessCounts(afterProject), businessCounts(original), '真实项目未新增/删除需求、工作和日报');
    assert.equal(afterProject.codex.threadId, original.codex.threadId, '真实会话绑定未由副本测试改动');
    if (report) report.realData = { storeHashUnchanged: sha(afterBytes) === sha(beforeBytes), requirementsRecordsReportsAndBindingUnchanged: true, copiedStore: path.join(dataDir, 'store.json') };
  }
  const reportPath = path.join(out, process.env.FDE_SMOKE_EXECUTABLE ? '真实项目验收-便携版.json' : '真实项目验收-源码.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, mode: report.mode, index: report.index, conversation: report.conversation, realData: report.realData, reportPath }, null, 2));
}

run().catch(error => { console.error(error); process.exitCode = 1; });
