'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateConfig, requiresApiKey } = require('../src/core/summarizer.cjs');

// Windows DPAPI is supplied by Electron. Secrets never enter store.json or UI state.
class ModelSettings {
  constructor({ dataDir, store, safeStorage }) {
    this.path = path.join(dataDir, 'model-key.encrypted');
    this.store = store;
    this.safeStorage = safeStorage;
  }
  config() {
    return validateConfig({ enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', ...this.store.getState().settings.summarizer });
  }
  _readSecret() {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护暂不可用，请重启软件后再试');
    try {
      return JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.path)));
    } catch { throw new Error('模型密钥无法解密，请在模型设置中重新填写'); }
  }
  _writeSecret(config, apiKey) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护暂不可用，密钥没有保存');
    const encrypted = this.safeStorage.encryptString(JSON.stringify({ baseUrl: config.baseUrl, provider: config.provider, apiKey }));
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.path); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  key(config = this.config()) {
    if (!fs.existsSync(this.path)) return '';
    const value = this._readSecret();
    const provider = value.provider || this.config().provider;
    return value.baseUrl === config.baseUrl && provider === config.provider && typeof value.apiKey === 'string' ? value.apiKey : '';
  }
  public() {
    const config = { ...this.config(), keyRequired: requiresApiKey(this.config()) };
    try { return { ...config, keyConfigured: !!this.key(config) }; }
    catch { return { ...config, keyConfigured: false, keyError: '模型密钥无法读取，请重新填写' }; }
  }
  save({ config, apiKey, clearKey = false } = {}) {
    const next = validateConfig(config);
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4000 || /[\r\n]/.test(apiKey))) throw new Error('API Key 格式不正确');
    const secret = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (secret) {
      this._writeSecret(next, secret);
    } else if (clearKey && fs.existsSync(this.path)) fs.unlinkSync(this.path);
    else if (fs.existsSync(this.path)) {
      // Bind old 0.2.0 encrypted files to their original protocol before changing settings.
      const previous = this._readSecret();
      if (!previous.provider && typeof previous.apiKey === 'string') this._writeSecret({ ...this.config(), baseUrl: previous.baseUrl }, previous.apiKey);
    }
    this.store.saveSummarizerSettings(next);
    return this.public();
  }
}
module.exports = { ModelSettings };
