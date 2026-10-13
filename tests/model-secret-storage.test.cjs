'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createCipheriv } = require('node:crypto');
const { createModelSecretStorage, HEADER } = require('../desktop/model-secret-storage.cjs');
const { ModelSettings } = require('../desktop/model-settings.cjs');
const { Store } = require('../src/core/store.cjs');
const config = { enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
const secret = { baseUrl: config.baseUrl, provider: config.provider, apiKey: 'mock-recovery-key' };
function fixture(t) {
  const base = path.resolve(__dirname, '../.test-tmp'); fs.mkdirSync(base, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(base, 'key-recovery-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir); store.saveSummarizerSettings(config);
  return { dataDir, store };
}
const dpapi = (operation, bytes) => Buffer.from(bytes).map(value => value ^ 173);
function legacy(dataDir, value = secret, master = randomBytes(32), relative = 'runtime/browser/Local State') {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, iv);
  const bytes = Buffer.concat([Buffer.from('v10'), iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  const file = path.join(dataDir, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), dpapi('protect', master)]).toString('base64') } }));
  return bytes;
}
const unavailable = { decryptString() { throw new Error('Wrong in-memory Chromium key'); } };
const adapter = (dataDir, options = {}) => createModelSecretStorage({ dataDir, safeStorage: unavailable, platform: 'win32', dpapi, ...options });

test('Windows 原生密钥保护不依赖 Electron，缓存按密文字节失效', t => {
  const { dataDir } = fixture(t); let decrypts = 0;
  const storage = adapter(dataDir, { dpapi(operation, bytes) { if (operation === 'unprotect') decrypts++; return dpapi(operation, bytes); } });
  const first = storage.encryptString('mock-first');
  assert.ok(first.subarray(0, HEADER.length).equals(HEADER));
  assert.ok(!first.includes(Buffer.from('mock-first')));
  assert.equal(storage.decryptString(first), 'mock-first'); assert.equal(decrypts, 0);
  const next = adapter(dataDir).encryptString('mock-next');
  assert.equal(storage.decryptString(next), 'mock-next'); assert.equal(decrypts, 1);
  assert.equal(storage.decryptString(Buffer.from(next)), 'mock-next'); assert.equal(decrypts, 1);
  assert.equal(adapter(dataDir).decryptString(first), 'mock-first');
});
test('Electron 内存密钥不匹配时用同档案加密环境恢复，自动升级并保留原密文', t => {
  const { dataDir, store } = fixture(t), bytes = legacy(dataDir);
  const settings = new ModelSettings({ dataDir, store, safeStorage: adapter(dataDir) });
  fs.writeFileSync(settings.path, bytes);
  assert.equal(settings.public().keyConfigured, true);
  assert.equal(settings.key(), secret.apiKey);
  assert.deepEqual(fs.readFileSync(settings.path + '.legacy'), bytes);
  assert.ok(fs.readFileSync(settings.path).subarray(0, HEADER.length).equals(HEADER));
  assert.doesNotMatch(JSON.stringify({ public: settings.public(), state: store.getState() }), /mock-recovery-key/);
  fs.renameSync(path.join(dataDir, 'runtime'), path.join(dataDir, 'old-runtime'));
  const restart = new ModelSettings({ dataDir, store: new Store(dataDir), safeStorage: adapter(dataDir) });
  assert.equal(restart.key(), secret.apiKey, '后续启动不依赖浏览器运行目录');
  restart.save({ config, clearKey: true });
  assert.equal(fs.existsSync(settings.path), false); assert.equal(fs.existsSync(settings.path + '.legacy'), false);
});
test('浏览器环境不匹配时尝试另一受支持位置，GCM 校验错误密钥', t => {
  const { dataDir } = fixture(t);
  legacy(dataDir); const bytes = legacy(dataDir, secret, randomBytes(32), 'runtime/Local State');
  assert.deepEqual(JSON.parse(adapter(dataDir).decryptString(bytes)), secret);
});
test('损坏密文不会恢复成功、覆盖原文件或生成迁移备份', t => {
  const { dataDir, store } = fixture(t), bytes = legacy(dataDir); bytes[18] ^= 1;
  const settings = new ModelSettings({ dataDir, store, safeStorage: adapter(dataDir) });
  fs.writeFileSync(settings.path, bytes);
  assert.throws(() => settings.key(), /自动恢复未成功/);
  assert.equal(settings.public().keyConfigured, false);
  assert.deepEqual(fs.readFileSync(settings.path), bytes);
  assert.equal(fs.existsSync(settings.path + '.legacy'), false);
});
test('Windows 账户解密失败时保留原生密钥，不回退明文或生成空配置', t => {
  const { dataDir, store } = fixture(t), bytes = adapter(dataDir).encryptString(JSON.stringify(secret));
  const storage = adapter(dataDir, { dpapi() { throw new Error('Different Windows user'); } });
  const settings = new ModelSettings({ dataDir, store, safeStorage: storage }); fs.writeFileSync(settings.path, bytes);
  assert.throws(() => settings.key(), /原文件已保留/);
  assert.deepEqual(fs.readFileSync(settings.path), bytes);
});
test('升级加密失败保留可恢复的旧密文，恢复后再升级', t => {
  const { dataDir, store } = fixture(t), bytes = legacy(dataDir);
  const storage = adapter(dataDir, { dpapi(operation, bytes) { if (operation === 'protect') throw new Error('Protection unavailable'); return dpapi(operation, bytes); } });
  const settings = new ModelSettings({ dataDir, store, safeStorage: storage }); fs.writeFileSync(settings.path, bytes);
  assert.throws(() => settings.key(), /Protection unavailable/);
  assert.deepEqual(fs.readFileSync(settings.path), bytes);
  assert.equal(new ModelSettings({ dataDir, store, safeStorage: adapter(dataDir) }).key(), secret.apiKey);
});
test('升级旧协议密钥后仍按端点隔离，留空保存与切回保留密钥', t => {
  const { dataDir, store } = fixture(t), bytes = legacy(dataDir, { baseUrl: config.baseUrl, apiKey: secret.apiKey });
  const settings = new ModelSettings({ dataDir, store, safeStorage: adapter(dataDir) }); fs.writeFileSync(settings.path, bytes);
  settings.save({ config: { ...config, provider: 'compatible' } });
  assert.equal(settings.public().keyConfigured, false);
  settings.save({ config }); assert.equal(settings.key(), secret.apiKey);
  settings.save({ config: { ...config, baseUrl: 'https://other.test/v1' } });
  assert.equal(settings.key(), '');
});
test('非 Windows 平台保留原来的系统保护接口', () => {
  assert.equal(createModelSecretStorage({ platform: 'linux', safeStorage: unavailable }), unavailable);
});
