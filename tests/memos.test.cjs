'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { MemoStore, validatePng, MAX_TEXT, MAX_IMAGES, MAX_PNG_BYTES } = require('../src/core/memos.cjs');

function fixture(t) {
  const base = path.resolve(__dirname, '..', '.test-tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'memo-'));
  const projects = { alpha: path.join(root, 'alpha'), beta: path.join(root, 'beta') };
  for (const folder of Object.values(projects)) fs.mkdirSync(folder);
  const projectFolder = id => { if (!Object.hasOwn(projects, id)) throw new Error('项目不存在'); return projects[id]; };
  const store = new MemoStore({ projectFolder });
  t.after(() => { assert.ok(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, projects, projectFolder, store, folder: path.join(projects.alpha, '备忘录') };
}

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  const output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length);
  body.copy(output, 4);
  output.writeUInt32BE(crc(body), bytes.length + 8);
  return output;
}

function png(width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 10, 20, 30, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('项目备忘录独立持久化并执行revision过期保护，不写项目Store', t => {
  const { store, projectFolder, projects, folder } = fixture(t);
  assert.deepEqual(store.get('alpha'), { text: '', revision: 0, updatedAt: '', images: [] });
  assert.equal(fs.existsSync(folder), false);
  const saved = store.save('alpha', { text: '客户临时想法\n待以后整理', expectedRevision: 0 });
  assert.equal(saved.revision, 1);
  assert.ok(saved.updatedAt);
  assert.equal(store.get('beta').text, '');
  assert.throws(() => store.save('alpha', { text: '旧窗口内容', expectedRevision: 0 }), /其他窗口更新/);
  assert.equal(store.get('alpha').text, saved.text);
  assert.equal(new MemoStore({ projectFolder }).get('alpha').text, saved.text);
  assert.ok(fs.existsSync(path.join(folder, 'memo.json')));
  assert.ok(fs.existsSync(path.join(folder, 'memo.backup.json')));
  assert.match(fs.readFileSync(path.join(folder, 'memo.md'), 'utf8'), /待以后整理/);
  assert.equal(fs.existsSync(path.join(projects.alpha, 'store.json')), false);
  assert.throws(() => store.get('../alpha'), /项目不存在/);
});

test('PNG图片唯一命名、项目隔离，删除仅移除条目以支持备份恢复', t => {
  const { store, folder } = fixture(t);
  let memo = store.addImage('alpha', { buffer: png(), name: '../../客户截图.png' });
  const first = memo.images[0];
  const imagePath = store.imagePath('alpha', first.id);
  assert.ok(imagePath.startsWith(path.join(folder, 'images') + path.sep));
  assert.equal(first.name, '客户截图.png');
  assert.equal(first.width, 1);
  assert.equal(first.height, 1);
  memo = store.addImage('alpha', { buffer: png(), name: '客户截图.png' });
  assert.notEqual(memo.images[0].id, memo.images[1].id);
  assert.throws(() => store.imagePath('beta', first.id), /不存在/);
  assert.throws(() => store.imagePath('alpha', '../../outside'), /编号无效/);
  const metadata = fs.readFileSync(path.join(folder, 'memo.json'), 'utf8');
  assert.doesNotMatch(metadata, /base64|data:image/);
  assert.match(fs.readFileSync(path.join(folder, 'memo.md'), 'utf8'), /\.\/images\/[0-9a-f-]+\.png/);
  memo = store.removeImage('alpha', first.id);
  assert.equal(memo.images.length, 1);
  assert.ok(fs.existsSync(imagePath));
  assert.throws(() => store.imagePath('alpha', first.id), /不存在/);
  fs.writeFileSync(path.join(folder, 'memo.json'), '{broken');
  const restored = store.get('alpha');
  assert.equal(restored.images.length, 2);
  assert.ok(store.imagePath('alpha', first.id));
});

test('拒绝SVG/HTML、损坏PNG、无效尺寸和过大图片，保持原笔记', t => {
  const { store } = fixture(t);
  store.save('alpha', { text: '保留文字', expectedRevision: 0 });
  for (const input of [Buffer.from('<svg></svg>'), Buffer.from('<html>image</html>'), Buffer.alloc(MAX_PNG_BYTES + 1), png(0, 1), png(16_385, 1), png(16_384, 16_384), png().subarray(0, 45)]) {
    assert.throws(() => store.addImage('alpha', { buffer: input, name: 'x.png' }), /PNG|20 MiB/);
  }
  const damaged = png(); damaged[damaged.length - 1] ^= 1;
  assert.throws(() => validatePng(damaged), /校验失败/);
  assert.throws(() => validatePng(Buffer.concat([png(), Buffer.from('tail')])), /结束结构无效/);
  assert.equal(store.get('alpha').text, '保留文字');
  assert.equal(store.get('alpha').revision, 1);
});

test('文本与图片数量限制有效，非法元数据越界不会当作新空笔记', t => {
  const { store, folder } = fixture(t);
  assert.throws(() => store.save('alpha', { text: 'x'.repeat(MAX_TEXT + 1) }), /200000/);
  assert.throws(() => store.save('alpha', { text: 'x', expectedRevision: -1 }), /版本号无效/);
  for (let index = 0; index < MAX_IMAGES; index += 1) store.addImage('alpha', { buffer: png(), name: `截图${index}.png` });
  assert.equal(store.get('alpha').images.length, MAX_IMAGES);
  assert.throws(() => store.addImage('alpha', { buffer: png() }), /50 张/);
  const malicious = JSON.parse(fs.readFileSync(path.join(folder, 'memo.json'), 'utf8'));
  malicious.images[0].fileName = '../../outside.png';
  fs.writeFileSync(path.join(folder, 'memo.json'), JSON.stringify(malicious));
  fs.writeFileSync(path.join(folder, 'memo.backup.json'), JSON.stringify(malicious));
  assert.throws(() => store.get('alpha'), /不会清空/);
});

test('主文件缺失或损坏可恢复，主备份都损坏明确报错且不覆盖原文件', t => {
  const { store, folder } = fixture(t);
  store.save('alpha', { text: '第一版' });
  store.save('alpha', { text: '第二版' });
  fs.unlinkSync(path.join(folder, 'memo.json'));
  let restored = store.get('alpha');
  assert.equal(restored.text, '第一版');
  assert.match(restored.warning, /备份恢复/);
  store.save('alpha', { text: '恢复后继续', expectedRevision: restored.revision });
  const damagedBytes = Buffer.from('{corrupt-primary\u0000原始损坏字节', 'utf8');
  fs.writeFileSync(path.join(folder, 'memo.json'), damagedBytes);
  restored = store.get('alpha');
  assert.equal(restored.text, '第一版');
  const corrupt = fs.readdirSync(folder).filter(name => /^memo\.corrupt-[0-9a-f-]+\.json$/.test(name));
  assert.equal(corrupt.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(folder, corrupt[0])), damagedBytes);
  fs.writeFileSync(path.join(folder, 'memo.json'), '{bad-main');
  fs.writeFileSync(path.join(folder, 'memo.backup.json'), '{bad-backup');
  assert.throws(() => store.get('alpha'), /不会清空/);
  assert.throws(() => store.save('alpha', { text: '不应覆盖' }), /不会清空/);
  assert.equal(fs.readFileSync(path.join(folder, 'memo.json'), 'utf8'), '{bad-main');
  fs.unlinkSync(path.join(folder, 'memo.json'));
  assert.throws(() => store.get('alpha'), /不会清空/);
});

test('主写入失败保留原笔记，Markdown导出失败返回warning且不伪报保存失败', t => {
  const { store, folder } = fixture(t);
  store.save('alpha', { text: '已有笔记' });
  const primary = path.join(folder, 'memo.json');
  const markdown = path.join(folder, 'memo.md');
  const rename = fs.renameSync;
  try {
    fs.renameSync = (source, target) => { if (target === primary) throw new Error('模拟主文件写入失败'); return rename(source, target); };
    assert.throws(() => store.save('alpha', { text: '不应成功' }), /模拟主文件写入失败/);
  } finally { fs.renameSync = rename; }
  assert.equal(store.get('alpha').text, '已有笔记');
  assert.equal(store.get('alpha').revision, 1);
  try {
    fs.renameSync = (source, target) => { if (target === markdown) throw new Error('模拟导出失败'); return rename(source, target); };
    const saved = store.save('alpha', { text: 'JSON已成功保存', expectedRevision: 1 });
    assert.equal(saved.revision, 2);
    assert.match(saved.warning, /已保存.*Markdown/);
  } finally { fs.renameSync = rename; }
  assert.equal(store.get('alpha').text, 'JSON已成功保存');
  assert.equal(fs.readdirSync(folder).some(name => name.includes('.tmp-')), false);
});

test('损坏主文件无法归档时不以旧备份覆盖唯一原字节', t => {
  const { store, folder } = fixture(t);
  store.save('alpha', { text: '有效旧笔记' });
  const primary = path.join(folder, 'memo.json');
  const damaged = Buffer.from('{无法读取但可能可恢复的新内容');
  fs.writeFileSync(primary, damaged);
  const copy = fs.copyFileSync;
  try {
    fs.copyFileSync = () => { throw new Error('模拟损坏文件归档失败'); };
    assert.throws(() => store.get('alpha'), /无法安全归档/);
    assert.throws(() => store.save('alpha', { text: '不应覆盖' }), /无法安全归档/);
  } finally { fs.copyFileSync = copy; }
  assert.deepEqual(fs.readFileSync(primary), damaged);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'memo.backup.json'), 'utf8')).text, '有效旧笔记');
});

