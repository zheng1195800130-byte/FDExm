'use strict';
// Real Windows DPAPI, synthetic credentials and an isolated archive only.
const fs = require('node:fs'), path = require('node:path');
const { randomBytes, createCipheriv } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { createModelSecretStorage, windowsDpapi, HEADER } = require('../desktop/model-secret-storage.cjs');
const { ModelSettings } = require('../desktop/model-settings.cjs');
const { Store } = require('../src/core/store.cjs');
const FAKE_KEY = 'fde-dpapi-regression-only';
const storage = dataDir => createModelSecretStorage({ dataDir, safeStorage: { decryptString() { throw new Error('Simulated different Chromium key'); } } });
function main() {
  if (process.platform !== 'win32') throw new Error('This verification requires Windows');
  if (process.argv[2] === '--verify') {
    const dataDir = process.argv[3], settings = new ModelSettings({ dataDir, store: new Store(dataDir), safeStorage: storage(dataDir) });
    assert.equal(settings.key(), FAKE_KEY); assert.equal(settings.public().keyConfigured, true);
    console.log('Independent normal process can read the protected key.'); return;
  }
  const out = path.resolve(__dirname, '../test-output'); fs.mkdirSync(out, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(out, '账户密钥保护-'));
  const store = new Store(dataDir), config = { enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
  store.saveSummarizerSettings(config);
  const value = JSON.stringify({ ...config, apiKey: FAKE_KEY });
  const master = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, iv);
  const legacy = Buffer.concat([Buffer.from('v10'), iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
  const context = path.join(dataDir, 'runtime', 'browser', 'Local State'); fs.mkdirSync(path.dirname(context), { recursive: true });
  fs.writeFileSync(context, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), windowsDpapi('protect', master)]).toString('base64') } })); master.fill(0);
  const settings = new ModelSettings({ dataDir, store, safeStorage: storage(dataDir) }); fs.writeFileSync(settings.path, legacy);
  assert.equal(settings.key(), FAKE_KEY); assert.deepEqual(fs.readFileSync(settings.path + '.legacy'), legacy);
  assert.ok(fs.readFileSync(settings.path).subarray(0, HEADER.length).equals(HEADER));
  assert.ok(!fs.readFileSync(settings.path).includes(Buffer.from(FAKE_KEY)));
  fs.renameSync(path.join(dataDir, 'runtime'), path.join(dataDir, 'old-runtime'));
  for (let i = 0; i < 2; i++) {
    const child = spawnSync(process.execPath, [__filename, '--verify', dataDir], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(child.status, 0, '普通子进程重启后密钥仍可读');
  }
  assert.ok(!JSON.stringify({ state: store.getState(), settings: settings.public() }).includes(FAKE_KEY));
  console.log(JSON.stringify({ status: 'passed', checks: 9, dataDir, networkRequests: 0, realDataAccessed: false }));
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
