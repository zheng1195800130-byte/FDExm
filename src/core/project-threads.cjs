'use strict';

const path = require('node:path');
const codex = require('./codex.cjs');

const MAX_DISTANCE = 2;
const MIN_SCOPE_DEPTH = 2;
const MAX_CANDIDATES = 40;

function directoryParts(value) {
  if (typeof value !== 'string' || !value.trim() || /\u0000/.test(value)) return null;
  const windows = /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
  if (windows) {
    if (/^(?:\\\\|\/\/)[?.][\\/]/.test(value)) return null;
    const normalized = path.win32.normalize(value).toLowerCase();
    const root = path.win32.parse(normalized).root;
    return { flavor: 'windows', root, parts: normalized.slice(root.length).split(/[\\/]+/).filter(Boolean) };
  }
  if (!path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  return { flavor: 'posix', root: '/', parts: normalized.split('/').filter(Boolean) };
}

function relationship(selected, candidate) {
  if (!candidate || selected.flavor !== candidate.flavor || selected.root !== candidate.root) return null;
  const common = Math.min(selected.parts.length, candidate.parts.length);
  for (let index = 0; index < common; index++) if (selected.parts[index] !== candidate.parts[index]) return null;
  const distance = Math.abs(selected.parts.length - candidate.parts.length);
  if (!distance || distance > MAX_DISTANCE) return null;
  if (candidate.parts.length < selected.parts.length) {
    if (candidate.parts.length < MIN_SCOPE_DEPTH) return null;
    return { relation: 'parent', distance };
  }
  return { relation: 'child', distance };
}

function projectDirectoryRelation(cwd, candidateCwd) {
  const selected = directoryParts(cwd);
  if (!selected || selected.parts.length < MIN_SCOPE_DEPTH) return null;
  return relationship(selected, directoryParts(candidateCwd));
}

// Recommendations only. Exact matching and explicit binding remain owned by
// the existing Codex adapter and caller; this never reads turn text or changes
// project directories, and never searches sibling projects by a text prefix.
async function listProjectThreads({ cwd, reader = codex } = {}) {
  const selected = directoryParts(cwd);
  if (!selected) throw new Error('项目开发目录无效，请选择完整目录路径');
  if (!reader || typeof reader.listThreads !== 'function') throw new TypeError('Codex 会话读取器无效');
  const threads = await reader.listThreads({ cwd });
  if (threads.length || selected.parts.length < MIN_SCOPE_DEPTH) return { threads, candidates: [] };
  const all = await reader.listThreads();
  const candidates = [];
  const seen = new Set();
  for (const thread of all) {
    const related = relationship(selected, directoryParts(thread?.cwd));
    if (!related || !thread.id || seen.has(thread.id)) continue;
    seen.add(thread.id);
    candidates.push({ ...thread, ...related });
  }
  candidates.sort((a, b) => (a.relation === 'parent' ? 0 : 1) - (b.relation === 'parent' ? 0 : 1)
    || a.distance - b.distance || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a.id).localeCompare(String(b.id)));
  return { threads, candidates: candidates.slice(0, MAX_CANDIDATES) };
}

module.exports = { listProjectThreads, projectDirectoryRelation };
