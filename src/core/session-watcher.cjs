'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

// Native directory notifications survive replacement of the rollout file. The
// caller explicitly syncs bindings after project/link changes; there is no poll.
class SessionWatcher {
  constructor({ resolveSessions, onChange, onError = () => {}, delay = 1500, watchImpl = fs.watch }) {
    if (typeof resolveSessions !== 'function' || typeof onChange !== 'function' || typeof onError !== 'function' || typeof watchImpl !== 'function') throw new TypeError('会话监听回调无效');
    if (!Number.isFinite(delay) || delay < 0 || delay > 60_000) throw new TypeError('会话监听延迟无效');
    Object.assign(this, { resolveSessions, onChange, onError, delay, watchImpl });
    this.bindings = new Map();
    this.directories = new Map();
    this.timers = new Map();
    this.revision = 0;
    this.stopped = false;
  }

  report(projectId, error) {
    if (this.stopped) return;
    try {
      const result = this.onError(projectId, error instanceof Error ? error : new Error('会话文件监听失败'));
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch { /* A UI error handler must not break other subscriptions. */ }
  }

  notify(projectId) {
    if (this.stopped || ![...this.bindings.values()].some(binding => binding.projectId === projectId)) return;
    try {
      const result = this.onChange(projectId);
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(error => this.report(projectId, error));
    } catch (error) { this.report(projectId, error); }
  }

  cancel(projectId) {
    clearTimeout(this.timers.get(projectId));
    this.timers.delete(projectId);
  }

  debounce(projectId) {
    this.cancel(projectId);
    const timer = setTimeout(() => {
      if (this.timers.get(projectId) !== timer) return;
      this.timers.delete(projectId);
      this.notify(projectId);
    }, this.delay);
    timer.unref?.();
    this.timers.set(projectId, timer);
  }

  close(entry) {
    entry.closing = true;
    try { entry.watcher?.close(); } catch { /* Already closed by the OS. */ }
    if (this.directories.get(entry.key) === entry) this.directories.delete(entry.key);
  }

  failed(entry, error) {
    if (this.stopped || this.directories.get(entry.key) !== entry) return;
    const projects = new Set(entry.bindings.map(binding => binding.projectId));
    this.close(entry);
    for (const projectId of projects) { this.cancel(projectId); this.report(projectId, error); }
  }

  watch(directory, bindings) {
    if (this.stopped) return;
    const key = pathKey(directory);
    const entry = { key, directory, bindings, watcher: null, closing: false };
    this.directories.set(key, entry);
    try {
      entry.watcher = this.watchImpl(directory, { persistent: false }, (eventType, filename) => {
        if (this.stopped || this.directories.get(key) !== entry || !['rename', 'change'].includes(eventType)) return;
        const name = filename == null ? null : pathKey(Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename));
        const projects = new Set(entry.bindings.filter(binding => name === null || binding.name === name).map(binding => binding.projectId));
        for (const projectId of projects) this.debounce(projectId);
      });
      if (!entry.watcher || typeof entry.watcher.close !== 'function') throw new TypeError('会话文件监听不可用');
      entry.watcher.on?.('error', error => this.failed(entry, error));
      entry.watcher.on?.('close', () => {
        if (!entry.closing) this.failed(entry, new Error('会话文件监听已关闭，请重新关联或重试'));
      });
      entry.watcher.unref?.();
    } catch (error) { this.failed(entry, error); }
  }

  async sync() {
    if (this.stopped) return;
    const revision = ++this.revision;
    let sessions;
    try { sessions = await this.resolveSessions(); }
    catch (error) {
      if (this.stopped || revision !== this.revision) return;
      const projects = new Set([...this.bindings.values()].map(binding => binding.projectId));
      for (const projectId of projects.size ? projects : ['']) this.report(projectId, error);
      return;
    }
    if (this.stopped || revision !== this.revision) return;
    if (!Array.isArray(sessions)) {
      this.report('', new TypeError('会话关联列表无效'));
      return;
    }
    const next = new Map(), groups = new Map(), bootstrap = new Set(), changedProjects = new Set();
    for (const session of sessions) {
      const projectId = session?.projectId, file = session?.path;
      if (typeof projectId !== 'string' || !projectId || typeof file !== 'string' || !file || !path.isAbsolute(file)) {
        this.report(typeof projectId === 'string' ? projectId : '', new TypeError('会话文件路径或项目编号无效'));
        continue;
      }
      const absolute = path.normalize(file), directory = path.dirname(absolute), key = `${projectId}\0${pathKey(absolute)}`;
      if (next.has(key)) continue;
      const binding = { projectId, path: absolute, directory, name: pathKey(path.basename(absolute)) };
      next.set(key, binding);
      if (!this.bindings.has(key)) { bootstrap.add(projectId); changedProjects.add(projectId); }
      const groupKey = pathKey(directory);
      if (!groups.has(groupKey)) groups.set(groupKey, { directory, bindings: [] });
      groups.get(groupKey).bindings.push(binding);
    }
    for (const [key, binding] of this.bindings) if (!next.has(key)) changedProjects.add(binding.projectId);
    for (const projectId of changedProjects) this.cancel(projectId);
    this.bindings = next;
    for (const [key, entry] of this.directories) {
      const group = groups.get(key);
      if (!group) this.close(entry);
      else entry.bindings = group.bindings;
    }
    for (const [key, group] of groups) if (!this.directories.has(key)) this.watch(group.directory, group.bindings);
    for (const projectId of bootstrap) this.notify(projectId);
  }

  stop() {
    this.stopped = true;
    this.revision++;
    for (const projectId of this.timers.keys()) this.cancel(projectId);
    for (const entry of this.directories.values()) this.close(entry);
    this.bindings.clear();
  }
}

module.exports = { SessionWatcher };
