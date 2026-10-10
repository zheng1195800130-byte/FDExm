'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const MAX_RULE_CHARS = 16000;
const MAX_RULE_BYTES = 64 * 1024;
// Only exact normalized defaults shipped by previous versions may auto-upgrade.
const LEGACY_DEFAULT_HASHES = new Set(['3ff8785ea78c6e28a3e726458a79989ee0aeacc4f0f665c9b95e120d8ef748d3']);

function normalizeRules(value) {
  if (typeof value !== 'string') throw new Error('整理规则必须是文字');
  if (value.includes('\u0000')) throw new Error('整理规则不能包含空字符');
  if (value.length > MAX_RULE_CHARS || Buffer.byteLength(value, 'utf8') > MAX_RULE_BYTES) throw new Error('整理规则过长，请控制在 16000 字符和 64 KiB 以内');
  const text = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('整理规则不能为空');
  return text;
}

const DEFAULT_RULES = normalizeRules(fs.readFileSync(path.join(__dirname, 'summary-rules.md'), 'utf8'));

class SummaryRules {
  constructor({ dataDir } = {}) {
    if (typeof dataDir !== 'string' || !dataDir || dataDir.length > 4000 || dataDir.includes('\u0000')) throw new Error('整理规则保存目录无效');
    try {
      const resolved = path.resolve(dataDir);
      fs.mkdirSync(resolved, { recursive: true });
      const stat = fs.lstatSync(resolved);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid directory');
      this.dataDir = fs.realpathSync(resolved);
      this.path = path.join(this.dataDir, '整理规则.md');
      this._ensureDefault();
      this._upgradeDefault();
    } catch (error) {
      if (error.message?.startsWith('整理规则')) throw error;
      throw new Error('整理规则目录无法访问，请检查管理目录');
    }
  }

  _fileStat({ allowMissing = false, checkSize = true } = {}) {
    let stat;
    try { stat = fs.lstatSync(this.path); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw new Error('整理规则文件无法读取，请检查文件是否存在及访问权限'); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('整理规则必须是普通文件，不能使用目录或链接');
    if (checkSize && stat.size > MAX_RULE_BYTES) throw new Error('整理规则文件过大，请控制在 64 KiB 以内');
    return stat;
  }

  _ensureDefault() {
    // Existing content belongs to the user. Only _upgradeDefault may replace
    // an exact bundled legacy default; invalid or customized files stay intact.
    try { fs.lstatSync(this.path); return; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('整理规则文件无法访问，请检查管理目录'); }
    let descriptor;
    try {
      descriptor = fs.openSync(this.path, 'wx', 0o600);
      fs.writeFileSync(descriptor, DEFAULT_RULES + '\n', 'utf8');
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (error.code === 'EEXIST') return;
      throw new Error('整理规则文件无法创建，请检查管理目录的写入权限');
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }

  read() {
    this._ensureDefault();
    const initial = this._fileStat();
    let descriptor;
    try {
      descriptor = fs.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(descriptor);
      const current = this._fileStat();
      // Compare the opened file with both path observations. On systems without
      // O_NOFOLLOW this also refuses a path swapped for a link before opening.
      if (!opened.isFile() || initial.dev !== opened.dev || initial.ino !== opened.ino || current.dev !== opened.dev || current.ino !== opened.ino || opened.size > MAX_RULE_BYTES) throw new Error('changed file');
      const buffer = Buffer.alloc(MAX_RULE_BYTES + 1);
      let length = 0;
      while (length < buffer.byteLength) {
        const bytes = fs.readSync(descriptor, buffer, length, buffer.byteLength - length, null);
        if (!bytes) break;
        length += bytes;
      }
      if (length > MAX_RULE_BYTES) throw new Error('large file');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      return normalizeRules(text);
    } catch (error) {
      if (error.message?.startsWith('整理规则')) throw error;
      throw new Error('整理规则文件无法读取，请检查 UTF-8 编码、文件大小及访问权限');
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }

  public() { return { text: this.read(), path: this.path, defaultText: DEFAULT_RULES }; }

  _upgradeDefault() {
    try {
      const previous = this.read();
      const hash = createHash('sha256').update(previous).digest('hex');
      if (LEGACY_DEFAULT_HASHES.has(hash)) this._save(DEFAULT_RULES, { expectedText: previous });
    } catch { /* Invalid, customized or unwritable files remain untouched. */ }
  }

  save(value) { return this._save(value); }

  _save(value, { expectedText } = {}) {
    const text = normalizeRules(value);
    this._fileStat({ allowMissing: true, checkSize: false });
    const temporary = path.join(this.dataDir, `.整理规则-${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, text + '\n', 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      this._fileStat({ allowMissing: true, checkSize: false });
      if (expectedText !== undefined && this.read() !== expectedText) return this.public();
      fs.renameSync(temporary, this.path);
      return this.public();
    } catch (error) {
      if (error.message?.startsWith('整理规则')) throw error;
      throw new Error('整理规则保存失败，原文件已保留，请检查文件是否被占用及写入权限');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch { /* A successful rename has no temporary file. */ }
    }
  }
}

module.exports = { SummaryRules, DEFAULT_RULES, normalizeRules };
