'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { Store } = require('../src/core/store.cjs');

function fixture(t) {
  const base = path.resolve(__dirname, '../.test-tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'material-refresh-'));
  const sourceDir = path.join(root, 'source'), devDir = path.join(root, 'dev');
  fs.mkdirSync(sourceDir); fs.mkdirSync(devDir);
  const store = new Store(path.join(root, 'data'));
  const project = store.createProject({ name: '资料刷新验收', sourceDir, devDir });
  t.after(() => { assert.ok(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, sourceDir, devDir, store, project };
}
function writeChanged(file, text, prior) {
  fs.writeFileSync(file, text);
  if (prior) fs.utimesSync(file, prior.atime, new Date(prior.mtimeMs + 2000));
  return fs.statSync(file);
}
function writeDocx(file, text) {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));
  zip.writeZip(file);
}

test('资料刷新重读正常修改的正文和自动介绍，新旧关键词随索引同步变化', async t => {
  const { sourceDir, store, project } = fixture(t), file = path.join(sourceDir, '业务需求.md');
  const before = writeChanged(file, '# 旧业务标题\n\nONLY_OLD_LOOKUP');
  let result = await store.scanProject(project.id);
  const indexed = result.files.find(item => item.path === file);
  assert.match(indexed.description, /旧业务标题/);
  const changed = writeChanged(file, '# 新业务标题\n\nONLY_NEW_LOOKUP', before);
  result = await store.scanProject(project.id);
  const refreshed = result.files.find(item => item.path === file);
  assert.equal(refreshed.id, indexed.id);
  assert.match(refreshed.description, /新业务标题/);
  assert.match(refreshed.textPreview, /ONLY_NEW_LOOKUP/);
  assert.doesNotMatch(refreshed.textPreview, /ONLY_OLD_LOOKUP/);
  assert.equal(fs.readFileSync(file, 'utf8'), '# 新业务标题\n\nONLY_NEW_LOOKUP');
  assert.equal(fs.statSync(file).mtimeMs, changed.mtimeMs, '刷新本身只读原资料');
});

test('用户填写的介绍保持不变，同时更新文件正文与开发成果内容', async t => {
  const { sourceDir, devDir, store, project } = fixture(t), file = path.join(sourceDir, '客户说明.txt'), artifact = path.join(devDir, '交付说明.md');
  const before = writeChanged(file, '旧客户资料');
  const artifactBefore = writeChanged(artifact, '# 旧成果说明');
  let result = await store.scanProject(project.id);
  const indexed = result.files.find(item => item.path === file);
  store.updateFile(project.id, indexed.id, { description: '人工用途：客户费用字段说明' });
  writeChanged(file, '新客户资料正文：增加费用字段', before);
  writeChanged(artifact, '# 新成果说明\n交付内容已调整', artifactBefore);
  result = await store.scanProject(project.id);
  const refreshed = result.files.find(item => item.id === indexed.id);
  assert.equal(refreshed.description, '人工用途：客户费用字段说明');
  assert.equal(refreshed.descriptionSource, 'user');
  assert.match(refreshed.textPreview, /增加费用字段/);
  assert.match(result.files.find(item => item.path === artifact).textPreview, /交付内容已调整/);
});

test('资料刷新同步新增、重命名、删除和重新出现，保留缺失来源用于回溯', async t => {
  const { sourceDir, store, project } = fixture(t), oldFile = path.join(sourceDir, '旧名称.md'), renamed = path.join(sourceDir, '新名称.md'), added = path.join(sourceDir, '后续补充.txt');
  fs.writeFileSync(oldFile, '# 初始内容');
  let result = await store.scanProject(project.id);
  const originalId = result.files.find(item => item.path === oldFile).id;
  fs.renameSync(oldFile, renamed); fs.writeFileSync(added, '客户后续补充内容');
  result = await store.scanProject(project.id);
  assert.equal(result.files.find(item => item.id === originalId).missing, true);
  assert.equal(result.files.find(item => item.path === renamed).missing, false);
  assert.equal(result.files.find(item => item.path === added).missing, false);
  fs.unlinkSync(renamed); fs.writeFileSync(oldFile, '# 原路径恢复的新内容');
  result = await store.scanProject(project.id);
  assert.equal(result.files.find(item => item.id === originalId).missing, false);
  assert.match(result.files.find(item => item.id === originalId).textPreview, /恢复的新内容/);
  assert.equal(result.files.find(item => item.path === renamed).missing, true);
});

test('资料刷新重新解析变更的 Office 正文，随后能检索新内容', async t => {
  const { sourceDir, store, project } = fixture(t), file = path.join(sourceDir, '会议纪要.docx');
  writeDocx(file, '第一版会议业务说明'); const before = fs.statSync(file);
  let result = await store.scanProject(project.id);
  assert.match(result.files.find(item => item.path === file).textPreview, /第一版会议/);
  writeDocx(file, '第二版会议补充了客户测试流程'); fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
  result = await store.scanProject(project.id);
  assert.match(result.files.find(item => item.path === file).textPreview, /客户测试流程/);
  assert.doesNotMatch(result.files.find(item => item.path === file).textPreview, /第一版会议/);
});

test('显式刷新忽略等大小等修改时间缓存并更新三类资料，自动扫描仍复用缓存', async t => {
  const { root, sourceDir, devDir, store, project } = fixture(t);
  const fixed = new Date('2026-10-01T00:00:00Z');
  const source = path.join(sourceDir, '客户需求.md'), dev = path.join(devDir, '交付方案.md'), imported = path.join(root, '待导入补充.txt');
  fs.writeFileSync(source, '# 原始旧需求'); fs.writeFileSync(dev, '# 成果旧说明'); fs.writeFileSync(imported, '补充旧资料');
  fs.utimesSync(source, fixed, fixed); fs.utimesSync(dev, fixed, fixed);
  await store.addFiles(project.id, [imported]);
  let result = await store.scanProject(project.id);
  const supplement = result.files.find(item => item.kind === '补充资料');
  fs.utimesSync(supplement.path, fixed, fixed);
  result = await store.scanProject(project.id);
  const originals = result.files.map(item => ({ ...item }));
  const sourceOriginal = originals.find(item => item.path === source);
  store.updateFile(project.id, sourceOriginal.id, { description: '人工介绍必须保留' });
  const changes = [[source, '# 原始新需求'], [dev, '# 成果新说明'], [supplement.path, '补充新资料']];
  for (const [file, text] of changes) {
    fs.writeFileSync(file, text); fs.utimesSync(file, fixed, fixed);
    const prior = originals.find(item => item.path === file), stat = fs.statSync(file);
    assert.equal(stat.size, prior.size);
    assert.equal(stat.mtime.toISOString(), prior.mtime);
  }
  const auto = await store.scanProject(project.id);
  assert.ok(auto.files.every(item => item.textPreview.includes('旧')), '常规自动扫描保留已知未变化文件缓存');
  const refreshed = await store.scanProject(project.id, { force: true });
  for (const [file, text] of changes) {
    const before = originals.find(item => item.path === file), after = refreshed.files.find(item => item.path === file);
    assert.equal(after.id, before.id);
    assert.equal(after.textPreview, text);
    assert.equal(after.missing, false);
    assert.equal(fs.readFileSync(file, 'utf8'), text, '刷新不能写回原文件');
    assert.equal(fs.statSync(file).mtime.toISOString(), fixed.toISOString());
  }
  assert.equal(refreshed.files.find(item => item.path === source).description, '人工介绍必须保留');
  assert.match(refreshed.files.find(item => item.path === dev).description, /成果新说明/);
  assert.match(refreshed.files.find(item => item.path === supplement.path).description, /补充新资料/);
  assert.equal(refreshed.files.find(item => item.path === supplement.path).importedAt, supplement.importedAt);
  assert.equal(refreshed.files.find(item => item.path === supplement.path).originalPath, imported);
  const restored = new Store(store.dataDir).getState().projects[0];
  assert.ok(restored.files.every(item => item.textPreview.includes('新')));
});

test('预览直接读取等大小等时间的新正文，保留文件身份和人工介绍', async t => {
  const { sourceDir, store, project } = fixture(t), file = path.join(sourceDir, '原件.txt'), fixed = new Date('2026-10-01T00:00:00Z');
  fs.writeFileSync(file, '原件旧内容'); fs.utimesSync(file, fixed, fixed);
  let result = await store.scanProject(project.id);
  const original = result.files.find(item => item.path === file);
  store.updateFile(project.id, original.id, { description: '人工用途说明' });
  fs.writeFileSync(file, '原件新内容'); fs.utimesSync(file, fixed, fixed);
  const preview = await store.previewFile(project.id, original.id);
  assert.equal(preview.text, '原件新内容');
  assert.equal(preview.file.id, original.id);
  assert.equal(preview.file.description, '人工用途说明');
  assert.equal(fs.statSync(file).mtime.toISOString(), fixed.toISOString());
});
