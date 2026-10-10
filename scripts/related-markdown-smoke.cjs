'use strict';

// Isolated sessions + loopback model; clipboard/dialog/shell boundaries are mocked.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');
const DATE_A = '2026-10-08', DATE_B = '2026-10-09';
const FAKE_KEY = 'fde-mock-related-markdown-key';

async function hashFile(file) {
  try { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function run() {
  const out = path.join(ROOT, 'test-output'); await fs.mkdir(out, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(out, '任务归一 Markdown '));
  const sourceDir = path.join(fixture, '原始资料'), devDir = path.join(fixture, '开发目录'), dataDir = path.join(fixture, 'data'), home = path.join(fixture, '独立 Codex');
  await Promise.all([sourceDir, devDir, home].map(dir => fs.mkdir(dir, { recursive: true })));
  const sessions = path.join(home, 'sessions', '2026', '10', '08'); await fs.mkdir(sessions, { recursive: true });
  const rollout = path.join(sessions, 'rollout-related-markdown.jsonl'), threadId = 'related-markdown-isolated';
  const rawMarkdown = [
    '# 验收日报', '', '## 模型接入与选择', '', '- **完成连接配置**', '- 文件检索仍未解决，等待定位', '',
    '```js', 'const sample = "<script>window.__fdeMarkdownXss = 1</script>";', '```', '',
    '| 事项 | 结果 |', '| --- | --- |', '| 模型选择 | 已回填 |', '',
    '[安全文档](https://example.com/fde-docs?x=1&y=2)',
    '[禁止执行](javascript:alert(1))', '[禁止本地](file:///D:/private.txt)', '[禁止数据](data:text/html,bad)',
    '![禁止网络图片](https://example.invalid/fde-track.png)',
    '<script>window.__fdeMarkdownXss = 2</script>',
    '<img src="https://example.invalid/raw-track.png" onerror="window.__fdeMarkdownXss=3">',
    '<iframe src="https://example.invalid/frame"></iframe>',
    '<form id="workspace" name="modal-form"><button data-action="delete-project">禁止产品动作</button></form>',
    '<a href="https://example.com/safe-raw" data-action="delete-record" data-item="fake-id" data-route="records" onclick="window.__fdeMarkdownXss=4">禁止动作属性</a>',
  ].join('\n');
  const turn = (id, date, hour, question, answer) => {
    const timestamp = `${date}T${hour}:00:00Z`;
    return [
      { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: id } },
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] } },
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] } },
      { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: id } },
    ];
  };
  await fs.writeFile(rollout, [
    { type: 'session_meta', timestamp: `${DATE_A}T01:00:00Z`, payload: { id: threadId, cwd: devDir } },
    ...turn('related-first', DATE_A, '01', '配置模型连接；另一个独立问题是文件检索失败', rawMarkdown),
    ...turn('related-second', DATE_A, '02', '继续完成同一模型功能的列表选择', '模型列表已接入，选择后回填。'),
    ...turn('related-third', DATE_A, '03', '修复同一模型功能的回填问题', '已修复相关回填并补测。'),
    ...turn('related-nextday', DATE_B, '01', '第二天客户验证模型功能', '客户验证通过，记录当天测试结果。'),
  ].map(JSON.stringify).join('\n') + '\n');
  const seed = new Store(dataDir), p = seed.createProject({ name: '关联任务与 Markdown 验收', sourceDir, devDir });
  seed.updateProject(p.id, { codex: { threadId } }); seed.setSettings({ activeProjectId: p.id });
  seed.upsertRecord(p.id, { date: DATE_A, issueKey: 'manual_keep', title: '人工安排客户配合', action: '确认样例提供时间', result: '等待客户补充样例', confirmed: true });
  const realStore = path.join(ROOT, 'release', 'FDE Desk-win32-x64', 'data', 'store.json'), realBefore = await hashFile(realStore);
  let phase = 'split', app, page, calls = 0;
  const checks = [], rendererNetwork = [];
  const check = (condition, description) => { assert.ok(condition, description); checks.push(description); };
  const item = (issueKey, title, turnIds, extra = {}) => ({ issueKey, title, cause: '功能尚未完善', action: '完成对应处理并补测', result: '自测通过，等待客户测试', status: '待验证', turnIds, ...extra });
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls++;
    const body = JSON.parse(raw), input = JSON.parse(body.messages.at(-1).content);
    const independent = item('file_search', '文件检索排查', ['related-first'], { cause: '路径索引不完整', action: '排查检索边界', result: '文件检索仍未解决，等待定位', status: '未解决' });
    const items = input.date === DATE_B
      ? [item('model_nextday', '客户验证模型功能', ['related-nextday'], { result: '客户验证通过', status: '已完成' })]
      : phase === 'split'
        ? [item('model_config', '配置模型连接', ['related-first']), item('model_select', '接入模型列表选择', ['related-second']), item('model_fix', '修复模型选择回填', ['related-third']), independent]
        : [item('model_task', '模型接入与选择完善', ['related-first', 'related-second', 'related-third', 'related-fourth'], { relatedIssueKeys: ['model_config', 'model_select', 'model_fix'], action: '完成连接、选择和相关回填修复', result: '功能自测通过，等待客户测试' }), independent];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: dataDir, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
  const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.fde.request(action, payload), { action, payload });
  async function eventually(predicate, message, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(message);
  }
  const currentProject = async () => (await request('state')).projects.find(project => project.id === p.id);
  async function launch() {
    app = await electron.launch({ executablePath: EXECUTABLE, args: process.env.FDE_SMOKE_EXECUTABLE ? [] : [ROOT], env, timeout: 40000 });
    await app.firstWindow();
    await eventually(async () => { page = app.windows().find(window => window.url().endsWith('/index.html')); return !!page; }, '工作台未加载');
    page.setDefaultTimeout(12000);
    await page.waitForFunction(() => !!window.fde);
    page.on('request', req => { if (/^https?:/i.test(req.url())) rendererNetwork.push(req.url()); });
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().endsWith('/index.html')); window.show(); window.focus(); });
  }
  try {
    await launch();
    const exported = path.join(fixture, '导出原文.md');
    await app.evaluate(({ clipboard, dialog, shell }, exportPath) => {
      globalThis.__fdeMdBoundary = { copied: [], opened: [], exports: 0 };
      clipboard.writeText = text => { globalThis.__fdeMdBoundary.copied.push(text); };
      shell.openExternal = async url => { globalThis.__fdeMdBoundary.opened.push(url); };
      dialog.showSaveDialog = async () => { globalThis.__fdeMdBoundary.exports++; return { canceled: false, filePath: exportPath }; };
    }, exported);
    await request('model:save', { config: { enabled: true, provider: 'compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock-related' }, apiKey: FAKE_KEY });
    await eventually(async () => { const project = await currentProject(); return project.codex.summaryStatus?.state === 'ready' && project.codex.dailySummaries.length === 2 && project.codex.dailySummaries.find(summary => summary.date === DATE_A)?.items.length === 4; }, '初始旧拆分任务未创建');
    const before = await currentProject(), initialDay = before.codex.dailySummaries.find(summary => summary.date === DATE_A);
    const protectedRecord = before.records.find(record => record.issueKey === 'model_select' && record.date === DATE_A);
    const obsoleteIds = before.records.filter(record => record.date === DATE_A && ['model_config', 'model_fix'].includes(record.issueKey)).map(record => record.id);
    const nextdayId = before.records.find(record => record.date === DATE_B).id;
    check(initialDay.items.length === 4 && before.records.length === 6, '隔离副本包含旧拆分项、独立任务、人工项和跨日项');
    await request('record:save', { id: p.id, input: { id: protectedRecord.id, title: '人工保留模型选择结论', result: '人工确认仍等客户测试', confirmed: true } });
    phase = 'related';
    await fs.appendFile(rollout, turn('related-fourth', DATE_A, '04', '把连接、选择、回填修复归到同一模型功能', '模型功能已完成相关自测，文件检索仍为独立未解决问题。').map(JSON.stringify).join('\n') + '\n');
    await request('summary:run', { id: p.id, force: true });
    await eventually(async () => { const project = await currentProject(); return project.codex.summaryStatus?.state === 'ready' && project.codex.dailySummaries.find(summary => summary.date === DATE_A)?.items.length === 2; }, '关联任务未归一');
    let project = await currentProject(), related = project.codex.dailySummaries.find(summary => summary.date === DATE_A);
    const combined = related.items.find(entry => entry.title === '模型接入与选择完善');
    check(!!combined && combined.turnIds.length === 4 && ['model_config', 'model_select', 'model_fix'].every(key => [combined.issueKey, ...(combined.relatedIssueKeys || [])].includes(key)), '同日关联任务归一并保留真实旧事项编号与轮次');
    check(combined.issueKey === 'model_config', '归一沿用已有事项编号而非生成不稳定的新编号');
    check(related.items.some(entry => entry.issueKey === 'file_search') && related.items.length === 2, '共享一个轮次的独立文件检索任务仍单独保留');
    check(obsoleteIds.every(id => !project.records.some(record => record.id === id)), '被吸收的旧自动记录消失');
    check(project.records.some(record => record.id === protectedRecord.id && record.title === '人工保留模型选择结论' && record.result === '人工确认仍等客户测试'), '旧拆分项的人工修改由关联编号保护');
    check(project.records.some(record => record.issueKey === 'manual_keep') && project.records.some(record => record.id === nextdayId) && project.records.length === 4, '独立人工记录和跨日记录不被覆盖或合并');
    const generated = await request('report:generate', { id: p.id, date: DATE_A });
    check(!/状态[：:]|待核对/.test(generated.text) && generated.text.includes('文件检索仍未解决'), '生成日报去掉固定状态和待核对冗余并保留未解决事实');
    check(!/状态[：:]|待核对/.test(related.reportText) && related.reportText.includes('文件检索仍未解决'), '自动日报同样去除固定冗余而保留真实问题结果');
    await page.locator('[data-route="codex"]').first().click();
    await page.locator('#codex-date').fill(DATE_A);
    await eventually(async () => await page.locator('.summary-card').count() === 2, '归一任务未在工作台显示');
    const cardText = await page.locator('#daily-summaries').innerText();
    check(cardText.includes('人工保留模型选择结论') && cardText.includes('文件检索排查'), '工作台关联卡片优先展示人工内容且独立任务分开');
    const taskScreenshot = path.join(out, process.env.FDE_SMOKE_EXECUTABLE ? '16-关联任务工作台-便携版.png' : '16-关联任务工作台-源码.png');
    await page.screenshot({ path: taskScreenshot });

    await page.locator('[data-route="reports"]').first().click();
    await page.locator('#report-date').fill(DATE_A);
    await page.waitForSelector('#report-preview:not([hidden])');
    check(await page.locator('#report-text').isHidden(), '日报默认显示 Markdown 预览而保留原文编辑器');
    await page.locator('[data-action="edit-report"]').click();
    await page.locator('#report-text').fill(rawMarkdown);
    await page.locator('[data-action="preview-report"]').click();
    const preview = page.locator('#report-preview');
    check(await preview.locator('h1').innerText() === '验收日报' && await preview.locator('h2').count() === 1 && await preview.locator('ul li').count() === 2 && await preview.locator('pre code').count() === 1 && await preview.locator('table th').count() === 2 && await preview.locator('table tbody tr').count() === 1, 'Markdown 正常渲染标题、列表、代码与表格');
    check(await page.locator('#report-text').inputValue() === rawMarkdown && (await preview.locator('pre code').innerText()).includes('<script>'), '渲染不改变原文且代码内容作为文本显示');
    const safety = await preview.evaluate(element => ({
      dangerousTags: element.querySelectorAll('script,img,iframe,form,button,input,style,svg,math,object,embed').length,
      dangerousAttrs: [...element.querySelectorAll('*')].flatMap(node => [...node.attributes]).filter(attribute => /^(?:on|data-|style$|src$|srcset$|id$|name$)/i.test(attribute.name)).length,
      unsafeLinks: [...element.querySelectorAll('a[href]')].filter(anchor => !/^https?:\/\//i.test(anchor.getAttribute('href'))).length,
      xss: !!window.__fdeMarkdownXss,
    }));
    check(!safety.dangerousTags && !safety.dangerousAttrs && !safety.unsafeLinks && !safety.xss, '预览剥离 XSS、图片、动作属性及非 HTTP(S) 链接');
    check(rendererNetwork.length === 0, '渲染 Markdown 不加载远程图片或页面资源');
    const beforeUrl = page.url();
    await preview.locator('a[href]').first().click();
    await eventually(async () => (await app.evaluate(() => globalThis.__fdeMdBoundary.opened.length)) === 1, '安全链接未交给外部打开边界');
    check((await app.evaluate(() => globalThis.__fdeMdBoundary.opened[0])) === 'https://example.com/fde-docs?x=1&y=2' && page.url() === beforeUrl, 'HTTP(S) 链接通过外部打开接口且不会导航工作台');
    let refused = 0;
    for (const url of ['javascript:alert(1)', 'file:///D:/private.txt', 'data:text/html,bad', 'vscode://file/test', 'https://name:password@example.com', 'https://example.com/\nattack']) {
      try { await request('link:open', { url }); } catch { refused++; }
    }
    check(refused === 6 && (await app.evaluate(() => globalThis.__fdeMdBoundary.opened.length)) === 1, '主进程再次拒绝非 HTTP(S)、嵌入凭据及控制字符链接');
    const screenshot = path.join(out, process.env.FDE_SMOKE_EXECUTABLE ? '15-任务归一与Markdown-便携版.png' : '15-任务归一与Markdown-源码.png');
    await page.screenshot({ path: screenshot });
    await page.locator('[data-action="save-report"]').click();
    await eventually(async () => (await currentProject()).reports.find(report => report.date === DATE_A)?.text === rawMarkdown, '原 Markdown 未保存');
    await page.locator('[data-action="copy-report"]').click();
    await page.locator('[data-action="export-report"]').click();
    await eventually(async () => { try { return await fs.readFile(exported, 'utf8') === rawMarkdown; } catch { return false; } }, '导出内容不是原 Markdown');
    const boundary = await app.evaluate(() => globalThis.__fdeMdBoundary);
    check(boundary.copied.at(-1) === rawMarkdown && boundary.exports === 1 && await fs.readFile(exported, 'utf8') === rawMarkdown, '复制与导出使用原 Markdown（原生边界使用本机 mock）');

    await page.locator('[data-route="codex"]').first().click();
    await page.locator('#codex-date').fill(DATE_A);
    await page.locator('#codex-original > summary').click();
    await page.waitForSelector('.turn-card');
    const firstTurn = page.locator('.turn-card').filter({ hasText: '配置模型连接' }).first();
    await firstTurn.locator('.turn-detail > summary').click();
    check(await firstTurn.locator('.turn-assistant .markdown-body h1').innerText() === '验收日报' && await firstTurn.locator('.turn-assistant .markdown-body table').count() === 1, '原对话展开后同样呈现 Markdown 排版');
    await firstTurn.locator('.turn-source > summary').click();
    check(await firstTurn.locator('.turn-source pre').last().innerText() === rawMarkdown, '原对话可切开查看未改动的 Markdown 原文');
    check(await firstTurn.locator('.turn-assistant .markdown-body img,.turn-assistant .markdown-body script,.turn-assistant .markdown-body [data-action]').count() === 0, '原对话渲染同样剥离图片和动作注入');
    await page.locator('[data-route="reports"]').first().click();
    await page.locator('#report-date').fill(DATE_A);
    await page.locator('[data-action="edit-report"]').click();
    check(await page.locator('#report-text').inputValue() === rawMarkdown, '页面切换后保留人工 Markdown 日报');
    const edited = rawMarkdown + '\n\n## 补充编辑\n\n- 原文仍可继续修改';
    await page.locator('#report-text').fill(edited);
    await page.locator('[data-action="preview-report"]').click();
    check(await page.locator('#report-preview h2').count() === 2 && await page.locator('#report-text').inputValue() === edited, '再次编辑与预览切换保持原文和草稿');
    project = await currentProject();
    check(!JSON.stringify(await request('state')).includes(FAKE_KEY) && rendererNetwork.length === 0, '测试未暴露模型密钥或触发渲染器外网请求');
    check(realBefore === await hashFile(realStore), '真实便携版 store 文件保持不变');
    const reportPath = path.join(out, process.env.FDE_SMOKE_EXECUTABLE ? '任务归一与Markdown验收-便携版.json' : '任务归一与Markdown验收-源码.json');
    const report = { status: 'passed', mode: process.env.FDE_SMOKE_EXECUTABLE ? 'portable' : 'source', checks, modelRequests: calls, dayAItems: related.items.length, dayARecords: project.records.filter(record => record.date === DATE_A).length, dayBRecords: project.records.filter(record => record.date === DATE_B).length, fixture, screenshot, taskScreenshot, exported, realStoreUnchanged: true, nativeBoundary: 'clipboard.writeText / showSaveDialog / openExternal 使用本机 mock；不声称系统剪贴板验收通过', semanticBoundary: 'mock 返回明确 relatedIssueKeys；验证程序归一与保护，不代表真实模型的语义识别准确率' };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, mode: report.mode, checkCount: checks.length, modelRequests: calls, realStoreUnchanged: true, report: reportPath, screenshot, taskScreenshot, nativeBoundary: report.nativeBoundary, semanticBoundary: report.semanticBoundary }));
  } finally {
    if (app) await app.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
