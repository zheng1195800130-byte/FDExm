'use strict';

// Read-only compatibility adapter for Codex's local rollout files. This is an
// internal, version-dependent format, not a supported Codex API. Never write to
// Codex home, inspect credentials, or launch Codex. Project-day collection is
// explicit and confined to the project's exact development directory.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const realpath = require('node:util').promisify(require('node:fs').realpath);

const MAX_FILES = 2500;
const MAX_ENTRIES = 12000;
const MAX_LINE = 2 * 1024 * 1024;
const MAX_READ = 96 * 1024 * 1024;
const MAX_HISTORY_READ = 1024 * 1024 * 1024;
const MAX_TURNS = 500;
const MAX_DATES = 4000;
const SESSION_ROOTS = ['sessions', 'archived_sessions'];
const metadataCache = new Map();
const readCache = new Map();
const COMPAT_WARNING = '本地 Codex 会话格式属于兼容读取，升级后可能需要适配；内容仅供人工确认，不代表任务已完成。';
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function localDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(dateFormatter.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeCwd(value) {
  if (!value || typeof value !== 'string') return '';
  // The imported rollout may use Windows paths even while tests run on Linux.
  if (/^[a-z]:[\\/]/i.test(value)) return path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function codexHomePath(home) {
  return path.resolve(home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

async function sessionFiles(home) {
  const codexHome = codexHomePath(home);
  try {
    const homeStat = await fs.lstat(codexHome);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) return [];
    const realHome = await realpath(codexHome);
    const files = [];
    const queue = [];
    for (const name of SESSION_ROOTS) {
      const root = path.join(codexHome, name);
      try {
        const stat = await fs.lstat(root), realRoot = await realpath(root);
        if (stat.isDirectory() && !stat.isSymbolicLink() && inside(realHome, realRoot)) queue.push({ directory: root, root, realRoot, depth: 0, archived: name === 'archived_sessions' });
      } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
    }
    let count = 0;
    while (queue.length && files.length < MAX_FILES && count < MAX_ENTRIES) {
      const { directory, root, realRoot, depth, archived } = queue.shift();
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of entries) {
        if (++count > MAX_ENTRIES || files.length >= MAX_FILES) break;
        if (entry.isSymbolicLink()) continue;
        const candidate = path.join(directory, entry.name);
        if (!inside(root, candidate)) continue;
        if (entry.isDirectory() && depth < 8) queue.push({ directory: candidate, root, realRoot, depth: depth + 1, archived });
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          // Recheck links and containment to avoid following a swapped directory.
          try {
            const stat = await fs.lstat(candidate);
            const real = await realpath(candidate);
            if (stat.isFile() && !stat.isSymbolicLink() && inside(realRoot, real)) files.push({ path: candidate, stat, archived });
          } catch { /* A running Codex may rotate files. */ }
        }
      }
    }
    files.truncated = queue.length > 0 || files.length >= MAX_FILES || count >= MAX_ENTRIES;
    return files;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return [];
    throw error;
  }
}

function ignoredLargeLine(line) {
  // Only recognize an unambiguous top-level prefix. Compaction snapshots and
  // tool payloads are replay/context data, never a user's original work turn.
  // Do not parse or retain their potentially enormous media/encoded bodies.
  const prefix = /^\s*\{\s*(?:(?:"timestamp"\s*:\s*"(?:\\.|[^"\\])*"|"ordinal"\s*:\s*\d+)\s*,\s*)*"type"\s*:\s*"([a-z_]+)"\s*,\s*/.exec(line);
  if (!prefix) return false;
  if (['compacted', 'world_state', 'token_usage_record', 'inter_agent_communication_metadata'].includes(prefix[1])) return true;
  if (prefix[1] !== 'response_item') return false;
  const item = /^"payload"\s*:\s*\{\s*"type"\s*:\s*"([a-z_]+)"/.exec(line.slice(prefix[0].length));
  return Boolean(item && ['reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'agent_message'].includes(item[1]));
}

async function scanLines(file, visit, maxBytes = MAX_READ, startByte = 0) {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024, start: startByte });
  let buffer = '';
  let bytes = 0;
  let dropping = startByte > 0;
  let incomplete = startByte > 0;
  let bytesLimited = startByte > 0;
  let skippedOversize = 0;
  try {
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { incomplete = true; bytesLimited = true; break; }
      let rest = chunk;
      if (dropping) {
        const end = rest.indexOf('\n');
        if (end < 0) continue;
        rest = rest.slice(end + 1);
        dropping = false;
      }
      buffer += rest;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.length > MAX_LINE) {
          if (!ignoredLargeLine(line)) { incomplete = true; skippedOversize++; }
          continue;
        }
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (visit(value) === false) return { incomplete: false, bytesLimited: false, skippedOversize };
      }
      if (buffer.length > MAX_LINE) {
        if (!ignoredLargeLine(buffer)) { incomplete = true; skippedOversize++; }
        buffer = ''; dropping = true;
      }
    }
    if (buffer && !dropping) {
      try { visit(JSON.parse(buffer)); } catch { /* A partially written last line is normal. */ }
    }
  } finally { stream.destroy(); }
  return { incomplete, bytesLimited, skippedOversize };
}

