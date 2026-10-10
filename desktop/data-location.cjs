'use strict';

const fs = require('node:fs');
const path = require('node:path');

function absolute(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label}不能为空`);
  return path.resolve(value);
}

function inspectState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Do not migrate or repair anything during selection. An unreadable or
    // malformed archive belongs to Store's existing recovery path, not an
    // implicit switch to a different empty workspace.
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1
      || !state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)
      || !Array.isArray(state.projects)) return { status: 'unknown', projectCount: 0 };
    return { status: state.projects.length ? 'populated' : 'empty', projectCount: state.projects.length };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'unknown', projectCount: 0 };
  }
}

function inspectDataDirectory(dataDir) {
  const directory = absolute(dataDir, '数据目录');
  const primary = inspectState(path.join(directory, 'store.json'));
  const backup = inspectState(path.join(directory, 'store.backup.json'));
  const states = [primary.status, backup.status];
  const status = states.includes('populated') ? 'populated' : states.includes('unknown') ? 'unknown' : 'empty';
  return { status, primary: primary.status, backup: backup.status, projectCount: Math.max(primary.projectCount, backup.projectCount) };
}

function findPortableExecutable({ root } = {}) {
  const executable = path.join(absolute(root, '项目目录'), 'release', 'FDE Desk-win32-x64', 'FDE Desk.exe');
  try { return fs.statSync(executable).isFile() ? executable : ''; }
  catch { return ''; }
}

function resolveLegacyDataDirectory({ root, isPackaged, execPath, env = process.env } = {}) {
  const override = env?.FDE_DATA_DIR;
  if (override != null && typeof override !== 'string') throw new TypeError('FDE_DATA_DIR 必须是路径文字');
  if (typeof override === 'string' && override.trim()) return path.resolve(override);
  if (isPackaged) return path.join(path.dirname(absolute(execPath, '程序路径')), 'data');
  const directory = absolute(root, '项目目录');
  const local = path.join(directory, 'data');
  if (inspectDataDirectory(local).status !== 'empty') return local;
  const portable = findPortableExecutable({ root: directory });
  if (!portable) return local;
  const existing = path.join(path.dirname(portable), 'data');
  return inspectDataDirectory(existing).status === 'populated' ? existing : local;
}

function resolveDataDirectory({ env = process.env, localAppData } = {}) {
  const override = env?.FDE_DATA_DIR;
  if (override != null && typeof override !== 'string') throw new TypeError('FDE_DATA_DIR 必须是路径文字');
  if (typeof override === 'string' && override.trim()) return path.resolve(override);
  const base = localAppData || env.LOCALAPPDATA || (process.platform === 'win32' ? path.join(require('node:os').homedir(), 'AppData', 'Local') : path.join(require('node:os').homedir(), '.local', 'share'));
  return path.join(absolute(base, '本地应用数据目录'), 'FDE Desk', 'data');
}

module.exports = { resolveDataDirectory, resolveLegacyDataDirectory, inspectDataDirectory, findPortableExecutable };
