'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SessionWatcher } = require('../src/core/session-watcher.cjs');

const root = path.resolve(__dirname, '../.test-tmp/session-watch-fixture');
const session = (projectId, name = 'rollout.jsonl', directory = root) => ({ projectId, path: path.join(directory, name) });
const pause = (ms = 45) => new Promise(resolve => setTimeout(resolve, ms));

function mockNativeWatch() {
  const entries = [];
  let nextError = null;
  const watchImpl = (directory, options, callback) => {
    if (nextError) { const error = nextError; nextError = null; throw error; }
    const watcher = new EventEmitter();
    const entry = { directory, options, callback, watcher, closed: false, closes: 0 };
    watcher.close = () => { if (entry.closed) return; entry.closed = true; entry.closes++; watcher.emit('close'); };
    watcher.unref = () => {};
    entries.push(entry);
    return watcher;
  };
  const emit = (event, filename, directory = root) => {
    for (const entry of entries.filter(item => !item.closed && item.directory === directory)) entry.callback(event, filename);
  };
  return { entries, watchImpl, emit, failNext: error => { nextError = error; } };
}

function fixture(t, initial = [session('a')]) {
  const native = mockNativeWatch(), changes = [], errors = [];
  let sessions = initial, resolves = 0;
  const watcher = new SessionWatcher({
    resolveSessions: async () => { resolves++; return sessions; },
    onChange: projectId => changes.push(projectId), onError: (projectId, error) => errors.push({ projectId, error }),
    delay: 15, watchImpl: native.watchImpl,
  });
  t.after(() => watcher.stop());
  return { watcher, native, changes, errors, replace: value => { sessions = value; }, resolved: () => resolves };
}

test('new bindings bootstrap once; repeated sync and idle never trigger more work or resolution', async t => {
  const f = fixture(t);
  await f.watcher.sync();
  assert.deepEqual(f.changes, ['a']);
  assert.equal(f.native.entries.length, 1);
  assert.equal(f.native.entries[0].options.persistent, false);
  await f.watcher.sync();
  await pause();
  assert.deepEqual(f.changes, ['a']);
  assert.equal(f.native.entries.length, 1);
  assert.equal(f.resolved(), 2, 'idle must not poll the resolver');
});

test('matching native change/touch notifications debounce; unrelated filenames do nothing', async t => {
  const f = fixture(t);
  await f.watcher.sync(); f.changes.length = 0;
  f.native.emit('change', 'unrelated.jsonl');
  await pause(); assert.deepEqual(f.changes, []);
  f.native.emit('change', 'rollout.jsonl');
  f.native.emit('change', Buffer.from('rollout.jsonl'));
  f.native.emit('rename', 'rollout.jsonl');
  await pause();
  assert.deepEqual(f.changes, ['a']);
});

test('rename and file recreation keep parent-directory watching alive', async t => {
  const f = fixture(t);
  await f.watcher.sync(); f.changes.length = 0;
  f.native.emit('rename', 'rollout.jsonl');
  await pause();
  f.native.emit('rename', 'rollout.jsonl');
  f.native.emit('change', 'rollout.jsonl');
  await pause();
  assert.deepEqual(f.changes, ['a', 'a']);
  assert.equal(f.native.entries.length, 1);
  assert.equal(f.native.entries[0].closed, false);
});

test('all bound projects are watched independently of active UI project, sharing directory and file notifications', async t => {
  const f = fixture(t, [session('a'), session('b', 'other.jsonl'), session('c'), session('c')]);
  await f.watcher.sync();
  assert.deepEqual(f.changes, ['a', 'b', 'c']);
  assert.equal(f.native.entries.length, 1);
  f.changes.length = 0;
  f.native.emit('change', 'other.jsonl'); await pause();
  assert.deepEqual(f.changes, ['b']);
  f.changes.length = 0;
  f.native.emit('change', 'rollout.jsonl'); await pause();
  assert.deepEqual(new Set(f.changes), new Set(['a', 'c']));
  f.changes.length = 0;
  f.native.emit('change', null); await pause();
  assert.deepEqual(new Set(f.changes), new Set(['a', 'b', 'c']));
});

test('unlink cancels queued changes; replacing a binding bootstraps its new file without keeping stale work', async t => {
  const f = fixture(t, [session('a'), session('b', 'other.jsonl')]);
  await f.watcher.sync(); f.changes.length = 0;
  f.native.emit('change', 'rollout.jsonl');
  f.replace([session('b', 'other.jsonl')]); await f.watcher.sync();
  await pause(); assert.deepEqual(f.changes, []);
  assert.equal(f.native.entries[0].closed, false, 'shared directory remains while another project is bound');
  f.native.emit('change', 'rollout.jsonl'); await pause(); assert.deepEqual(f.changes, []);
  f.replace([session('b', 'replacement.jsonl')]); await f.watcher.sync();
  await pause(); assert.deepEqual(f.changes, ['b']);
  f.replace([]); await f.watcher.sync();
  assert.equal(f.native.entries[0].closed, true);
});