function cleanText(value, max = 10000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/gi, '')
    .replace(/<codex_apps_open_page_instructions>[\s\S]*?<\/codex_apps_open_page_instructions>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/gi, '')
    .replace(/#\s*AGENTS\.md instructions\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, '')
    .replace(/data:[a-z0-9/+.-]+(?:;[a-z0-9=.-]+)*;base64,[a-z0-9+/=\r\n]+/gi, '[媒体数据已省略]')
    .replace(/\b[A-Za-z0-9+/]{512,}={0,2}/g, '[长编码内容已省略]')
    .trim().slice(0, max);
}

function contentText(content) {
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return '';
  return cleanText(content.filter(part => part && ['input_text', 'output_text', 'text'].includes(part.type))
    .map(part => part.text || '').join('\n'));
}

function mediaReferences(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(part => part && /image|file|audio|video/i.test(part.type || '') && !/text/i.test(part.type || ''))
    .slice(0, 20).map(part => {
      const raw = part.path || part.file_path || part.image_url?.url || part.image_url || '';
      const localPath = typeof raw === 'string' && !/^(data:|https?:)/i.test(raw) ? raw.slice(0, 1000) : '';
      return { type: part.type, ...(localPath ? { path: localPath } : {}), description: '原会话媒体附件；未读取媒体内容' };
    });
}

function getMessage(entry) {
  const payload = entry.payload || entry;
  if ((entry.type === 'response_item' && payload.type === 'message') || entry.type === 'message' || (!entry.type && entry.role && entry.content)) {
    if (!['user', 'assistant'].includes(payload.role)) return null;
    if (payload.role === 'assistant' && ((payload.channel && payload.channel !== 'final') || (payload.phase && payload.phase !== 'final_answer'))) return null;
    return { role: payload.role, text: contentText(payload.content), attachments: mediaReferences(payload.content), final: payload.channel === 'final' || payload.phase === 'final_answer' };
  }
  if (entry.type !== 'event_msg') return null;
  if (payload.type === 'user_message') return { role: 'user', text: cleanText(payload.message), attachments: mediaReferences(payload.content) };
  if (payload.type === 'agent_message') {
    if ((payload.channel && payload.channel !== 'final') || (payload.phase && payload.phase !== 'final_answer')) return null;
    return { role: 'assistant', text: cleanText(payload.message), attachments: [], final: payload.channel === 'final' || payload.phase === 'final_answer' };
  }
  if (payload.type === 'item_completed') {
    const item = payload.item || {};
    if (!['UserMessage', 'AgentMessage', 'user_message', 'agent_message'].includes(item.type)) return null;
    if (item.channel && item.channel !== 'final') return null;
    return { role: /user/i.test(item.type) ? 'user' : 'assistant', text: contentText(item.content), attachments: mediaReferences(item.content), final: item.channel === 'final' };
  }
  return null;
}

