'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TEXT = 200_000;
const MAX_IMAGES = 50;
const MAX_PNG_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clone = value => JSON.parse(JSON.stringify(value));
const blankMemo = () => ({ text: '', revision: 0, updatedAt: '', images: [] });
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) throw new Error('图片必须是 PNG 二进制数据');
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length > MAX_PNG_BYTES) throw new Error('单张图片不能超过 20 MiB');
  if (buffer.length < 57 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('图片不是有效的 PNG，不能保存 HTML 或 SVG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let chunks = 0;
  let hasData = false;
  let ended = false;
  while (offset < buffer.length) {
    if (++chunks > 50_000 || offset + 12 > buffer.length) throw new Error('PNG 图片结构损坏');
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error('PNG 数据长度无效');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(buffer, offset + 4, offset + 8 + length) !== buffer.readUInt32BE(offset + 8 + length)) throw new Error('PNG 图片校验失败');
    if (chunks === 1 && (type !== 'IHDR' || length !== 13)) throw new Error('PNG 缺少有效图片头');
    if (type === 'IHDR') {
      if (chunks !== 1 || length !== 13) throw new Error('PNG 图片头无效');
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('PNG 图片尺寸超过限制');
      const depth = buffer[offset + 16];
      const color = buffer[offset + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || buffer[offset + 18] !== 0 || buffer[offset + 19] !== 0 || ![0, 1].includes(buffer[offset + 20])) throw new Error('PNG 图片编码无效');
    } else if (type === 'IDAT') {
      hasData ||= length > 0;
    } else if (type === 'IEND') {
      if (length !== 0 || end !== buffer.length || !hasData) throw new Error('PNG 图片结束结构无效');
      ended = true;
    } else if (type[0] === type[0].toUpperCase() && type !== 'PLTE') throw new Error('PNG 包含不支持的关键结构');
    offset = end;
  }
  if (!ended || !width || !height) throw new Error('PNG 图片不完整');
  return { buffer, width, height };
}

function unsafe(message) { const error = new Error(message); error.code = 'MEMO_UNSAFE_PATH'; return error; }

function safeFile(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || !samePath(fs.realpathSync(filePath), filePath)) throw unsafe('备忘录文件不能是链接或越界路径');
  return stat;
}

function safeDirectory(directory, create = false) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    fs.mkdirSync(directory);
    stat = fs.lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(directory), directory)) throw unsafe('备忘录目录不能是链接或越界路径');
  return directory;
}

function validateMemo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.text !== 'string' || value.text.length > MAX_TEXT || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision === Number.MAX_SAFE_INTEGER || typeof value.updatedAt !== 'string' || (value.updatedAt && !Number.isFinite(Date.parse(value.updatedAt))) || !Array.isArray(value.images) || value.images.length > MAX_IMAGES) throw new Error('备忘录内容结构损坏');
  const ids = new Set();
  const images = value.images.map(item => {
    if (!item || typeof item !== 'object' || !UUID.test(item.id) || ids.has(item.id) || item.fileName !== `${item.id}.png` || typeof item.name !== 'string' || item.name.length > 300 || !Number.isInteger(item.width) || !Number.isInteger(item.height) || item.width < 1 || item.height < 1 || item.width > MAX_DIMENSION || item.height > MAX_DIMENSION || item.width * item.height > MAX_PIXELS || !Number.isInteger(item.size) || item.size < 57 || item.size > MAX_PNG_BYTES || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) throw new Error('备忘录图片元数据损坏或路径越界');
    ids.add(item.id);
    return { id: item.id, name: item.name, fileName: item.fileName, width: item.width, height: item.height, size: item.size, createdAt: item.createdAt };
  });
  return { text: value.text, revision: value.revision, updatedAt: value.updatedAt, images };
}

class MemoStore {
  constructor({ projectFolder } = {}) {
    if (typeof projectFolder !== 'function') throw new Error('备忘录需要项目目录校验回调');
    this.projectFolder = projectFolder;
  }

  _folder(projectId, create = false) {
    const base = this.projectFolder(projectId);
    if (typeof base !== 'string' || !path.isAbsolute(base)) throw unsafe('项目管理路径无效');
    safeDirectory(path.resolve(base));
    const folder = path.join(path.resolve(base), '备忘录');
    if (!create) {
      try { fs.lstatSync(folder); } catch (error) { if (error.code === 'ENOENT') return folder; throw error; }
    }
    return safeDirectory(folder, create);
  }

