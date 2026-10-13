'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateConfig, requiresApiKey } = require('../src/core/summarizer.cjs');

// The desktop supplies OS protection. Secrets never enter store.json or UI state.
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
    let bytes, value;
    try {
      bytes = fs.readFileSync(this.path);
      value = JSON.parse(this.safeStorage.decryptString(bytes));
      if (!value || typeof value.baseUrl !== 'string' || typeof value.apiKey !== 'string' || !value.apiKey.trim() || value.apiKey.length > 4000 || /[\r\n]/.test(value.apiKey)) throw new Error('无效密钥');
    } catch { throw new Error('已保存的模型密钥无法读取，自动恢复未成功；原文件已保留'); }
    if (this.safeStorage.shouldReEncrypt?.(bytes)) {
      const encrypted = this.safeStorage.encryptString(JSON.stringify({ ...value, provider: value.provider || this.config().provider }));
      // Preserve the original encrypted bytes before the one-time upgrade.
      const backup = this.path + '.legacy';
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, bytes, { flag: 'wx', mode: 0o600 });
      if (!fs.readFileSync(this.path).equals(bytes)) throw new Error('模型密钥正在其他窗口更新，请重试');
      this._persistEncrypted(encrypted);
    }
    return value;
  }
  _writeSecret(config, apiKey) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护暂不可用，密钥没有保存');
    const encrypted = this.safeStorage.encryptString(JSON.stringify({ baseUrl: config.baseUrl, provider: config.provider, apiKey }));
    this._persistEncrypted(encrypted);
  }
  _persistEncrypted(encrypted) {
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
    catch { return { ...config, keyConfigured: false, keyError: '已保存密钥，但读取失败；原文件已保留，请重启软件后重试' }; }
  }
  save({ config, apiKey, clearKey = false } = {}) {
    const next = validateConfig(config);
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4000 || /[\r\n]/.test(apiKey))) throw new Error('API Key 格式不正确');
    const secret = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (secret) {
      this._writeSecret(next, secret);
    } else if (clearKey) {
      for (const file of [this.path, this.path + '.legacy']) if (fs.existsSync(file)) fs.unlinkSync(file);
    }
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
