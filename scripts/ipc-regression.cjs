'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const EXPECT_BUG = process.env.FDE_EXPECT_ORIGIN_BUG === '1';
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');

async function run() {
  const out = path.join(ROOT, 'test-output');
  await fs.mkdir(out, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(out, 'IPC 回归-'));
  const sourceDir = path.join(fixture, '原始资料 目录');
  const devDir = path.join(fixture, '开发项目 目录');
  const codexHome = path.join(fixture, '独立 Codex');
  await Promise.all([sourceDir, devDir, codexHome].map(dir => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(sourceDir, '测试业务说明.md'), '# 测试资料\n用于目录选择回归，不包含客户资料。');
  let appDir = ROOT;
  if (!process.env.FDE_SMOKE_EXECUTABLE) {
    // Exercise actual file:// URL encoding by launching a small source copy.
    // Production modules resolve from the parent project's node_modules.
    appDir = path.join(fixture, '应用 中文 空格');
    await fs.mkdir(appDir);
    await Promise.all(['desktop', 'src', 'assets', 'package.json'].map(name => fs.cp(path.join(ROOT, name), path.join(appDir, name), { recursive: true })));
    // Browser ESM imports use explicit paths rather than Node's parent lookup.
    await fs.mkdir(path.join(appDir, 'node_modules'));
    await Promise.all(['marked', 'dompurify'].map(name => fs.cp(path.join(ROOT, 'node_modules', name), path.join(appDir, 'node_modules', name), { recursive: true })));
  }
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: path.join(fixture, '独立 数据'), CODEX_HOME: codexHome };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const checks = [];
  try {
    app = await electron.launch({ executablePath: EXECUTABLE, args: process.env.FDE_SMOKE_EXECUTABLE ? [] : [appDir], env, timeout: 40000 });
    await app.firstWindow();
    const deadline = Date.now() + 12000;
    let page;
    while (!page && Date.now() < deadline) {
      page = app.windows().find(candidate => candidate.url().endsWith('/index.html'));
      if (!page) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(page, '工作台窗口已加载');
    page.setDefaultTimeout(12000);
    const mainId = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
      win.show(); win.focus();
      return win.id;
    });
    await page.waitForSelector('[data-action="new-project"]');
    const request = (action, payload = {}) => page.evaluate(async ({ action, payload }) => {
      try { return { ok: true, value: await window.fde.request(action, payload) }; }
      catch (error) { return { ok: false, error: error.message }; }
    }, { action, payload });
    assert.equal((await request('state')).ok, true, '初始页面来源可用');
    const initialURL = page.url();
    await page.locator('.brand').click();
    if (EXPECT_BUG) {
      await page.waitForFunction(() => location.hash === '#overview');
      const rejected = await request('state');
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error, '不允许的页面来源');
      console.log(JSON.stringify({ mode: '修复前复现', result: '已复现：点击品牌后 #overview 导致正常 state 请求被拒绝', originError: rejected.error, encodedPath: /%20/.test(initialURL) && /%E/i.test(initialURL), fixture }, null, 2));
      return;
    }
    assert.equal(page.url(), initialURL, '品牌导航不改变页面 URL');
    checks.push('品牌点击不改变页面 URL');
    await page.evaluate(() => { location.hash = '#overview'; });
    assert.equal((await request('state')).ok, true, '同文档锚点仍允许正常 IPC');
    checks.push('含中文、空格的页面路径及 #overview 锚点正常调用 IPC');

    await app.evaluate(({ dialog }, paths) => {
      globalThis.__fdeDirectoryRegressionCalls = [];
      dialog.showOpenDialog = async (_owner, options) => {
        const index = globalThis.__fdeDirectoryRegressionCalls.length;
        globalThis.__fdeDirectoryRegressionCalls.push({ title: options.title, properties: options.properties });
        return { canceled: false, filePaths: [paths[index]] };
      };
    }, [sourceDir, devDir]);
    await page.locator('[data-action="new-project"]').click();
    await page.locator('[name="name"]').fill('目录选择回归项目');
    await page.locator('[data-action="choose-directory"][data-field="sourceDir"]').click();
    await page.waitForFunction(value => document.querySelector('[name="sourceDir"]').value === value, sourceDir);
    await page.locator('[data-action="choose-directory"][data-field="devDir"]').click();
    await page.waitForFunction(value => document.querySelector('[name="devDir"]').value === value, devDir);
    const calls = await app.evaluate(() => globalThis.__fdeDirectoryRegressionCalls);
    assert.equal(calls.length, 2, '两个目录按钮分别调用原生选择接口');
    assert.ok(calls.every(call => call.properties.includes('openDirectory')));
    await page.locator('#form-dialog button[type="submit"]').click();
    await page.waitForSelector('#form-dialog:not([open])', { state: 'attached' });
    const afterSave = await request('state');
    assert.equal(afterSave.ok, true);
    assert.equal(afterSave.value.projects.length, 1);
    assert.equal(afterSave.value.projects[0].sourceDir, sourceDir);
    assert.equal(afterSave.value.projects[0].devDir, devDir);
    checks.push('真实点击两个目录按钮并回填路径、保存项目；原生对话框返回值使用 mock，调用 2 次');
    await page.locator('[data-route="files"]').click();
    await page.locator('.brand').click();
    assert.equal(await page.locator('#navigation [aria-current="page"]').getAttribute('data-route'), 'overview');
    checks.push('资料库点击品牌后返回项目概览');

    const runningRoot = await app.evaluate(({ app }) => app.getAppPath());
    const runningPaths = {
      preload: path.join(runningRoot, 'desktop/preload.cjs'),
      index: path.join(runningRoot, 'src/ui/index.html'),
      other: path.join(runningRoot, 'src/ui/float.html')
    };
    const extraWindow = await app.evaluate(async ({ BrowserWindow }, paths) => {
      const win = new BrowserWindow({ show: false, webPreferences: { preload: paths.preload, nodeIntegration: false, contextIsolation: true, sandbox: true } });
      try {
        await win.loadFile(paths.index);
        return await win.webContents.executeJavaScript("window.fde.request('state').then(() => ({ok:true}), error => ({ok:false,error:error.message}))");
      } finally { win.destroy(); }
    }, runningPaths);
    assert.equal(extraWindow.ok, false, '未注册窗口即使加载相同页面也拒绝 IPC');
    assert.equal(extraWindow.error, '不允许的页面来源');
    checks.push('额外非受信窗口加载同一 index.html 仍被拒绝');

    // Navigate the registered main window to exercise page/path restrictions.
    // Electron loadURL is a host-side operation and deliberately bypasses will-navigate.
    const navigateMain = async (kind) => {
      await app.evaluate(async ({ BrowserWindow }, { mainId, kind, index, other, query }) => {
        const win = BrowserWindow.fromId(mainId);
        if (kind === 'query') await win.loadURL(query);
        else await win.loadFile(kind === 'other' ? other : index);
      }, { mainId, kind, ...runningPaths, query: pathToFileURL(runningPaths.index).href + '?unexpected=1' });
      await page.waitForFunction(() => !!window.fde);
    };
    await navigateMain('query');
    const queryRequest = await request('state');
    assert.equal(queryRequest.ok, false);
    assert.equal(queryRequest.error, '不允许的页面来源');
    checks.push('受信窗口附带意外查询参数时拒绝 IPC');
    await navigateMain('other');
    const otherFile = await request('state');
    assert.equal(otherFile.ok, false);
    assert.equal(otherFile.error, '不允许的页面来源');
    checks.push('工作台窗口加载其他应用页面时拒绝 IPC');
    await navigateMain('index');
    assert.equal((await request('state')).ok, true, '恢复合法主页面后正常');
    console.log(JSON.stringify({ mode: process.env.FDE_SMOKE_EXECUTABLE ? '便携版回归' : '源码回归', result: '通过', checks, fixture, nativeDialog: '原生对话框边界已 mock 返回值；验证实际 renderer → preload → IPC → dialog 调用及回填保存。未自动操作系统原生选择器。' }, null, 2));
  } finally { if (app) await app.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