  _atomicWrite(target, content) {
    safeFile(target);
    const temporary = `${target}.tmp-${crypto.randomUUID()}`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx');
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      // Recheck before replacement so an existing link is never followed.
      safeFile(target);
      fs.renameSync(temporary, target);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  _read(file) {
    const stat = safeFile(file);
    if (!stat) return null;
    if (stat.size > MAX_JSON_BYTES) throw new Error('备忘录文件超过安全读取限制');
    return validateMemo(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  _load(folder) {
    try { fs.lstatSync(folder); } catch (error) { if (error.code === 'ENOENT') return blankMemo(); throw error; }
    safeDirectory(folder);
    const primary = path.join(folder, 'memo.json');
    const backup = path.join(folder, 'memo.backup.json');
    let error;
    try { const memo = this._read(primary); if (memo) return memo; } catch (caught) { if (caught.code === 'MEMO_UNSAFE_PATH') throw caught; error = caught; }
    let recovered;
    try { recovered = this._read(backup); } catch (caught) { if (caught.code === 'MEMO_UNSAFE_PATH') throw caught; error ||= caught; }
    if (recovered) {
      if (error && safeFile(primary)) {
        try {
          const corrupt = path.join(folder, `memo.corrupt-${crypto.randomUUID()}.json`);
          fs.copyFileSync(primary, corrupt, fs.constants.COPYFILE_EXCL);
        } catch { throw new Error('有效备份仍保留，但损坏主文件无法安全归档，暂不能恢复或保存，以免丢失原内容。'); }
      }
      try {
        this._atomicWrite(primary, JSON.stringify(recovered, null, 2));
        return { ...recovered, warning: '备忘录主文件缺失或损坏，已从上一次有效备份恢复。' };
      } catch { return { ...recovered, warning: '已读取有效备份，主文件暂无法修复；现有笔记仍保留。' }; }
    }
    if (error || safeFile(primary) || safeFile(backup)) throw new Error('备忘录及备份无法读取，请保留现有文件后恢复；不会清空笔记。');
    return blankMemo();
  }

  _commit(folder, current, next) {
    validateMemo(next);
    safeDirectory(folder);
    const primary = path.join(folder, 'memo.json');
    const backup = path.join(folder, 'memo.backup.json');
    const hadPrimary = !!safeFile(primary);
    safeFile(backup);
    // The previous valid note is secured before replacing a real primary. On a
    // failed primary write, both primary and backup still describe that note.
    if (hadPrimary) this._atomicWrite(backup, JSON.stringify(validateMemo(current), null, 2));
    this._atomicWrite(primary, JSON.stringify(next, null, 2));
    const warnings = [];
    if (!hadPrimary) {
      try { this._atomicWrite(backup, JSON.stringify(next, null, 2)); }
      catch { warnings.push('笔记已保存，但备份暂未写入。'); }
    }
    try {
      const images = next.images.map(item => `![${item.name.replace(/[\\\[\]\r\n]/g, ' ')}](./images/${item.fileName})`).join('\n\n');
      this._atomicWrite(path.join(folder, 'memo.md'), `${next.text}${images ? `\n\n${images}` : ''}\n`);
    } catch { warnings.push('笔记已保存，但 Markdown 导出暂未更新。'); }
    return { ...clone(next), ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
  }

  get(projectId) { return clone(this._load(this._folder(projectId))); }

  save(projectId, input = {}) {
    const folder = this._folder(projectId, true);
    const current = this._load(folder);
    if (!input || typeof input !== 'object') throw new Error('备忘录保存内容无效');
    if (typeof input.text !== 'string' || input.text.length > MAX_TEXT) throw new Error('备忘录文字最多 200000 个字符');
    if (input.expectedRevision !== undefined) {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('备忘录版本号无效');
      if (input.expectedRevision !== current.revision) throw new Error('备忘录已被其他窗口更新，请重新读取后保存');
    }
    return this._commit(folder, current, { text: input.text, revision: current.revision + 1, updatedAt: new Date().toISOString(), images: current.images });
  }

  addImage(projectId, { buffer, name = '截图.png' } = {}) {
    const folder = this._folder(projectId, true);
    const current = this._load(folder);
    if (current.images.length >= MAX_IMAGES) throw new Error('每个项目备忘录最多保存 50 张图片');
    if (typeof name !== 'string') throw new Error('图片名称无效');
    const png = validatePng(buffer);
    const imagesFolder = safeDirectory(path.join(folder, 'images'), true);
    const imageId = crypto.randomUUID();
    const fileName = `${imageId}.png`;
    this._atomicWrite(path.join(imagesFolder, fileName), png.buffer);
    const image = { id: imageId, name: path.basename(name).replace(/[\u0000\r\n]/g, '').slice(0, 300) || '截图.png', fileName, width: png.width, height: png.height, size: png.buffer.length, createdAt: new Date().toISOString() };
    return this._commit(folder, current, { text: current.text, revision: current.revision + 1, updatedAt: new Date().toISOString(), images: [...current.images, image] });
  }

  removeImage(projectId, imageId) {
    const folder = this._folder(projectId, true);
    const current = this._load(folder);
    if (!UUID.test(imageId) || !current.images.some(image => image.id === imageId)) throw new Error('备忘录图片不存在');
    return this._commit(folder, current, { text: current.text, revision: current.revision + 1, updatedAt: new Date().toISOString(), images: current.images.filter(image => image.id !== imageId) });
  }

  imagePath(projectId, imageId) {
    const folder = this._folder(projectId);
    const current = this._load(folder);
    if (!UUID.test(imageId)) throw new Error('备忘录图片编号无效');
    const image = current.images.find(item => item.id === imageId);
    if (!image) throw new Error('备忘录图片不存在');
    const imagesFolder = safeDirectory(path.join(folder, 'images'));
    const target = path.join(imagesFolder, image.fileName);
    const stat = safeFile(target);
    if (!stat) throw new Error('备忘录图片文件缺失');
    if (stat.size > MAX_PNG_BYTES) throw new Error('备忘录图片超过大小限制');
    const png = validatePng(fs.readFileSync(target));
    if (png.width !== image.width || png.height !== image.height || stat.size !== image.size) throw new Error('备忘录图片与已保存记录不一致');
    return target;
  }
}

module.exports = { MemoStore, validatePng, MAX_TEXT, MAX_IMAGES, MAX_PNG_BYTES };
