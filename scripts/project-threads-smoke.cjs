'use strict';

// Real main IPC, candidate helper, Store and renderer. Only the Codex metadata
// reader is mocked; all fixture paths/files are isolated and models disabled.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const { MemoStore } = require('../src/core/memos.cjs');

const ROOT = path.resolve(__dirname, '..');
const PORTABLE = !!process.env.FDE_SMOKE_EXECUTABLE;
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) { try { return hash(await fs.readFile(file)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

async function run() {
  const output = path.join(ROOT, 'test-output'); await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, '目录候选关联 '));
  const dataDir = path.join(fixture, 'data'), home = path.join(fixture, '独立 Codex'), sessions = path.join(home, 'sessions', '2026', '10', '09');
  await fs.mkdir(sessions, { recursive: true });
  const seed = new Store(dataDir), projects = [], roots = [], sources = [];
  for (const label of ['A', 'B', 'C']) {
    const root = path.join(fixture, `${label} 应用项目`), sourceDir = path.join(fixture, `${label} 原始资料`), devDir = label === 'B' ? root : path.join(root, '样例文件');
    await Promise.all([root, sourceDir, devDir].map(directory => fs.mkdir(directory, { recursive: true })));
    const source = path.join(sourceDir, '客户业务.md'); await fs.writeFile(source, `${label} 隔离业务资料。`); sources.push(source);
    await fs.writeFile(path.join(root, '仓库说明.md'), `${label} 仓库根目录开发成果。`);
    await fs.writeFile(path.join(devDir, '样例说明.md'), `${label} 样例文件说明。`);
    const project = seed.createProject({ name: `${label} 目录关联验收`, sourceDir, devDir }); await seed.scanProject(project.id);
    projects.push(project); roots.push(root);
  }
  const [a, b, c] = projects, childDir = path.join(a.devDir, '子应用'), siblingDir = `${roots[0]}-其他项目`;
  await Promise.all([childDir, siblingDir].map(directory => fs.mkdir(directory, { recursive: true })));
  const sourceA = seed.getState().projects.find(project => project.id === a.id).files.find(file => file.path === sources[0]);
  seed.updateFile(a.id, sourceA.id, { description: '人工介绍：初始业务资料，长期保留' });
  seed.upsertRecord(a.id, { date: '2026-10-09', issueKey: 'manual-keep', title: '人工确认客户测试范围', action: '与客户核对样例', result: '等待客户复测', confirmed: true });
  seed.upsertRequirement(a.id, { title: '人工整理的需求', description: '源资料和项目关系保持', status: '待确认' });
  seed.saveReport(a.id, '2026-10-09', '人工日报定稿，仍待客户复测。');
  seed.bindCodexThread(c.id, { threadId: 'c-existing-missing' });
  const memos = new MemoStore({ projectFolder: id => seed.projectFolder(id) }); memos.save(a.id, { text: '独立备忘录：等待客户给测试结果。' });
  seed.saveSummarizerSettings({ enabled: false, provider: 'compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'disabled-thread-fixture' });
  seed.setSettings({ activeProjectId: a.id });
  const metadata = (id, cwd, title) => ({ id, cwd, title, path: path.join(sessions, `rollout-${id}.jsonl`), updatedAt: '2026-10-09T01:00:00Z' });
  const catalog = [
    metadata('a-main', roots[0], '应用仓库主会话'), metadata('a-child', childDir, '样例内子应用会话'),
    metadata('a-sibling', siblingDir, '相似名称的另一个项目'), metadata('b-first', roots[1], '精确目录第一个会话'),
    metadata('b-second', roots[1], '精确目录第二个会话'), metadata('c-main', roots[2], '既有项目可纠正的主会话'),
  ];
  for (const thread of catalog) await fs.writeFile(thread.path, JSON.stringify({ type: 'session_meta', timestamp: thread.updatedAt, payload: { id: thread.id, cwd: thread.cwd } }) + '\n');
  const realStore = path.join(ROOT, 'release', 'FDE Desk-win32-x64', 'data', 'store.json'), realBefore = await hashFile(realStore);
  const sourceBefore = await Promise.all(sources.map(hashFile)), memoBefore = memos.get(a.id);
  const checks = [], errors = [], network = [];
  let app, page, screenshot;
  const check = (condition, message) => { assert.ok(condition, message); checks.push(message); };
  async function eventually(predicate, message, timeout = 15000) {
    const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await pause(60); } throw new Error(message);
  }
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: dataDir, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
  const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.fde.request(action, payload), { action, payload });
  const current = async id => (await request('state')).projects.find(project => project.id === id);
  const protectedState = project => JSON.stringify({ id: project.id, sourceDir: project.sourceDir, files: project.files.filter(file => file.kind === '原始资料'), records: project.records, requirements: project.requirements, reports: project.reports, cycles: project.cycles, activeCycleId: project.activeCycleId, deliveries: project.deliveries });
  const controls = () => app.evaluate(() => ({ listCalls: globalThis.__fdeThreadSmoke.listCalls, readCalls: globalThis.__fdeThreadSmoke.readCalls, binds: globalThis.__fdeThreadSmoke.binds }));
  async function rejected(payload, pattern) {
    let error; try { await request('codex:bind', payload); } catch (caught) { error = caught; }
    assert.ok(error && pattern.test(error.message), '非法目录关联应在真实 main 端拒绝');
  }
  async function openBinding() { await page.locator('[data-action="bind-codex"]').first().click(); await page.locator('#form-dialog[open]').waitFor(); }
  async function closeBinding() { await page.locator('#modal-form [data-action="close-dialog"]').last().click(); await page.locator('#form-dialog:not([open])').waitFor({ state: 'attached' }); }
  async function submit() { await page.locator('#modal-form [type="submit"]').click(); }
  async function selectProject(id) {
    await page.locator('#project-select').selectOption(id);
    await eventually(async () => (await request('state')).settings.activeProjectId === id && await page.locator('#project-select').inputValue() === id, '项目未切换');
    await page.locator('[data-route="codex"]').first().click();
  }
  try {
    app = await electron.launch({ executablePath: EXECUTABLE, args: PORTABLE ? [] : [ROOT], env, timeout: 40000 }); await app.firstWindow();
    await eventually(async () => { page = app.windows().find(window => window.url().endsWith('/index.html')); return !!page; }, '工作台没有载入');
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    page.on('request', pending => { if (/^https?:/i.test(pending.url())) network.push(pending.url()); });
    await app.evaluate(({ app, BrowserWindow }, threads) => {
      const load = process.mainModule.require.bind(process.mainModule), nodePath = load('node:path');
      const reader = load(nodePath.join(app.getAppPath(), 'src/core/codex.cjs'));
      const { Store } = load(nodePath.join(app.getAppPath(), 'src/core/store.cjs'));
      const originalBind = Store.prototype.bindCodexThread;
      const mock = globalThis.__fdeThreadSmoke = { catalog: threads, listCalls: [], readCalls: [], binds: [] };
      const normalize = value => nodePath.resolve(value).toLowerCase();
      reader.listThreads = async input => { mock.listCalls.push(input || {}); return mock.catalog.filter(thread => !input?.cwd || normalize(thread.cwd) === normalize(input.cwd)).map(thread => ({ ...thread })); };
      reader.readThread = async input => {
        mock.readCalls.push({ threadId: input.threadId, cwd: input.cwd, history: !!input.history, date: input.date || '' });
        const thread = mock.catalog.find(value => value.id === input.threadId) || { id: input.threadId, cwd: input.cwd, title: '隔离已绑定会话' };
        return { thread, turns: [], discoveredDates: [], truncated: false, workTruncated: false, warning: '隔离元数据验收，无对话正文。', coverage: { mode: input.history ? 'history' : 'recent', sourceStamp: `${thread.id}:0`, scanComplete: true, retainedDates: [] } };
      };
      Store.prototype.bindCodexThread = function (id, input) { mock.binds.push({ id, input }); return originalBind.call(this, id, input); };
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().endsWith('/index.html')); window.show(); window.focus();
    }, catalog);
    await page.reload(); await page.waitForSelector('#project-select'); await page.locator('[data-route="codex"]').first().click();
    check((await request('state')).dataDir === dataDir && !(await request('state')).settings.summarizer.enabled, '验收使用独立项目数据、隔离 Codex 元数据和禁用模型');
    const original = await current(a.id), protectedBefore = protectedState(original), beforeDirectory = original.devDir;
    const list = await request('codex:list', { id: a.id });
    check(list.threads.length === 0 && list.candidates.length === 2 && list.candidates.some(thread => thread.id === 'a-main' && thread.relation === 'parent') && list.candidates.some(thread => thread.id === 'a-child' && thread.relation === 'child'), '误选样例目录时提供真实父子目录候选');
    check(!list.candidates.some(thread => thread.id === 'a-sibling'), '相似名称和兄弟项目不会进入候选列表');
    await openBinding();
    check(await page.locator('input[name="threadId"]:checked').count() === 0, '相关候选默认不勾选，需要主动选择');
    check((await page.locator('#codex-current-directory').innerText()).includes(a.devDir) && (await page.locator('#codex-candidate-notice').innerText()).includes('项目开发目录会改为所选会话目录'), '候选窗口明确显示当前目录及采用候选后的目录纠正');
    check((await page.locator('.thread-option').allTextContents()).every(text => text.includes('会话目录：')) && (await page.locator('#modal-form').innerText()).includes('会话在上 1 级目录') && (await page.locator('#modal-form').innerText()).includes('会话在下 1 级目录'), '每个候选都显示实际目录与上下级关系');
    await submit();
    await eventually(async () => (await page.locator('#form-error').innerText()).includes('请先选择一个会话'), '未选择候选没有提示');
    check((await current(a.id)).devDir === beforeDirectory && !(await current(a.id)).codex.threadId && (await controls()).binds.length === 0, '未选候选提交不修改目录或绑定');
    screenshot = path.join(output, PORTABLE ? '22-Codex目录候选-便携版.png' : '22-Codex目录候选-源码.png'); await page.screenshot({ path: screenshot });
    await closeBinding();
    check(protectedState(await current(a.id)) === protectedBefore && JSON.stringify(await request('memo:get', { id: a.id })) === JSON.stringify(memoBefore), '打开和取消候选窗口不改源资料、人工成果或备忘录');
    await rejected({ id: a.id, threadId: 'a-main' }, /不属于/);
    await rejected({ id: a.id, threadId: 'a-sibling', adoptCwd: true, cwd: roots[0] }, /推荐会话已变化/);
    check((await current(a.id)).devDir === beforeDirectory && !(await current(a.id)).codex.threadId, '真实主进程拒绝无纠正同意的相关会话及伪造兄弟会话');

    await openBinding(); await page.locator('input[name="threadId"][value="a-main"]').check();
    await app.evaluate(() => { globalThis.__fdeThreadSmoke.catalog = globalThis.__fdeThreadSmoke.catalog.filter(thread => thread.id !== 'a-main'); });
    await submit();
    await eventually(async () => (await page.locator('#form-error').innerText()).includes('推荐会话已变化'), '过期候选没有拒绝');
    check((await current(a.id)).devDir === beforeDirectory && !(await current(a.id)).codex.threadId && (await controls()).binds.length === 0, '选择后已失效的候选不会留下改目录的半状态');
    await closeBinding(); await app.evaluate((_, threads) => { globalThis.__fdeThreadSmoke.catalog = threads; }, catalog);
    await openBinding(); await page.locator('input[name="threadId"][value="a-main"]').check(); await submit();
    await eventually(async () => await page.locator('#form-dialog').getAttribute('open') === null && (await current(a.id)).codex.threadId === 'a-main', '显式候选关联没有完成');
    const corrected = await current(a.id), bindsAfterCorrection = (await controls()).binds;
    check(corrected.devDir === roots[0] && corrected.codex.threadId === 'a-main' && corrected.artifactDir === roots[0], '主动采用候选后开发目录与默认成果范围同步纠正并绑定该会话');
    check(bindsAfterCorrection.length === 1 && bindsAfterCorrection[0].input.devDir === roots[0], '纠正与绑定通过主进程单次存储操作完成');
    check(protectedState(corrected) === protectedBefore && JSON.stringify(await request('memo:get', { id: a.id })) === JSON.stringify(memoBefore), '目录纠正后原始资料用途、手工需求/记录/日报、项目周期及备忘录完整保留');
    check(corrected.files.some(file => file.path === path.join(roots[0], '仓库说明.md') && file.kind === '开发成果'), '目录纠正后真实重扫新仓库的开发成果');
    check((await request('codex:list', { id: a.id })).threads.some(thread => thread.id === 'a-main') && (await request('codex:list', { id: a.id })).candidates.length === 0, '纠正后会话成为精确匹配，关联候选提示不再出现');

    await selectProject(b.id); await openBinding();
    check(await page.locator('#codex-candidate-notice').count() === 0 && await page.locator('input[name="threadId"]:checked').getAttribute('value') === 'b-first', '原有精确目录流程正常，仍可默认选择首个匹配会话');
    await submit(); await eventually(async () => await page.locator('#form-dialog').getAttribute('open') === null && (await current(b.id)).codex.threadId === 'b-first', '精确会话没有绑定');
    check((await current(b.id)).devDir === b.devDir && (await controls()).binds.at(-1).input.devDir === undefined, '精确会话关联不改项目目录');
    await app.evaluate(() => { globalThis.__fdeThreadSmoke.catalog.sort((a, b) => a.id === 'b-second' ? -1 : b.id === 'b-second' ? 1 : 0); });
    await openBinding();
    check(await page.locator('input[name="threadId"]:checked').getAttribute('value') === 'b-first' && await page.locator('input[name="threadId"]').first().getAttribute('value') === 'b-second', '已有绑定优先选中当前会话，列表顺序变化不会静默切换');
    await closeBinding(); check((await current(b.id)).codex.threadId === 'b-first', '取消更换保持原已绑定会话');

    await selectProject(c.id); await openBinding();
    check(await page.locator('input[name="threadId"]:checked').count() === 0 && (await current(c.id)).codex.threadId === 'c-existing-missing', '已有会话缺失时相关候选仍不预选，也不自动清空或替换原绑定');
    await closeBinding(); await app.evaluate(() => { globalThis.__fdeThreadSmoke.catalog = globalThis.__fdeThreadSmoke.catalog.filter(thread => thread.id !== 'c-main'); });
    await openBinding();
    check(await page.locator('#modal-form [type="submit"]').isDisabled() && (await page.locator('#modal-form').innerText()).includes('仓库根目录'), '没有候选时提示核对仓库根目录并禁用关联');
    await closeBinding(); check((await current(c.id)).codex.threadId === 'c-existing-missing' && (await current(c.id)).devDir === c.devDir, '无候选和取消窗口均保留已有项目关联');
    check(JSON.stringify(await Promise.all(sources.map(hashFile))) === JSON.stringify(sourceBefore), '全部隔离原始资料文件保持原字节内容');
    check(errors.length === 0 && network.length === 0, '真实双窗 IPC 流程无渲染异常、无模型或其他网络请求');
    const boundaryCounts = await controls();
    await app.close(); app = null;
    const persisted = new Store(dataDir).getState().projects;
    check(persisted.find(project => project.id === a.id).devDir === roots[0] && persisted.find(project => project.id === a.id).codex.threadId === 'a-main' && persisted.find(project => project.id === b.id).codex.threadId === 'b-first' && persisted.find(project => project.id === c.id).codex.threadId === 'c-existing-missing', '关闭后重读磁盘保留正确目录和各项目绑定');
    check(JSON.stringify(memos.get(a.id)) === JSON.stringify(memoBefore), '独立备忘录文件在关联全过程保持不变');
    check(realBefore === await hashFile(realStore), '真实便携版 store.json SHA256 前后不变');
    const reportPath = path.join(output, PORTABLE ? 'Codex目录候选验收-便携版.json' : 'Codex目录候选验收-源码.json');
    const report = { status: 'passed', mode: PORTABLE ? 'portable' : 'source', checks, checkCount: checks.length, fixture, dataDir, screenshot, projectCount: projects.length, candidateCount: list.candidates.length, bindCount: boundaryCounts.binds.length, metadataReadCount: boundaryCounts.listCalls.length, isolatedEmptyReadCount: boundaryCounts.readCalls.length, realStoreUnchanged: true, boundary: '真实 main IPC、候选匹配、存储和 UI；仅 Codex reader 返回隔离元数据与空轮次。所有模型禁用，不读取真实聊天正文、密钥或客户资料，不操作真实管理数据。' };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, mode: report.mode, checkCount: checks.length, candidateCount: list.candidates.length, bindCount: report.bindCount, realStoreUnchanged: true, report: reportPath, screenshot, boundary: report.boundary }));
  } catch (error) {
    try { if (page && app) await page.screenshot({ path: path.join(output, PORTABLE ? '22-Codex目录候选失败-便携版.png' : '22-Codex目录候选失败-源码.png') }); } catch {}
    await fs.writeFile(path.join(output, PORTABLE ? 'Codex目录候选验收失败-便携版.json' : 'Codex目录候选验收失败-源码.json'), JSON.stringify({ status: 'failed', fixture, checks, error: error.message, rendererErrors: errors, realStoreUnchanged: realBefore === await hashFile(realStore) }, null, 2));
    throw error;
  } finally { if (app) await app.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