async function metadata(file) {
  const key = `${file.stat.size}:${file.stat.mtimeMs}`;
  const cached = metadataCache.get(file.path);
  if (cached?.key === key) return cached.thread;
  let meta = null;
  let title = '';
  let rejected = false;
  const filenameId = path.basename(file.path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
  await scanLines(file.path, entry => {
    // Fork rollouts write their own metadata first, then replay the parent's
    // metadata/history. Identity must never be replaced by that inherited copy.
    if (!meta) {
      let candidate = null;
      if (entry.type === 'session_meta' || (!entry.type && entry.payload && (entry.payload.id || entry.payload.session_id))) candidate = entry.payload || {};
      else if (!entry.type && entry.id && entry.cwd) candidate = entry;
      if (candidate && (candidate.id || candidate.session_id) && typeof candidate.cwd === 'string') {
        meta = candidate;
        const ownId = String(meta.id || meta.session_id);
        // In spawned agents session_id may still refer to the parent. id and
        // the actual rollout filename identify the child, which is not a chat
        // the user should accidentally bind as their main Codex conversation.
        rejected = Boolean(meta.source && typeof meta.source === 'object' && meta.source.subagent)
          || Boolean(filenameId && filenameId.toLowerCase() !== ownId.toLowerCase());
        if (rejected) return false;
      }
    }
    const message = getMessage(entry);
    if (!title && message?.role === 'user' && message.text) title = message.text.replace(/\s+/g, ' ').slice(0, 90);
    if (meta && title) return false;
  }, 4 * 1024 * 1024);
  if (rejected || !meta || !(meta.id || meta.session_id) || typeof meta.cwd !== 'string') return null;
  const thread = {
    id: String(meta.id || meta.session_id), title: title || '未命名 Codex 会话', cwd: meta.cwd,
    path: file.path, updatedAt: file.stat.mtime.toISOString(), archived: !!file.archived,
  };
  if (metadataCache.size >= MAX_FILES) metadataCache.delete(metadataCache.keys().next().value);
  metadataCache.set(file.path, { key, thread });
  return thread;
}

async function listThreads({ cwd, home } = {}) {
  const files = await sessionFiles(home);
  const threads = [];
  // Small batches prevent thousands of simultaneous open file descriptors.
  for (let offset = 0; offset < files.length; offset += 12) {
    const batch = await Promise.all(files.slice(offset, offset + 12).map(file => metadata(file).catch(() => null)));
    for (const thread of batch) if (thread && (!cwd || normalizeCwd(thread.cwd) === normalizeCwd(cwd))) threads.push(thread);
  }
  const seen = new Set();
  const result = threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(thread => {
    if (seen.has(thread.id)) return false;
    seen.add(thread.id);
    return true;
  });
  Object.defineProperty(result, 'truncated', { value: !!files.truncated });
  return result;
}

// A bound thread normally keeps the same path. Revalidate that path without
// enumerating every session folder on each watched change. Cached metadata is
// never a substitute for checking containment and symbolic links again.
async function knownThread({ threadId, cwd, home }) {
  const codexHome = codexHomePath(home);
  for (const [file, cached] of metadataCache) {
    const rootName = SESSION_ROOTS.find(name => inside(path.join(codexHome, name), file));
    if (cached.thread.id !== threadId || !rootName || (cwd && normalizeCwd(cached.thread.cwd) !== normalizeCwd(cwd))) continue;
    const sessions = path.join(codexHome, rootName);
    try {
      const relative = path.relative(codexHome, file);
      let current = codexHome;
      const homeStat = await fs.lstat(current);
      if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) continue;
      for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || (current !== file && !stat.isDirectory())) throw new Error('Unsafe session path');
      }
      const [realHome, realSessions, realFile, stat] = await Promise.all([
        realpath(codexHome), realpath(sessions), realpath(file), fs.lstat(file),
      ]);
      if (!inside(realHome, realSessions) || !inside(realSessions, realFile) || !stat.isFile() || stat.isSymbolicLink()) continue;
      const thread = await metadata({ path: file, stat, archived: rootName === 'archived_sessions' });
      if (thread?.id === threadId && (!cwd || normalizeCwd(thread.cwd) === normalizeCwd(cwd))) return { thread, stat };
    } catch {
      metadataCache.delete(file);
      for (const key of readCache.keys()) if (key.startsWith(`${file}\0`)) readCache.delete(key);
    }
  }
  return null;
}

