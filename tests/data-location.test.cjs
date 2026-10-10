'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveLegacyDataDirectory: resolveDataDirectory, inspectDataDirectory, findPortableExecutable } = require('../desktop/data-location.cjs');

function fixture(t) {
  const base = path.resolve(__dirname, '../.test-tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'data-location-中文 '));
  const local = path.join(root, 'data'), executable = path.join(root, 'release', 'FDE Desk-win32-x64', 'FDE Desk.exe'), portable = path.join(path.dirname(executable), 'data');
  t.after(() => { assert.ok(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (directory, count, backup = false) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, backup ? 'store.backup.json' : 'store.json'), JSON.stringify({ version: 1, settings: {}, projects: Array.from({ length: count }, (_, i) => ({ id: `project-${i}`, files: [], records: [], requirements: [], reports: [], cycles: [], deliveries: [] })) }));
  };
  const createExecutable = () => { fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, 'isolated test executable marker'); };
  const resolve = patch => resolveDataDirectory({ root, isPackaged: false, execPath: path.join(root, 'development-electron.exe'), env: {}, ...patch });
  return { root, local, executable, portable, write, createExecutable, resolve };
}

test('explicit FDE_DATA_DIR wins over both source and packaged defaults without probing or creating data', t => {
  const f = fixture(t), explicit = path.join(f.root, '独立数据');
  f.createExecutable(); f.write(f.local, 1); f.write(f.portable, 3);
  assert.equal(f.resolve({ env: { FDE_DATA_DIR: explicit } }), explicit);
  assert.equal(f.resolve({ isPackaged: true, execPath: 'ignored.exe', env: { FDE_DATA_DIR: explicit } }), explicit);
  assert.equal(fs.existsSync(explicit), false);
  assert.equal(f.resolve({ env: { FDE_DATA_DIR: './relative-fde-data' } }), path.resolve('./relative-fde-data'));
});

test('packaged defaults to its own executable sibling data even when source data is populated', t => {
  const f = fixture(t); f.write(f.local, 1);
  const movedExe = path.join(f.root, '用户移动后的程序', 'FDE Desk.exe');
  assert.equal(f.resolve({ isPackaged: true, execPath: movedExe }), path.join(path.dirname(movedExe), 'data'));
});

test('nonempty source archive remains selected instead of silently switching to a larger portable archive', t => {
  const f = fixture(t); f.createExecutable(); f.write(f.local, 1); f.write(f.portable, 3);
  const before = fs.readFileSync(path.join(f.local, 'store.json'));
  assert.equal(f.resolve(), f.local);
  assert.deepEqual(fs.readFileSync(path.join(f.local, 'store.json')), before);
});

test('source backup projects preserve the source directory even when its primary file is empty or missing', t => {
  const f = fixture(t); f.createExecutable(); f.write(f.local, 0); f.write(f.local, 2, true); f.write(f.portable, 3);
  assert.equal(f.resolve(), f.local);
  fs.unlinkSync(path.join(f.local, 'store.json'));
  assert.equal(f.resolve(), f.local);
  assert.deepEqual(inspectDataDirectory(f.local), { status: 'populated', primary: 'missing', backup: 'populated', projectCount: 2 });
});

test('empty development data reuses the installed portable data that contains projects', t => {
  const f = fixture(t); f.createExecutable(); f.write(f.local, 0); f.write(f.local, 0, true); f.write(f.portable, 3);
  assert.equal(f.resolve(), f.portable);
  assert.equal(findPortableExecutable({ root: f.root }), f.executable);
});

test('missing development data can reuse portable backup projects without creating a competing source data directory', t => {
  const f = fixture(t); f.createExecutable(); f.write(f.portable, 3, true);
  assert.equal(f.resolve(), f.portable);
  assert.equal(fs.existsSync(f.local), false);
  assert.equal(inspectDataDirectory(f.portable).status, 'populated');
});

test('malformed source JSON, invalid structure or unreadable state is unknown and left to source Store recovery', t => {
  const f = fixture(t); f.createExecutable(); f.write(f.portable, 3); fs.mkdirSync(f.local);
  const file = path.join(f.local, 'store.json');
  for (const text of ['{broken', '{}', 'null', '{"version":1,"settings":{},"projects":{}}', '{"version":2,"settings":{},"projects":[]}']) {
    fs.writeFileSync(file, text);
    assert.equal(inspectDataDirectory(f.local).status, 'unknown');
    assert.equal(f.resolve(), f.local);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.equal(inspectDataDirectory(f.local).status, 'unknown');
  assert.equal(f.resolve(), f.local);
});

test('malformed source backup is not mistaken for an empty archive', t => {
  const f = fixture(t); f.createExecutable(); f.write(f.local, 0); f.write(f.portable, 3);
  fs.writeFileSync(path.join(f.local, 'store.backup.json'), 'invalid backup');
  assert.equal(inspectDataDirectory(f.local).status, 'unknown');
  assert.equal(f.resolve(), f.local);
});

test('portable backup can recover a damaged portable primary when source is empty', t => {
  const f = fixture(t); f.createExecutable(); f.write(f.portable, 3, true);
  fs.writeFileSync(path.join(f.portable, 'store.json'), 'damaged primary');
  assert.equal(f.resolve(), f.portable);
  assert.deepEqual(inspectDataDirectory(f.portable), { status: 'populated', primary: 'unknown', backup: 'populated', projectCount: 3 });
});

test('missing executable, empty portable data, or unknown portable data does not invent a project source', t => {
  const f = fixture(t); f.write(f.portable, 3);
  assert.equal(f.resolve(), f.local);
  assert.equal(findPortableExecutable({ root: f.root }), '');
  f.createExecutable(); f.write(f.portable, 0);
  assert.equal(f.resolve(), f.local);
  fs.writeFileSync(path.join(f.portable, 'store.json'), 'unknown portable state');
  assert.equal(f.resolve(), f.local);
});

test('an executable directory is not treated as a runnable portable installation and whitespace override is absent', t => {
  const f = fixture(t); fs.mkdirSync(f.executable, { recursive: true }); f.write(f.portable, 3);
  assert.equal(findPortableExecutable({ root: f.root }), '');
  assert.equal(f.resolve({ env: { FDE_DATA_DIR: '   ' } }), f.local);
});