test('图片实体缺失或被替换时拒绝读取，文字仍可取回', t => {
  const { store } = fixture(t);
  store.save('alpha', { text: '不应因附件缺失丢失文字' });
  const memo = store.addImage('alpha', { buffer: png() });
  const image = memo.images[0];
  const imagePath = store.imagePath('alpha', image.id);
  fs.writeFileSync(imagePath, '<svg/>');
  assert.throws(() => store.imagePath('alpha', image.id), /PNG/);
  fs.unlinkSync(imagePath);
  assert.throws(() => store.imagePath('alpha', image.id), /缺失/);
  assert.equal(store.get('alpha').text, '不应因附件缺失丢失文字');
});

test('拒绝链接目录和图片，不跟随链接读取项目外文件', t => {
  const { root, projects, store, folder } = fixture(t);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, folder, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('系统未授权创建链接；使用提升权限运行可验证此分支。'); return; } throw error; }
  assert.throws(() => store.get('alpha'), /链接|越界/);
  assert.throws(() => store.save('alpha', { text: '拒绝写入' }), /链接|越界/);
  fs.unlinkSync(folder);
  const memo = store.addImage('alpha', { buffer: png() });
  const imagePath = store.imagePath('alpha', memo.images[0].id);
  const otherFile = path.join(outside, 'outside.png'); fs.writeFileSync(otherFile, png());
  fs.unlinkSync(imagePath);
  try { fs.symlinkSync(otherFile, imagePath, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    // Windows can permit junctions without granting file-symlink privilege.
    // An image entry redirected to a directory junction must be rejected too.
    fs.symlinkSync(outside, imagePath, 'junction');
    t.diagnostic('系统无文件 symlink 权限，改用 .png 路径上的目录 junction 验证拒绝链接；未跳过安全断言。');
  }
  assert.throws(() => store.imagePath('alpha', memo.images[0].id), /链接|越界/);
  assert.ok(fs.existsSync(otherFile));
  assert.equal(fs.existsSync(path.join(projects.alpha, 'store.json')), false);
});