function cloneResult(result) {
  return typeof structuredClone === 'function' ? structuredClone(result) : JSON.parse(JSON.stringify(result));
}

function rememberRead(file, stamp, result) {
  // LRU cache of bounded summaries only; no raw JSONL or tool results retained.
  readCache.delete(file);
  readCache.set(file, { stamp, result: cloneResult(result) });
  while (readCache.size > 8) readCache.delete(readCache.keys().next().value);
}

async function readThread({ threadId, cwd, home, history = false, date } = {}) {
  if (typeof threadId !== 'string' || !threadId || threadId.length > 200) throw new Error('请主动关联一个 Codex 会话。');
  if (date !== undefined && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || localDate(`${date}T04:00:00Z`) !== date)) throw new Error('工作日期格式无效。');
  const mode = date ? 'date' : history ? 'history' : 'recent';
  const known = await knownThread({ threadId, cwd, home });
  const thread = known?.thread || (await listThreads({ cwd, home })).find(item => item.id === threadId);
  if (!thread) throw new Error('没有找到匹配项目的 Codex 会话，或该会话已不可读取。');
  const currentStat = known?.stat || await fs.stat(thread.path);
  const stamp = `${thread.id}:${currentStat.size}:${currentStat.mtimeMs}`;
  const cacheKey = `${thread.path}\0${mode}:${date || ''}`;
  const previous = readCache.get(cacheKey);
  if (previous?.stamp === stamp) {
    readCache.delete(cacheKey);
    readCache.set(cacheKey, previous);
    return cloneResult(previous.result);
  }
  let active = null;
  let serial = 0;
  let dropped = false;
  let datesLimited = false;
  const turns = [];
  const discoveredDates = new Set();
  function discover() {
    const value = localDate(active?.timestamp);
    if (!value || discoveredDates.has(value)) return;
    if (discoveredDates.size >= MAX_DATES) { datesLimited = true; return; }
    discoveredDates.add(value);
  }
  function retain() {
    if (active.retained || (date && localDate(active.timestamp) !== date)) return;
    active.retained = true;
    turns.push(active);
    if (turns.length > MAX_TURNS) { turns.shift(); dropped = true; }
  }
  function start(id, timestamp, explicit = false) {
    // Legacy rollouts have no final marker. A later user turn closes their
    // preceding answer, while an interrupted explicit task stays incomplete.
    if (active && !active.explicit && active.assistantText) active.final = true;
    active = {
      id: id || `turn-${++serial}`, threadId: thread.id, timestamp: timestamp || '',
      userText: '', assistantText: '', attachments: [], explicit, final: false,
    };
    retain();
    return active;
  }
  const scanBudget = mode === 'recent' ? MAX_READ : MAX_HISTORY_READ;
  const startByte = mode === 'recent' ? Math.max(0, currentStat.size - MAX_READ) : 0;
  const { incomplete, bytesLimited, skippedOversize } = await scanLines(thread.path, entry => {
    const payload = entry.payload || {};
    const timestamp = entry.timestamp || payload.timestamp || '';
    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      start(payload.turn_id, timestamp, true);
      return;
    }
    if (entry.type === 'turn_context' && payload.turn_id && active?.id !== payload.turn_id) {
      if (!active || active.userText || active.assistantText) start(payload.turn_id, timestamp, true);
      else { active.id = payload.turn_id; active.explicit = true; }
      return;
    }
    if (entry.type === 'event_msg' && payload.type === 'task_complete') {
      if (!active) return;
      if (payload.turn_id && active.id !== payload.turn_id) return;
      const last = cleanText(typeof payload.last_agent_message === 'string' ? payload.last_agent_message : payload.last_agent_message?.text);
      if (last) active.assistantText = last;
      if (active.assistantText) active.final = true;
      if (active.assistantText) discover();
      return;
    }
    const message = getMessage(entry);
    if (!message || (!message.text && !message.attachments.length)) return;
    if (!active) start(null, timestamp);
    if (message.role === 'user') {
      const text = cleanText(message.text, 5000);
      const mirror = text && active.userText === text && !active.assistantText;
      if (!mirror && active.userText && !active.explicit) start(null, timestamp);
      if (!active.timestamp && timestamp) { active.timestamp = timestamp; retain(); }
      if (text && !mirror) active.userText = cleanText([active.userText, text].filter(Boolean).join('\n'), 5000);
      for (const attachment of message.attachments) {
        const key = JSON.stringify(attachment);
        if (!active.attachments.some(value => JSON.stringify(value) === key)) active.attachments.push(attachment);
      }
    } else if (message.text && (!active.final || message.final)) {
      // Keep the final/latest summary, not every commentary in a long run.
      active.assistantText = cleanText(message.text);
      active.final = Boolean(message.final);
    }
    if (active.userText || active.assistantText || active.attachments.length) discover();
  }, scanBudget, startByte);
  const output = turns.filter(turn => turn.userText || turn.assistantText || turn.attachments.length).map(turn => ({
    id: turn.id, threadId: thread.id, timestamp: turn.timestamp, date: localDate(turn.timestamp),
    userText: turn.userText, assistantText: turn.assistantText, attachments: turn.attachments,
    completed: Boolean(turn.final && turn.assistantText),
    sourceRef: `${thread.path}#turn=${encodeURIComponent(turn.id)}`,
  }));
  const workTruncated = Boolean(bytesLimited || dropped || datesLimited || skippedOversize);
  const truncated = Boolean(incomplete || dropped || datesLimited);
  const result = {
    thread: { id: thread.id, title: thread.title, cwd: thread.cwd }, turns: output,
    discoveredDates: [...discoveredDates].sort(), workTruncated,
    coverage: { mode, requestedDate: date || '', sourceStamp: stamp, scanComplete: !bytesLimited, retainedDates: [...new Set(output.map(turn => turn.date).filter(Boolean))].sort() },
    truncated,
    warning: `${COMPAT_WARNING}${truncated ? ' 会话较大，已限制读取范围；请核对遗漏内容。' : ''}${skippedOversize ? ' 部分超长消息已省略，媒体可回原会话查看。' : ''}`,
  };
  rememberRead(cacheKey, stamp, result);
  return result;
}

