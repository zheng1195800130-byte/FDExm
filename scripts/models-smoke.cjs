'use strict';

// Desktop contract tests use only loopback HTTP mocks and a separate data home.
// No real credentials, customer documents, or Codex sessions are read.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');
const FAKE_KEYS = ['fde-mock-list-key-a', 'fde-mock-list-key-b', 'fde-mock-list-key-native'];

async function hashFile(file) {
  try { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function run() {
  const out = path.join(ROOT, 'test-output');
  await fs.mkdir(out, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(out, '模型列表 中文 '));
  const dataDir = path.join(fixture, 'data');
  const sourceDir = path.join(fixture, '原始资料'), devDir = path.join(fixture, '开发目录'), home = path.join(fixture, '独立 Codex');
  await Promise.all([sourceDir, devDir, home].map(dir => fs.mkdir(dir, { recursive: true })));
  const seed = new Store(dataDir);
  const project = seed.createProject({ name: '模型列表验收', sourceDir, devDir });
  seed.setSettings({ activeProjectId: project.id });
  const realStore = path.join(ROOT, 'release', 'FDE Desk-win32-x64', 'data', 'store.json');
  const realBefore = await hashFile(realStore);
  const checks = [], requests = [];
  const check = (condition, description) => { assert.ok(condition, description); checks.push(description); };
  let app, page, slowResponse;
  const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, search: url.search, authorization: req.headers.authorization || '', nativeKey: req.headers['x-api-key'] || '', version: req.headers['anthropic-version'] || '', raw });
    if (req.method === 'GET' && url.pathname === '/a/v1/models') return json(res, { data: [
      { id: 'mock-alpha', name: 'Mock Alpha' }, { id: 'vendor/mock-beta', name: 'Mock Beta' },
      { id: 'mock-alpha' }, { id: '<invalid-id>', name: 'invalid' }
    ] });
    if (req.method === 'GET' && url.pathname === '/b/v1/models') return json(res, { data: [{ id: 'mock-b-model', name: 'Mock B' }] });
    if (req.method === 'GET' && url.pathname === '/slow/v1/models') { slowResponse = res; return; }
    if (req.method === 'GET' && url.pathname === '/error/v1/models') return json(res, { error: { message: `Do not display ${FAKE_KEYS[1]} or this provider body` } }, 401);
    if (req.method === 'GET' && url.pathname === '/echo/v1/models') {
      const escapedKey = [...FAKE_KEYS[1]].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'echo-only', name: FAKE_KEYS[1] }] }).replace(FAKE_KEYS[1], escapedKey));
    }
    if (req.method === 'GET' && url.pathname === '/native/v1/models') {
      return url.searchParams.has('after_id')
        ? json(res, { data: [{ id: 'claude-mock-next', display_name: 'Claude Mock Next', type: 'model' }], has_more: false })
        : json(res, { data: [{ id: 'claude-mock', display_name: 'Claude Mock', type: 'model' }], has_more: true, last_id: 'claude-mock' });
    }
    if (req.method === 'POST' && url.pathname === '/native/v1/messages') return json(res, { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' });
    return json(res, { error: { message: 'Unexpected test request' } }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: dataDir, CODEX_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  async function launch() {
    app = await electron.launch({ executablePath: EXECUTABLE, args: process.env.FDE_SMOKE_EXECUTABLE ? [] : [ROOT], env, timeout: 40000 });
    await app.firstWindow();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      page = app.windows().find(candidate => candidate.url().endsWith('/index.html'));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(page, '工作台窗口已加载');
    page.setDefaultTimeout(12000);
    await page.waitForFunction(() => !!window.fde);
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html')); window.show(); window.focus(); });
    await page.locator('[data-route="codex"]').first().click();
  }
  const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.fde.request(action, payload), { action, payload });
  const openSettings = () => page.locator('[data-action="model-settings"]').click();
  const setEndpoint = async (provider, suffix, model = '') => {
    await page.locator('#field-provider').selectOption(provider);
    await page.locator('#field-baseUrl').fill(base + suffix);
    // Let the base URL's change handler finish before typing a new secret.
    await page.locator('#field-model').fill(model);
  };
  const fetchModels = async () => {
    await page.locator('#fetch-models').click();
    await page.waitForFunction(() => !document.querySelector('#fetch-models')?.disabled);
  };
  const saveSettings = async () => {
    await page.locator('#modal-form [type="submit"]').click();
    await page.waitForSelector('#form-dialog:not([open])', { state: 'attached' });
  };
  const noFakeSecret = value => FAKE_KEYS.every(key => !String(value).includes(key));
  try {
    await launch();
    await openSettings();
    await setEndpoint('compatible', '/a/v1');
    await page.locator('#field-apiKey').fill(FAKE_KEYS[0]);
    await fetchModels();
    check(await page.locator('#field-availableModel option').count() === 2, '兼容接口 GET 模型列表去重并过滤无效 ID');
    check(requests.length === 1 && requests[0].method === 'GET' && requests[0].path === '/a/v1/models' && requests[0].authorization === `Bearer ${FAKE_KEYS[0]}`, 'GET 使用当前端点与暂存 Bearer 密钥');
    check(await page.locator('#field-model').inputValue() === '', '获取列表允许模型为空且不会自动选择');
    check(await page.locator('#field-apiKey').inputValue() === '', '获取列表后清空密码输入框');
    await page.locator('#model-list-filter').fill('beta');
    check(await page.locator('#field-availableModel option').count() === 1, '模型列表可按名称筛选');
    await page.locator('#model-list-filter').fill('mock');
    check(await page.locator('#field-availableModel option').count() === 2, '筛选后仍可选择多个匹配项');
    await page.locator('#field-availableModel').selectOption('vendor/mock-beta');
    check(await page.locator('#field-model').inputValue() === 'vendor/mock-beta' && await page.locator('#model-list-filter').inputValue() === 'vendor/mock-beta', '选择模型同时回填准确 ID 到名称和筛选框');
    check(await page.locator('#field-availableModel option').count() === 2, '选择回填不会立即缩减已有候选');
    await page.locator('#model-list-filter').fill('Beta');
    await page.locator('#field-availableModel option[value="vendor/mock-beta"]').click();
    check(await page.locator('#model-list-filter').inputValue() === 'vendor/mock-beta' && await page.locator('#field-model').inputValue() === 'vendor/mock-beta', '重复点击已选模型也会重新回填筛选框');
    await page.locator('#model-list-filter').fill('');
    check(await page.locator('#field-availableModel option').count() === 2, '清空筛选恢复完整候选');
    await page.locator('#field-availableModel').focus();
    await page.locator('#field-availableModel').press('Home');
    check(await page.locator('#field-model').inputValue() === 'mock-alpha' && await page.locator('#model-list-filter').inputValue() === 'mock-alpha', '键盘切换模型会同时回填两个输入框');
    await page.locator('#model-list-filter').fill('mock');
    await page.locator('#field-availableModel').focus();
    await page.locator('#field-availableModel').press('Enter');
    check(await page.locator('#model-list-filter').inputValue() === 'mock-alpha' && await page.locator('#form-dialog').getAttribute('open') !== null, 'Enter 确认当前模型且不会提交设置');
    await page.locator('#model-list-filter').fill('mock');
    await page.locator('#field-availableModel').focus();
    await page.locator('#field-availableModel').press('Space');
    check(await page.locator('#model-list-filter').inputValue() === 'mock-alpha', 'Space 确认当前模型并重新回填');
    await page.locator('#model-list-filter').fill('mock');
    await page.locator('#field-availableModel').selectOption('vendor/mock-beta');
    const uncommitted = await request('model:settings');
    check(uncommitted.baseUrl !== base + '/a/v1' && uncommitted.keyConfigured === false, '获取和选择模型不会自动保存设置或密钥');
    check(!await hashFile(path.join(dataDir, 'model-key.encrypted')), '未保存的密钥尚未写入加密文件');
    const screenshot = path.join(out, process.env.FDE_SMOKE_EXECUTABLE ? '12-模型列表选择-便携版.png' : '12-模型列表选择-源码.png');
    await page.locator('#field-availableModel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot });
    await saveSettings();
    let saved = await request('model:settings');
    check(saved.provider === 'compatible' && saved.baseUrl === base + '/a/v1' && saved.model === 'vendor/mock-beta' && saved.keyConfigured, '保存后才提交所选模型与密钥');
    check(noFakeSecret(JSON.stringify(await request('state'))) && noFakeSecret(await fs.readFile(path.join(dataDir, 'store.json'), 'utf8')), '公开状态和 store 不含密钥');
    const encrypted = await fs.readFile(path.join(dataDir, 'model-key.encrypted'));
    check(FAKE_KEYS.every(key => !encrypted.includes(Buffer.from(key))), '密钥仅以系统保护的加密内容落盘');

    await openSettings();
    await setEndpoint('compatible', '/b/v1', 'manual-b');
    const beforeB = requests.length;
    await fetchModels();
    const bRequests = requests.slice(beforeB);
    check(bRequests.length === 1 && !bRequests[0].authorization && !bRequests[0].nativeKey, '更换端点不会向新地址发送已保存的旧密钥');
    check(await page.locator('#field-model').inputValue() === 'manual-b', '本地免密钥获取列表保留手工模型');
    check((await request('model:settings')).baseUrl === base + '/a/v1', '未保存的新端点不改变已保存设置');
    await saveSettings();
    saved = await request('model:settings');
    check(saved.baseUrl === base + '/b/v1' && saved.keyConfigured === false, '保存新端点后公开状态不会沿用旧端点的密钥');
    await openSettings();

    await setEndpoint('compatible', '/slow/v1', 'manual-before');
    await page.locator('#field-apiKey').fill(FAKE_KEYS[1]);
    await page.locator('#fetch-models').click();
    const slowDeadline = Date.now() + 5000;
    while (!slowResponse && Date.now() < slowDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    check(!!slowResponse, '慢列表请求已到达本地服务');
    await setEndpoint('compatible', '/b/v1', 'manual-after');
    json(slowResponse, { data: [{ id: 'stale-only', name: 'Stale Response' }] }); slowResponse = null;
    await page.waitForFunction(() => !document.querySelector('#fetch-models')?.disabled);
    check(await page.locator('#field-model').inputValue() === 'manual-after' && await page.locator('#field-availableModel option').count() === 0, '端点切换后的迟到响应不会污染新设置或模型列表');
    const afterSlow = requests.length;
    await fetchModels();
    check(requests.length === afterSlow + 1 && !requests.at(-1).authorization, '切换端点清除尚未保存的暂存密钥');

    await setEndpoint('compatible', '/error/v1', 'manual-error-model');
    await page.locator('#field-apiKey').fill(FAKE_KEYS[1]);
    await fetchModels();
    const errorText = await page.locator('#model-list-status').innerText();
    check(await page.locator('#field-model').inputValue() === 'manual-error-model' && /直接填写/.test(errorText), '列表失败时保留手工名称并提供继续填写提示');
    check(noFakeSecret(errorText) && !errorText.includes('provider body'), '远程错误正文及密钥不进入界面');
    await setEndpoint('compatible', '/echo/v1', 'manual-echo-model');
    await page.locator('#field-apiKey').fill(FAKE_KEYS[1]);
    await fetchModels();
    check(noFakeSecret(await page.locator('#modal-form').innerText()) && await page.locator('#field-availableModel option').count() === 0, '模型列表 JSON 转义后的密钥回显也会被拒绝');
    check(await page.locator('#field-model').inputValue() === 'manual-echo-model', '拒绝敏感模型列表时保留手工名称');
    await page.locator('#field-servicePreset').selectOption('moonshot');
    check(await page.locator('#field-model').inputValue() === '' && await page.locator('#field-apiKey').inputValue() === '' && await page.locator('#field-availableModel option').count() === 0, '切换服务预设清除旧模型候选和暂存密钥');

    await setEndpoint('anthropic', '/native/v1');
    await page.locator('#field-apiKey').fill(FAKE_KEYS[2]);
    const nativeStart = requests.length;
    await fetchModels();
    check(await page.locator('#field-availableModel option').count() === 2, 'Anthropic 原生模型列表支持分页与显示名称');
    const nativeList = requests.slice(nativeStart);
    check(nativeList.length === 2 && nativeList.every(item => item.method === 'GET' && item.path === '/native/v1/models' && !item.authorization && item.nativeKey === FAKE_KEYS[2] && item.version === '2023-06-01') && nativeList[1].search.includes('after_id=claude-mock'), 'Anthropic GET 使用原生认证头且分页始终留在原端点');
    await page.locator('#field-availableModel').selectOption('claude-mock');
    check((await request('model:settings')).provider === 'compatible', '选择原生模型同样不会自动保存');
    await page.locator('[data-action="test-model"]').click();
    await page.waitForFunction(() => /连接成功|连接正常/.test(document.querySelector('#model-key-status')?.textContent || ''));
    const nativeChat = requests.at(-1), payload = JSON.parse(nativeChat.raw);
    check(nativeChat.method === 'POST' && nativeChat.path === '/native/v1/messages' && !nativeChat.authorization && nativeChat.nativeKey === FAKE_KEYS[2] && nativeChat.version === '2023-06-01' && payload.model === 'claude-mock' && typeof payload.system === 'string' && !payload.response_format, '所选 Anthropic 模型测试连接使用原生 messages 请求');
    await saveSettings();
    saved = await request('model:settings');
    check(saved.provider === 'anthropic' && saved.model === 'claude-mock' && saved.keyConfigured, '原生模型与协议保存成功');
    check(noFakeSecret(JSON.stringify(await request('state'))) && noFakeSecret(await fs.readFile(path.join(dataDir, 'store.json'), 'utf8')), '原生密钥不会进入公开状态或项目存储');
    const mdFiles = [];
    async function collectMarkdown(dir) {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (item.name === 'runtime') continue;
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await collectMarkdown(file);
        else if (item.name.endsWith('.md')) mdFiles.push(file);
      }
    }
    await collectMarkdown(dataDir);
    for (const file of mdFiles) check(noFakeSecret(await fs.readFile(file, 'utf8')), '管理 Markdown 不含密钥');
    const beforeRestart = requests.length;
    await app.close(); app = null;
    await launch();
    const afterRestart = await request('model:settings');
    check(afterRestart.provider === 'anthropic' && afterRestart.model === 'claude-mock' && afterRestart.keyConfigured, '重启后模型与加密密钥配置保留');
    await openSettings();
    check(await page.locator('#field-apiKey').inputValue() === '' && requests.length === beforeRestart, '重启后密钥不回显且没有自动认证请求');
    const realAfter = await hashFile(realStore);
    check(realBefore === realAfter, '真实便携版 store 文件保持不变');
    const report = { status: 'passed', mode: process.env.FDE_SMOKE_EXECUTABLE ? 'portable' : 'source', checks, requestCount: requests.length, listRequestCount: requests.filter(item => item.method === 'GET').length, nativeRequestCount: requests.filter(item => item.path.startsWith('/native/')).length, modelIds: ['vendor/mock-beta', 'claude-mock'], fixture, screenshot, realStoreUnchanged: realBefore === realAfter, service: '本机 HTTP mock；没有读取真实密钥或调用真实模型服务' };
    const reportPath = path.join(out, process.env.FDE_SMOKE_EXECUTABLE ? '模型列表验收-便携版.json' : '模型列表验收-源码.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, mode: report.mode, checkCount: checks.length, requestCount: requests.length, realStoreUnchanged: report.realStoreUnchanged, report: reportPath, screenshot, service: report.service }));
  } finally {
    if (slowResponse && !slowResponse.writableEnded) slowResponse.end();
    if (app) await app.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
