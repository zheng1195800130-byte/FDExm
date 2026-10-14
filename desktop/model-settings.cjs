'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateConfig, requiresApiKey } = require('../src/core/summarizer.cjs');

// The desktop supplies OS protection. Secrets never enter store.json or UI state.
class ModelSettings {
  constructor({ dataDir, store, safeStorage }) {
    this.path = path.join(dataDir, 'model-key.encrypted');
    this.backupPath = this.path + '.backup';
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
      bytes = fs.readFileSync(fs.existsSync(this.path) ? this.path : this.backupPath);
      value = JSON.parse(this.safeStorage.decryptString(bytes));
      const entries=this._entries(value);
      if(!entries.length||entries.length>32||entries.some(entry=>typeof entry.baseUrl!=='string'||!entry.baseUrl||typeof entry.provider!=='string'||typeof entry.apiKey!=='string'||!entry.apiKey.trim()||entry.apiKey.length>4000||/[\r\n]/.test(entry.apiKey)))throw new Error('无效密钥');
    } catch { throw new Error('已保存的模型密钥无法读取，自动恢复未成功；原文件已保留'); }
    if (this.safeStorage.shouldReEncrypt?.(bytes)) {
      const encrypted = this.safeStorage.encryptString(JSON.stringify({ ...value, provider: value.provider || this.config().provider }));
      // Preserve the original encrypted bytes before the one-time upgrade.
      const backup = this.path + '.legacy';
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, bytes, { flag: 'wx', mode: 0o600 });
      if (fs.existsSync(this.path)&&!fs.readFileSync(this.path).equals(bytes)) throw new Error('模型密钥正在其他窗口更新，请重试');
      this._persistEncrypted(encrypted);
    }
    else if(!fs.existsSync(this.path))this._persistEncrypted(bytes);
    else if(!fs.existsSync(this.backupPath)){try{this._atomicEncrypted(this.backupPath,bytes);}catch{/* A backup failure must not hide a readable key. */}}
    return value;
  }
  _entries(value) { return value?.version===2&&Array.isArray(value.entries)?value.entries:value?[{...value,provider:value.provider||this.config().provider}]:[]; }
  _matches(entry,config) { return entry.provider===config.provider&&entry.baseUrl===config.baseUrl; }
  _writeEntries(entries) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护暂不可用，密钥没有保存');
    if(entries.length>32)throw new Error('已保存接口数量达到上限，请先清除不用的接口密钥');
    const encrypted = this.safeStorage.encryptString(JSON.stringify({ version:2,entries,savedAt:new Date().toISOString() }));
    this._persistEncrypted(encrypted);
  }
  _persistEncrypted(encrypted) {
    this._atomicEncrypted(this.path,encrypted);
    this._atomicEncrypted(this.backupPath,encrypted);
  }
  _atomicEncrypted(file,encrypted) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  key(config = this.config()) {
    if (!fs.existsSync(this.path)&&!fs.existsSync(this.backupPath)) return '';
    const value = this._readSecret();
    return this._entries(value).find(entry=>this._matches(entry,config))?.apiKey||'';
  }
  public() {
    const config = { ...this.config(), keyRequired: requiresApiKey(this.config()) };
    try {
      const value=fs.existsSync(this.path)||fs.existsSync(this.backupPath)?this._readSecret():null;
      const keyConfigured=!!this._entries(value).find(entry=>this._matches(entry,config))?.apiKey;
      const savedAt=typeof value?.savedAt==='string'&&Number.isFinite(Date.parse(value.savedAt))?value.savedAt:'';
      return { ...config,keyConfigured,keyStatus:keyConfigured?'ready':fs.existsSync(this.path)?'other-service':'missing',savedAt };
    }
    catch { return { ...config, keyConfigured: false,keyStatus:'unreadable', keyError: '已保存密钥，但读取失败；原文件已保留，请重启软件后重试' }; }
  }
  save({ config, apiKey, clearKey = false } = {}) {
    const next = validateConfig(config);
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4000 || /[\r\n]/.test(apiKey))) throw new Error('API Key 格式不正确');
    const secret = typeof apiKey === 'string' ? apiKey.trim() : '';
    const entries=fs.existsSync(this.path)||fs.existsSync(this.backupPath)?this._entries(this._readSecret()):[];
    const expectedKey=secret||(clearKey?'':entries.find(entry=>this._matches(entry,next))?.apiKey||'');
    const files=[this.path,this.backupPath,this.path+'.legacy'],snapshot=files.map(file=>fs.existsSync(file)?fs.readFileSync(file):null);
    try{
      if(secret)this._writeEntries([...entries.filter(entry=>!this._matches(entry,next)),{baseUrl:next.baseUrl,provider:next.provider,apiKey:secret}]);
      else if(clearKey){const remaining=entries.filter(entry=>!this._matches(entry,next));if(remaining.length)this._writeEntries(remaining);else for(const file of files)if(fs.existsSync(file))fs.unlinkSync(file);}
      // Bind legacy files before changing protocol, and keep a recovery copy.
      else if(entries.length)this._writeEntries(entries);
      // Verify the persisted bytes before committing the selected endpoint.
      // A successful connection test uses a temporary key and is not a save.
      if(this.key(next)!==expectedKey)throw new Error('模型密钥保存后回读不一致，原配置已保留，请重试保存');
      if(fs.existsSync(this.path)&&(!fs.existsSync(this.backupPath)||!fs.readFileSync(this.path).equals(fs.readFileSync(this.backupPath))))throw new Error('模型密钥备份校验失败，原配置已保留，请重试保存');
      this.store.saveSummarizerSettings(next);
    }catch(error){for(let index=0;index<files.length;index++){if(snapshot[index])this._atomicEncrypted(files[index],snapshot[index]);else if(fs.existsSync(files[index]))fs.unlinkSync(files[index]);}throw error;}
    return this.public();
  }
}
module.exports = { ModelSettings };