// Called only by an explicit organization action. Metadata must match the
// exact cwd; parent/sibling directories and spawned agents are never included.
async function readProjectDay({ threadId, cwd, home, date } = {}) {
  if (typeof threadId !== 'string' || !threadId || threadId.length > 200 || !normalizeCwd(cwd)) throw new Error('请先关联项目会话并指定工作日期。');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || localDate(`${date}T04:00:00Z`) !== date) throw new Error('工作日期格式无效。');
  const candidates = await listThreads({ cwd, home });
  if (!candidates.length) throw new Error('没有找到匹配项目的 Codex 会话（含已归档会话），请核对开发目录。已有收录仍保留。');
  // An unchanged rollout older than the requested day cannot contain new
  // work from that day. Keep the bound entry even when it is old, and avoid
  // scanning unrelated earlier months or attributing their omissions to today.
  const ordered = candidates.filter(thread => thread.id === threadId || localDate(thread.updatedAt) >= date)
    .sort((a, b) => Number(b.id === threadId) - Number(a.id === threadId) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const selected = ordered.slice(0, 60), threads = [], turns = [], warnings = [], seen = new Set();
  let partial = !!candidates.truncated || ordered.length > selected.length;
  if (partial) warnings.push('会话数量超过本次读取范围，请核对遗漏内容');
  if (!candidates.some(thread => thread.id === threadId)) warnings.push('原关联会话不可读取，已接续同一开发目录的其他会话，并保留已有收录');
  for (const thread of selected) {
    let result;
    try { result = await module.exports.readThread({ threadId: thread.id, cwd, home, history: true, date }); }
    catch { partial = true; warnings.push(`会话 ${thread.id} 未能读取，已有收录保留`); continue; }
    threads.push({ ...result.thread, archived: thread.archived });
    partial ||= !!(result.workTruncated ?? result.truncated);
    if (result.workTruncated ?? result.truncated) warnings.push(`会话 ${thread.id} 部分原文未读取`);
    for (const turn of result.turns.filter(turn => turn.date === date)) {
      // Forks can replay a parent's completed turns. Only identical evidence
      // with the same original turn and time is a duplicate, never equal text alone.
      const key = JSON.stringify([turn.id, turn.timestamp, turn.userText, turn.assistantText, turn.attachments]);
      if (seen.has(key)) continue;
      seen.add(key);
      turns.push({ ...turn, id: thread.id === threadId ? turn.id : `${thread.id}:${turn.id}`, originalTurnId: turn.id, threadId: thread.id });
    }
  }
  if (!threads.length) throw new Error('项目会话暂无法读取，已有收录和整理结果仍保留，请稍后重试。');
  turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  return { turns, threads, truncated: partial, workTruncated: partial, warning: warnings.join('；') };
}