test('stop closes native handles, cancels debounce, and ignores stale native events and later sync', async t => {
  const f = fixture(t);
  await f.watcher.sync(); f.changes.length = 0;
  f.native.emit('change', 'rollout.jsonl');
  f.watcher.stop();
  f.native.entries[0].callback('change', 'rollout.jsonl');
  await f.watcher.sync(); await pause();
  assert.deepEqual(f.changes, []);
  assert.equal(f.native.entries[0].closes, 1);
  assert.equal(f.resolved(), 1);
});

test('native watcher errors clean up affected projects and recover only on explicit sync', async t => {
  const f = fixture(t, [session('a'), session('b')]);
  await f.watcher.sync(); f.changes.length = 0;
  f.native.emit('change', 'rollout.jsonl');
  const nativeError = new Error('native watch failed');
  f.native.entries[0].watcher.emit('error', nativeError);
  await pause();
  assert.deepEqual(f.changes, []);
  assert.deepEqual(new Set(f.errors.map(item => item.projectId)), new Set(['a', 'b']));
  assert.ok(f.errors.every(item => item.error === nativeError));
  assert.equal(f.native.entries[0].closed, true);
  assert.equal(f.native.entries.length, 1, 'no automatic retry or fallback poll');
  await f.watcher.sync();
  assert.equal(f.native.entries.length, 2);
  assert.deepEqual(f.changes, [], 'same bindings do not get repeated bootstrap on recovery');
  f.native.entries[0].callback('change', 'rollout.jsonl');
  f.native.emit('change', 'rollout.jsonl'); await pause();
  assert.deepEqual(new Set(f.changes), new Set(['a', 'b']));
});

test('synchronous native setup errors are reported and a later sync can install a watcher', async t => {
  const f = fixture(t);
  f.native.failNext(new Error('missing session directory'));
  await f.watcher.sync();
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].projectId, 'a');
  assert.deepEqual(f.changes, ['a']);
  f.changes.length = 0;
  await f.watcher.sync();
  assert.equal(f.native.entries.length, 1);
  f.native.emit('change', 'rollout.jsonl'); await pause();
  assert.deepEqual(f.changes, ['a']);
});

test('async sync only applies its newest resolution; stop invalidates in-flight resolution', async t => {
  const native = mockNativeWatch(), changes = [], pending = [];
  const watcher = new SessionWatcher({ resolveSessions: () => new Promise(resolve => pending.push(resolve)), onChange: id => changes.push(id), watchImpl: native.watchImpl });
  t.after(() => watcher.stop());
  const oldSync = watcher.sync(), newSync = watcher.sync();
  pending[1]([session('new')]); await newSync;
  pending[0]([session('old', 'old.jsonl')]); await oldSync;
  assert.deepEqual(changes, ['new']);
  assert.equal(native.entries.length, 1);
  const stoppedSync = watcher.sync();
  watcher.stop(); pending[2]([session('late')]); await stoppedSync;
  assert.deepEqual(changes, ['new']);
  assert.equal(native.entries.length, 1);
});

test('resolver errors preserve existing subscription and report safely without periodic retry', async t => {
  const f = fixture(t);
  await f.watcher.sync(); f.changes.length = 0;
  f.watcher.resolveSessions = async () => { throw new Error('resolution failed'); };
  await f.watcher.sync(); await pause();
  assert.deepEqual(f.errors.map(item => item.projectId), ['a']);
  assert.equal(f.native.entries[0].closed, false);
  f.native.emit('change', 'rollout.jsonl'); await pause();
  assert.deepEqual(f.changes, ['a']);
});

test('async callback failures are contained and reported without breaking native subscriptions', async t => {
  const native = mockNativeWatch(), errors = [];
  const watcher = new SessionWatcher({ resolveSessions: async () => [session('a')], watchImpl: native.watchImpl, delay: 10,
    onChange: async () => { throw new Error('background scheduling failed'); },
    onError: async (id, error) => { errors.push({ id, error }); throw new Error('error UI unavailable'); },
  });
  t.after(() => watcher.stop());
  await watcher.sync(); await pause();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 'a');
  native.emit('change', 'rollout.jsonl'); await pause();
  assert.equal(errors.length, 2);
  assert.equal(native.entries[0].closed, false);
});

test('native directory notifications detect a real rollout append and replacement in an isolated fixture', async t => {
  const base = path.resolve(__dirname, '../.test-tmp'); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'native-session-watch-'));
  const file = path.join(directory, 'rollout.jsonl'); await fs.writeFile(file, '{}\n');
  const changes = [], errors = [];
  const watcher = new SessionWatcher({ resolveSessions: async () => [{ projectId: 'native', path: file }], onChange: id => changes.push(id), onError: (_, error) => errors.push(error), delay: 20 });
  t.after(async () => { watcher.stop(); assert.ok(directory.startsWith(base + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  const eventually = async predicate => { const end = Date.now() + 2000; while (!predicate()) { assert.ok(Date.now() < end, 'native directory notification timed out'); await pause(10); } };
  await watcher.sync(); assert.deepEqual(changes, ['native']); changes.length = 0;
  await fs.appendFile(file, '{"append":true}\n'); await eventually(() => changes.length > 0);
  await pause(); changes.length = 0;
  await fs.rename(file, path.join(directory, 'previous.jsonl'));
  await fs.writeFile(file, '{"replacement":true}\n');
  await eventually(() => changes.length > 0);
  assert.deepEqual(errors, []);
});
