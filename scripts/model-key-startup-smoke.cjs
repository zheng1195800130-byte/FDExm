'use strict';
// Launch the packaged EXE normally, without Playwright's main-process debugger.
// CDP only reads the renderer's public IPC, using synthetic local credentials.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes, createCipheriv } = require('node:crypto');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');
const { windowsDpapi, HEADER } = require('../desktop/model-secret-storage.cjs');
async function main() {
  const executable = process.env.FDE_SMOKE_EXECUTABLE;
  assert.ok(executable, '请用 FDE_SMOKE_EXECUTABLE 指定隔离验收的打包程序');
  const out = path.resolve(__dirname, '../test-output'); fs.mkdirSync(out, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(out, '普通启动密钥-'));
  const local = path.join(fixture, 'local'), dataDir = path.join(local, 'FDE Desk', 'data');
  const home = path.join(fixture, 'codex'); fs.mkdirSync(home);
  const key = 'fde-normal-startup-mock-key'; let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    const ok = req.url === '/v1/models' && req.headers.authorization === `Bearer ${key}` || req.url === '/other/v1/models' && req.headers.authorization === 'Bearer fde-other-startup-mock-key';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { data: [{ id: 'normal-mock-model' }] } : { error: { message: 'Mock authentication failed' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let child, browser;
  try {
  const config = { enabled: true, provider: 'compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'normal-mock-model' };
  new Store(dataDir).saveSummarizerSettings(config);
  const master = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, iv);
  const legacy = Buffer.concat([Buffer.from('v10'), iv, cipher.update(JSON.stringify({ ...config, apiKey: key })), cipher.final(), cipher.getAuthTag()]);
  const localState = path.join(dataDir, 'runtime', 'browser', 'Local State'); fs.mkdirSync(path.dirname(localState), { recursive: true });
  fs.writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), windowsDpapi('protect', master)]).toString('base64') } })); master.fill(0);
  const keyFile = path.join(dataDir, 'model-key.encrypted'); fs.writeFileSync(keyFile, legacy);
  const env = { ...process.env, LOCALAPPDATA: local, CODEX_HOME: home, FDE_TEST: '1' }; delete env.FDE_DATA_DIR; delete env.ELECTRON_RUN_AS_NODE;
    for (let launch = 0; launch < 2; launch++) {
      child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdout.resume();
      const endpoint = await new Promise((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => reject(new Error('普通启动未提供本机调试端点')), 20000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.stderr.on('data', chunk => {
          stderr += chunk;
          const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
          if (match) { clearTimeout(timer); resolve(match[1]); }
        });
      });
      browser = await chromium.connectOverCDP(endpoint);
      let page;
      for (let retry = 0; retry < 100; retry++) {
        page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().endsWith('/index.html'));
        if (page) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(page, '普通启动完成加载'); await page.waitForFunction(() => !!window.fde);
      const settings = await page.evaluate(() => window.fde.request('model:settings'));
      assert.equal(settings.keyConfigured, true); assert.ok(!settings.keyError);
      await page.evaluate(() => window.fde.request('model:list'));
      assert.equal(requests, launch + 1, '普通进程使用恢复后的同一密钥请求本机模拟服务');
      const other={...config,baseUrl:config.baseUrl.replace('/v1','/other/v1')};
      if(launch===0){
        await page.evaluate(input=>window.fde.request('model:save',{config:input,apiKey:'fde-other-startup-mock-key'}),other);
        await page.evaluate(input=>window.fde.request('model:save',{config:input}),config);
      }else{
        await page.evaluate(input=>window.fde.request('model:list',{config:input}),other);
        assert.equal(requests,3,'普通重启后另一接口的密钥也仍可使用');
        assert.ok(fs.existsSync(keyFile+'.backup'));
      }
      await page.evaluate(() => window.fde.windowAction('quit')).catch(() => {});
      await exited; child = null; await browser.close(); browser = null;
      assert.ok(fs.readFileSync(keyFile).subarray(0, HEADER.length).equals(HEADER));
      assert.deepEqual(fs.readFileSync(keyFile + '.legacy'), legacy);
      for (const relative of ['runtime/browser/Local State', 'runtime/Local State']) fs.rmSync(path.join(dataDir, relative), { force: true });
    }
    const report = { status: 'passed', checks: 14, launches: 2, requestCount: requests, fixture, mainProcessDebugger: false, realDataAccessed: false, service: '本机模拟服务；无真实密钥或外部模型请求' };
    fs.writeFileSync(path.join(out, '普通启动密钥验收.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child && child.exitCode === null) child.kill();
    server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
