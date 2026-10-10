'use strict';

// Real Electron main, RequirementService, model transport, Store and renderer.
// Only the remote model is replaced by an isolated loopback HTTP fixture.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');

const ROOT = path.resolve(__dirname, '..');
const PORTABLE = Boolean(process.env.FDE_SMOKE_EXECUTABLE);
const UI_PENDING = process.env.FDE_REQUIREMENTS_UI_PENDING === '1';
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const businessText = (label, phase) => label === 'A'
  ? `# PROJECT_A PHASE_${phase}\n业务人员需要按月导出订单报表，支持 PDF 附件上传。${phase === 1 ? '金额是否包含退款尚未明确。' : '客户确认金额扣除退款。'}${phase >= 3 ? '报表新增备注栏。' : ''}\n`
  : `# PROJECT_B PHASE_${phase}\n仓库需要库存盘点、低库存预警，预警阈值为十件。${phase === 1 ? '盘点频率需确认。' : '客户确认每周盘点。'}\n`;

async function run() {
  const output = path.join(ROOT, 'test-output'); await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, '自动需求 全链路 '));
  const dataDir = path.join(fixture, 'data'), home = path.join(fixture, '独立 Codex'), sessions = path.join(home, 'sessions', '2026', '10', '09');
  await fs.mkdir(sessions, { recursive: true });
  const checks = [], calls = [], errors = [], screenshots = [];
  let app, page, failNextA = false;
  const check = (condition, message) => { assert.ok(condition, message); checks.push(message); };
  const completion = (res, items, confirmations) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items, ...(confirmations === undefined ? {} : { confirmations }) }) } }] }));
  };
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, undefined, '本机模型无需密钥，不能发送空或其他授权头');
      let raw = ''; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw), input = JSON.parse(request.messages.at(-1).content);
      if (Array.isArray(input.turns)) {
        calls.push({ kind: 'work', turnIds: input.turns.map(turn => turn.id) });
        completion(res, [{ issueKey: 'fixture_initial_business', title: '梳理初始业务需求', cause: '需要明确业务范围', action: '整理业务范围和确认问题', result: '等待客户确认退款口径', status: '待验证', turnIds: input.allowedTurnIds }]);
        return;
      }
      assert.ok(Array.isArray(input.sources) && input.sources.length);
      const text = input.sources.map(source => source.text).join('\n');
      const label = text.includes('PROJECT_A') ? 'A' : text.includes('PROJECT_B') ? 'B' : null;
      assert.ok(label, '模型资料必须能对应隔离项目');
      const opposite = label === 'A' ? 'PROJECT_B' : 'PROJECT_A';
      assert.ok(!text.includes(opposite), '两个项目资料不能串入同一请求');
      const phase = Math.max(...[...text.matchAll(/PHASE_(\d+)/g)].map(match => Number(match[1])));
      const sourceIds = input.sources.filter(source => !source.type.startsWith('existing-')).map(source => source.id);
      assert.ok(sourceIds.length && sourceIds.every(id => input.allowedSourceIds.includes(id)));
      const failed = label === 'A' && failNextA; if (failed) failNextA = false;
      calls.push({ kind: 'requirements', label, phase, sourceIds, sourceTypes: input.sources.map(source => source.type), previousKeys: input.previousItems.map(item => item.requirementKey), includesOffline: text.includes('OFFLINE_UPDATE'), failed });
      if (failed) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"ISOLATED_REQUIREMENT_FIXTURE_UNAVAILABLE"}}'); return; }
      const item = (requirementKey, title, description, questions = []) => ({ requirementKey, title, description, questions,
        status: questions.length ? '待确认' : '已明确', sourceIds, relatedRequirementKeys: [] });
      if (label === 'A') {
        const report = item('a_order_report', 'A 订单报表导出', phase === 1 ? '业务人员按月导出订单和金额报表。' : `按月导出订单，金额扣除退款${phase >= 3 ? '并增加备注栏' : ''}。`, phase === 1 ? ['导出金额是否扣除退款？'] : []);
        const resolved = text.includes('BILL_SOURCE_CONFIRMED');
        const confirmations = phase === 1 || resolved ? [{ confirmationKey: 'a_bill_source', scenario: 'ERP 提单容量字段尚未核实。', question: '提单重量、体积应从 ERP 哪些字段获取？', workaround: '暂时从 Excel 导入提单信息，ERP 获取后续补充。', status: resolved ? '已解决' : '待确认', resolution: resolved ? '客户已确认重量上限和体积上限字段。' : '', sourceIds: input.sources.filter(source => source.timestamp).map(source => source.id), relatedConfirmationKeys: [], requirementKeys: ['a_order_report'] }] : [];
        completion(res, phase === 1 ? [report, item('a_pdf_upload', 'A PDF 附件上传', '用户上传 PDF 文件作为订单附件。')] : [report], confirmations);
      } else {
        const inventory = item('b_inventory', 'B 库存盘点', phase === 1 ? '仓库录入并查看库存盘点结果。' : '仓库每周录入并查看库存盘点结果。', phase === 1 ? ['库存多久盘点一次？'] : []);
        completion(res, phase === 1 ? [inventory, item('b_stock_alert', 'B 低库存预警', '库存低于十件时提醒仓库人员。')] : [inventory]);
      }
    } catch (error) {
      errors.push(`mock: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"ISOLATED_MOCK_ASSERTION_FAILED"}}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { enabled: true, provider: 'compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock-business-requirements' };
  const seed = new Store(dataDir), projects = new Map(), sourceFiles = new Map();
  for (const label of ['A', 'B']) {
    const sourceDir = path.join(fixture, `${label} 原始资料`), devDir = path.join(fixture, `${label} 开发目录`);
    await Promise.all([sourceDir, devDir].map(directory => fs.mkdir(directory, { recursive: true })));
    const sourceFile = path.join(sourceDir, '原始需求.md'); await fs.writeFile(sourceFile, businessText(label, 1)); sourceFiles.set(label, sourceFile);
    const project = seed.createProject({ name: `自动需求验收 ${label}`, sourceDir, devDir });
    await seed.scanProject(project.id); projects.set(label, project);
  }
  const a = projects.get('A'), b = projects.get('B'), threadId = randomUUID();
  seed.bindCodexThread(a.id, { threadId });
  const timestamp = '2026-10-09T02:00:00Z';
  await fs.writeFile(path.join(sessions, `rollout-${threadId}.jsonl`), encode([
    { type: 'session_meta', timestamp, payload: { id: threadId, cwd: a.devDir } },
    { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'a-initial-business' } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PROJECT_A PHASE_1 业务需求：按月导出订单报表，支持 PDF 附件上传；退款口径还要确认。提单信息获取不到，先采用表格导入，ERP 获取后续补充。' }] } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '已梳理订单报表和附件上传需求，退款口径待客户确认。提单容量字段仍未核实，当前先做表格导入，临时导入完成不代表数据来源已确认。' }] } },
    { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'a-initial-business' } },
  ]));
  seed.saveSummarizerSettings(config); seed.setSettings({ activeProjectId: a.id });
  // Emulate a customer changing material while FDE Desk is closed. The saved
  // file index still contains phase 1 without this marker until main rescans.
  await fs.writeFile(sourceFiles.get('B'), businessText('B', 1) + '\nOFFLINE_UPDATE：离线补充，库存盘点应保留操作人信息。\n');
  const initialHashes = await Promise.all([...sourceFiles.values()].map(async file => hash(await fs.readFile(file))));
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: dataDir, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
  const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.fde.request(action, payload), { action, payload });
  const state = () => request('state');
  const projectState = async label => (await state()).projects.find(project => project.id === projects.get(label).id);
  const requirementCalls = () => calls.filter(call => call.kind === 'requirements');
  const quiet = async (count, message) => { await pause(750); check(requirementCalls().length === count, message); };
  async function eventually(predicate, message, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await pause(60); }
    throw new Error(message);
  }
  const waitReady = async (label, extra = () => true) => eventually(async () => {
    const project = await projectState(label);
    return project.requirementAnalysis?.status?.state === 'ready' && await extra(project);
  }, `${label} 项目自动需求未就绪`);
  async function launch() {
    app = await electron.launch({ executablePath: EXECUTABLE, args: PORTABLE ? [] : [ROOT], env, timeout: 40000 });
    await app.firstWindow();
    await eventually(async () => { page = app.windows().find(candidate => candidate.url().endsWith('/index.html')); return Boolean(page); }, '隔离工作台未加载');
    page.setDefaultTimeout(12000); await page.waitForFunction(() => Boolean(window.fde));
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html')); window.show(); window.focus(); });
  }
  try {
    await launch();
    check((await state()).dataDir === dataDir, '真实 Electron main 使用隔离数据目录与 Codex home');
    await waitReady('A', project => project.requirements.length === 2); await waitReady('B', project => project.requirements.length === 2);
    check(requirementCalls().length === 2 && requirementCalls().filter(call => call.label === 'A').length === 1 && requirementCalls().filter(call => call.label === 'B').length === 1, '启动自动整理两个项目的已有资料，无须添加需求或切换项目');
    check((await state()).settings.activeProjectId === a.id && !(await projectState('B')).codex.threadId, '未关联会话的非当前项目也能仅凭原始资料生成需求');
    check(requirementCalls().find(call => call.label === 'B').includesOffline === true && (await projectState('B')).files.some(file => file.textPreview?.includes('OFFLINE_UPDATE')), '启动先刷新索引，离线修改的业务正文进入首次模型请求和本地预览');
    check(requirementCalls().find(call => call.label === 'A').sourceTypes.includes('business-turn'), '真实隔离 Codex 初次业务对话进入 A 的需求分析');
    check(initialHashes.every((value, index) => value === hash(require('node:fs').readFileSync([...sourceFiles.values()][index]))), '自动读取需求不改写原始资料');
    const originalA = await projectState('A'), originalReport = originalA.requirements.find(item => item.requirementKey === 'a_order_report');
    const originalConfirmation = originalA.requirementConfirmations.find(item => item.confirmationKey === 'a_bill_source');
    check(originalConfirmation?.status === '待确认' && originalConfirmation.workaround.includes('Excel') && Date.parse(originalConfirmation.sourceLastAt) === Date.parse(timestamp), '提单获取暂缓场景自动保存临时办法、客户问题及真实对话时间');
    check(originalA.requirements.every(item => item.managedBy === 'requirements-auto') && originalReport.questions.length === 1 && originalReport.status === '待确认', '需求以自动业务事项保存，并保留实际待确认问题');
    await page.locator('[data-route="requirements"]').first().click();
    await eventually(async () => await page.locator('.requirement-card').count() === 2, '需求卡片未显示');
    check(await page.getByRole('heading', { name: 'A 订单报表导出', exact: true }).isVisible() && await page.getByRole('heading', { name: 'A PDF 附件上传', exact: true }).isVisible(), '需求界面显示两组业务功能卡片');
    if (!UI_PENDING) {
      check(await page.getByText('导出金额是否扣除退款？', { exact: true }).isVisible() && await page.locator('#requirement-questions-title').isVisible(), '需求界面单独显示待确认问题，并标明对应业务需求');
      check(await page.locator('#requirement-business-title').isVisible() && await page.locator('#requirement-analysis-status').isVisible(), '业务需求区与真实后台自动整理状态可见');
      check(await page.locator('.requirement-sources').count() >= 2 && await page.locator('.requirement-sources[open]').count() === 0, '来源默认折叠，卡片保持简短可查看');
      check(await page.getByText(originalConfirmation.scenario, { exact: true }).isVisible() && await page.getByText(originalConfirmation.workaround, { exact: true }).isVisible(), '需求确认直接展示业务场景与临时替代办法');
      check((await page.locator('#requirement-questions').innerText()).includes('2026-10-09 10:00'), '确认项显示真实 Codex 对话的上海日期时分');
    }
    const screenshot = path.join(output, PORTABLE ? '自动需求全链路-便携版.png' : '自动需求全链路-源码.png'); await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
    await page.locator('#requirement-after').fill('2026-10-10'); await page.locator('#requirement-after').dispatchEvent('change');
    await eventually(async () => (await projectState('A')).requirementsAfter === '2026-10-09T16:00:00.000Z' && await page.getByText(originalConfirmation.scenario, { exact: true }).count() === 0, '时间筛选未持久化或界面未更新');
    check(await page.getByText(originalConfirmation.scenario, { exact: true }).count() === 0 && (await projectState('A')).requirementConfirmations.length === 1, '筛选指定时间前的内容仅隐藏，不删除历史确认项');
    await app.close(); app = null;
    await launch(); await waitReady('A'); await waitReady('B');
    await quiet(2, '模型开启且资料未变化时完整重启不再次请求需求模型');
    await page.locator('[data-route="requirements"]').first().click();
    check(await page.locator('#requirement-after').inputValue() === '2026-10-10', '重启后当前项目时间筛选保留');
    await page.locator('[data-action="clear-requirement-filter"]').click();
    await eventually(async () => await page.getByText(originalConfirmation.scenario, { exact: true }).isVisible(), '清空时间筛选未恢复历史确认项');
    await request('project:scan', { id: a.id }); await request('project:scan', { id: b.id });
    await quiet(2, '刷新未变化的资料索引不再次调用模型');

    await fs.writeFile(sourceFiles.get('B'), businessText('B', 2)); await request('project:scan', { id: b.id });
    await waitReady('B', project => project.requirements.find(item => item.requirementKey === 'b_inventory')?.questions.length === 0);
    check((await state()).settings.activeProjectId === a.id && requirementCalls().at(-1).label === 'B', '非当前项目资料更新后无需切换即可增量整理且不串项目');
    check((await projectState('B')).requirements.length === 2 && (await projectState('A')).requirements.every(item => item.requirementKey.startsWith('a_')), '增量只改对应项目，未回传旧需求仍保留');

    await fs.writeFile(sourceFiles.get('A'), businessText('A', 2)); await request('project:scan', { id: a.id });
    await waitReady('A', project => project.requirements.find(item => item.requirementKey === 'a_order_report')?.questions.length === 0);
    const updatedReport = (await projectState('A')).requirements.find(item => item.requirementKey === 'a_order_report');
    check(updatedReport.id === originalReport.id && updatedReport.status === '已明确' && updatedReport.description.includes('扣除退款'), '客户补充资料后同一需求稳定更新，确认问题解除');
    check(requirementCalls().at(-1).sourceTypes.every(type => type !== 'business-turn'), '资料增量仅发送变化的正文，不重发初次会话原文');
    await eventually(async () => await page.getByText('导出金额是否扣除退款？', { exact: true }).count() === 0, '已解答的问题仍显示');

    const resolvedAt = '2026-10-09T03:30:00Z';
    await fs.appendFile(path.join(sessions, `rollout-${threadId}.jsonl`), encode([
      { type: 'event_msg', timestamp: resolvedAt, payload: { type: 'task_started', turn_id: 'a-business-resolution' } },
      { type: 'response_item', timestamp: resolvedAt, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PROJECT_A PHASE_2 BILL_SOURCE_CONFIRMED 客户确认：提单容量使用 ERP 的重量上限和体积上限字段，先前字段来源问题已经解决。' }] } },
      { type: 'response_item', timestamp: resolvedAt, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '已记录客户确认的提单字段，原先的来源疑问已解决。' }] } },
      { type: 'event_msg', timestamp: resolvedAt, payload: { type: 'task_complete', turn_id: 'a-business-resolution' } },
    ]));
    await waitReady('A', p => p.requirementConfirmations.find(item => item.confirmationKey === 'a_bill_source')?.status === '已解决');
    const resolvedConfirmation = (await projectState('A')).requirementConfirmations.find(item => item.confirmationKey === 'a_bill_source');
    check(resolvedConfirmation.id === originalConfirmation.id && Date.parse(resolvedConfirmation.sourceLastAt) === Date.parse(resolvedAt) && Date.parse(resolvedConfirmation.sourceFirstAt) === Date.parse(timestamp), '新客户答复解决同一确认项，稳定编号及首次/最近对话时间保留');
    await eventually(async () => (await page.locator('#requirement-questions').innerText()).includes('已解决'), '解决事项的折叠历史未显示');
    check(!(await page.getByText(resolvedConfirmation.question, { exact: true }).isVisible()), '已解决的业务缺口不再默认展示为待客户确认');

    await request('requirement:save', { id: a.id, input: { id: updatedReport.id, title: '人工确认的订单报表', description: '人工定稿：按月导出，退款扣除，范围已核对。', questions: [], status: '已明确' } });
    const manualBefore = (await projectState('A')).requirements.find(item => item.id === updatedReport.id);
    check(manualBefore.manual === true, '人工编辑接管自动需求');
    await fs.writeFile(sourceFiles.get('A'), businessText('A', 3)); await request('project:scan', { id: a.id });
    await waitReady('A', project => project.requirementAnalysis.fingerprint !== originalA.requirementAnalysis.fingerprint && requirementCalls().at(-1).phase === 3);
    check(JSON.stringify((await projectState('A')).requirements.find(item => item.id === updatedReport.id)) === JSON.stringify(manualBefore), '后续模型更新保护人工定稿，不覆盖或重复创建');

    const beforeFailure = JSON.stringify((await projectState('A')).requirements), beforeFailureCalls = requirementCalls().length;
    failNextA = true; await fs.writeFile(sourceFiles.get('A'), businessText('A', 4)); await request('project:scan', { id: a.id });
    await eventually(async () => (await projectState('A')).requirementAnalysis.status.state === 'error', '模拟模型失败未显示错误');
    check(requirementCalls().length === beforeFailureCalls + 1 && JSON.stringify((await projectState('A')).requirements) === beforeFailure, '模型服务失败保留已有需求和人工修改');
    await request('project:scan', { id: a.id }); await quiet(beforeFailureCalls + 1, '失败且输入未变时刷新不会自动重复请求');
    await request('model:save', { config: { ...config, enabled: false } });
    await eventually(async () => (await projectState('A')).requirementAnalysis.status.state === 'unconfigured' && (await projectState('B')).requirementAnalysis.status.state === 'unconfigured', '关闭模型后需求提示未更新');
    check(JSON.stringify((await projectState('A')).requirements) === beforeFailure && (await projectState('B')).requirements.length === 2, '未配置可用模型时明确提示，并保留两个项目已有需求');
    check(/启用整理模型/.test((await projectState('A')).requirementAnalysis.status.message), '无模型提示说明配置入口，不编造本地需求');
    if (!UI_PENDING) {
      await eventually(async () => /启用整理模型/.test(await page.locator('#requirement-analysis-status').innerText()), '未配置模型的提示没有显示到需求界面');
      check(await page.locator('#requirement-analysis-status').isVisible(), '无模型时需求页面显示真实配置提示');
    }
    await quiet(beforeFailureCalls + 1, '模型关闭不会产生额外请求');
    check(errors.length === 0, '全链路没有渲染器或本机模型断言异常');
    const result = { status: UI_PENDING ? 'backend-passed-ui-pending' : 'passed', mode: PORTABLE ? 'portable' : 'source', checks, fixture, screenshots,
      requests: calls, requirementCalls: requirementCalls().length,
      boundary: '真实 Electron main/IPC/RequirementService/model-api/Store/UI；独立 data 和 CODEX_HOME，未读取正式数据或真实密钥，仅调用本机无密钥假模型；未模拟 IPC 或篡改服务实现' };
    const report = path.join(output, PORTABLE ? '自动需求全链路-便携版.json' : '自动需求全链路-源码.json'); await fs.writeFile(report, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ status: result.status, checks: checks.length, requirementCalls: result.requirementCalls, report }));
  } catch (error) {
    await fs.writeFile(path.join(output, PORTABLE ? '自动需求全链路失败-便携版.json' : '自动需求全链路失败-源码.json'), JSON.stringify({ status: 'failed', message: error.message, checks, calls, errors, fixture }, null, 2));
    throw error;
  } finally {
    if (app) await app.close();
    server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
