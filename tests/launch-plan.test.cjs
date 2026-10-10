'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLaunchPlan } = require('../desktop/launch-plan.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const portable = path.join(root, 'release', 'FDE Desk-win32-x64', 'FDE Desk.exe');
  fs.mkdirSync(path.dirname(portable), { recursive: true });
  fs.writeFileSync(portable, 'fixture');
  const electronExecutable = path.join(root, 'electron.exe');
  const plan = (env = {}, argv = []) => createLaunchPlan({ root, electronExecutable, env, argv });
  const store = content => {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'store.json'), content);
  };
  return { root, portable, electronExecutable, plan, store };
}

test('normal startup uses the portable edition and does not inherit Electron node mode', t => {
  const f = fixture(t);
  f.store(JSON.stringify({ version: 1, settings: {}, projects: [] }));
  const original = { ELECTRON_RUN_AS_NODE: '1', CUSTOM: 'kept' };
  const plan = f.plan(original, ['--some-argument']);
  assert.equal(plan.executable, f.portable);
  assert.equal(plan.mode, 'portable');
  assert.deepEqual(plan.args, ['--some-argument']);
  assert.deepEqual(plan.env, { CUSTOM: 'kept' });
  assert.equal(original.ELECTRON_RUN_AS_NODE, '1');
});

test('explicit isolated data and source development flags never launch the portable executable', t => {
  const f = fixture(t);
  const data = path.join(f.root, 'isolated');
  const explicit = f.plan({ FDE_DATA_DIR: data });
  assert.equal(explicit.mode, 'source');
  assert.equal(explicit.env.FDE_DATA_DIR, data);
  assert.equal(explicit.executable, f.electronExecutable);
  assert.deepEqual(explicit.args, [f.root]);
  const development = f.plan({}, ['--dev', '--trace-warnings']);
  assert.equal(development.mode, 'source');
  assert.deepEqual(development.args, [f.root, '--trace-warnings']);
});

test('a populated or unreadable source archive is never silently bypassed', t => {
  const f = fixture(t);
  f.store(JSON.stringify({ version: 1, settings: {}, projects: [{ id: 'source-project' }] }));
  assert.equal(f.plan().mode, 'source');
  f.store('{broken json');
  assert.equal(f.plan().mode, 'source');
  f.store(JSON.stringify({ version: 1, settings: {}, projects: [] }));
  fs.writeFileSync(path.join(f.root, 'data', 'store.backup.json'), JSON.stringify({ version: 1, settings: {}, projects: [{ id: 'backup-project' }] }));
  assert.equal(f.plan().mode, 'source');
});

test('an unpackaged checkout without a portable executable still starts from source', t => {
  const f = fixture(t);
  fs.unlinkSync(f.portable);
  assert.equal(f.plan().mode, 'source');
  assert.equal(f.plan().executable, f.electronExecutable);
});