function fieldsFrom(text) {
  let fields = {};
  for (const line of cleanText(text).split(/\r?\n/)) {
    const plain = line.replace(/^\s*(?:[-*#]+\s*|\d+[.、]\s*)/, '').replace(/\*\*/g, '').trim();
    const match = plain.match(/^(问题|事项|原因|处理|解决方式|解决办法|结果|状态)[：:]\s*(.+)$/);
    if (!match) continue;
    const key = { 问题: 'title', 事项: 'title', 原因: 'cause', 处理: 'action', 解决方式: 'action', 解决办法: 'action', 结果: 'result', 状态: 'result' }[match[1]];
    if (key === 'title') fields = {}; // Never attach the previous issue's cause to a new issue.
    fields[key] = match[2].slice(0, 1200);
  }
  return fields;
}

function draftId(type, origin, text) {
  return `${type}-${crypto.createHash('sha256').update(`${origin.threadId}:${origin.turnId}:${text}`).digest('hex').slice(0, 16)}`;
}

function extractDrafts(turns = []) {
  const requirements = [];
  const records = [];
  const seen = new Set();
  for (const turn of Array.isArray(turns) ? turns : []) {
    const origin = { threadId: turn.threadId || '', turnId: turn.id || '' };
    const sourceRef = turn.sourceRef || '';
    for (const rawLine of cleanText(turn.userText, 5000).split(/\r?\n/)) {
      const line = rawLine.replace(/^\s*(?:[-*]+\s*|\d+[.、]\s*)/, '').replace(/\*\*/g, '').trim();
      const match = line.match(/^(?:(?:需求|补充需求|新增需求|客户需求|用户需求)[：:]\s*|(?:我|客户|用户)(?:希望|需要|要求)\s*)(.{4,1000})$/);
      if (!match || /[？?]$/.test(line)) continue;
      const description = match[1].trim();
      const key = `requirement:${description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requirements.push({ id: draftId('req', origin, description), title: description.slice(0, 100), description, status: '待确认', sourceRef, origin });
    }
    const userFields = fieldsFrom(turn.userText);
    const assistantFields = fieldsFrom(turn.assistantText);
    const fields = { ...userFields, ...assistantFields };
    // No semantic guessing: only a named issue with explicit handling/outcome.
    // Never infer a cause or claim verification from file changes or discussion.
    if (!fields.title || (!assistantFields.action && !assistantFields.result)) continue;
    const key = `record:${turn.date}:${JSON.stringify(fields)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      id: draftId('record', origin, JSON.stringify(fields)), date: turn.date || localDate(turn.timestamp),
      title: fields.title.slice(0, 120), cause: assistantFields.cause || '', action: assistantFields.action || '',
      result: assistantFields.result || '', status: '待确认', sourceRef, origin,
    });
  }
  return { requirements, records };
}

module.exports = { listThreads, readThread, readProjectDay, extractDrafts };
