'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.log', '.html', '.htm', '.ini']);
const OFFICE_EXTS = new Set(['.docx', '.xlsx', '.pptx']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.tif', '.tiff', '.heic']);
const MEDIA_EXTS = new Set(['.mp3', '.mp4', '.wav', '.m4a', '.mov', '.avi', '.webm', '.aac', '.pdf', '.doc', '.xls', '.ppt', '.rtf', '.zip']);
const SOURCE_EXTS = new Set([...TEXT_EXTS, ...OFFICE_EXTS, ...IMAGE_EXTS, ...MEDIA_EXTS]);
const DEV_EXTS = new Set([...TEXT_EXTS].filter(ext => ext !== '.log').concat([...OFFICE_EXTS, ...IMAGE_EXTS, '.pdf']));
const SKIP_NAMES = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'coverage', 'target', 'bin', 'obj']);
const DEV_SKIP_NAMES = new Set(['release', 'releases', '.npm-cache', '.electron-cache', '.electron-gyp', '.fde-desk-data', 'fde-desk-data', '.smoke-data', '.demo-data', 'tmp', 'temp', '.tmp', '.pack-tmp', '.fde-build', '.fde-build-output', 'cache', 'caches', 'logs', 'log', 'runtime-cache', 'appdata', 'user-data', 'userdata', 'crashpad', 'crashreports', 'blob_storage', 'gpucache', 'code cache', 'dawncache', 'shadercache', 'd3dscache', 'session storage', 'local storage', 'service worker', 'network', 'test-output', 'test-results', 'playwright-report', 'blob-report']);
const DEV_NOISE_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'composer.json', 'composer.lock', 'bower.json', 'tsconfig.json', 'jsconfig.json', 'biome.json', 'biome.jsonc', '.eslintrc.json', '.prettierrc.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.yarnrc.yml']);
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 80_000;
const MAX_ZIP_EXPANDED = 50 * 1024 * 1024;

function canonical(value) { return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase(); }
function isWithin(candidate, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function stableId(filePath) { return crypto.createHash('sha256').update(canonical(filePath)).digest('hex').slice(0, 24); }

// The scanner and historical-index cleanup must use exactly the same rules.
// A filtered file is no longer active; it is different from an eligible file
// that went missing and should remain available for locating old evidence.
function isExcludedPath(filePath, root, kind, options = {}, isDirectory = false) {
  if (!isWithin(filePath, root)) return true;
  if ((options.exclude || []).some(excluded => isWithin(filePath, excluded))) return true;
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  const parts = relative ? relative.split(/[\\/]+/) : [];
  const directories = isDirectory ? parts : parts.slice(0, -1);
  return directories.some(part => {
    const name = part.toLowerCase();
    if (SKIP_NAMES.has(name)) return true;
    return kind === '开发成果' && (DEV_SKIP_NAMES.has(name) || /^\.(?:test|smoke)(?:[-_].*)?$/.test(name) || /^\.npm(?:[-_].*)?$/.test(name));
  });
}

function shouldIndexFile(filePath, root, kind, options = {}) {
  if (isExcludedPath(filePath, root, kind, options)) return false;
  const extension = path.extname(filePath).toLowerCase();
  const supported = kind === '开发成果' ? DEV_EXTS : SOURCE_EXTS;
  if (!supported.has(extension)) return false;
  if (kind !== '开发成果') return true;
  const name = path.basename(filePath).toLowerCase();
  return !DEV_NOISE_FILES.has(name)
    && !/^(?:tsconfig|jsconfig)(?:\.[^.]+)+\.json$/.test(name)
    && !/^(?:electron-builder|electron-forge|vite|vitest|webpack|eslint|prettier|babel|postcss|tailwind)\.config\.(?:json|ya?ml)$/.test(name)
    && !/^store(?:\.backup|\.corrupt[-.][^.]+)?\.json$/.test(name);
}
function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) { const swapped = Buffer.from(buffer.subarray(2)); swapped.swap16(); return swapped.toString('utf16le'); }
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const replacements = (utf8.match(/\uFFFD/g) || []).length;
  if (replacements > 2 && replacements / Math.max(utf8.length, 1) > 0.005) {
    try { return new TextDecoder('gb18030').decode(buffer); } catch { /* UTF-8 remains a visible fallback. */ }
  }
  return utf8.replace(/^\uFEFF/, '');
}

function gatherXmlText(node, out) {
  if (node == null) return;
  if (Array.isArray(node)) { for (const item of node) gatherXmlText(item, out); return; }
  if (typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (['w:t', 'a:t', 't', 'v'].includes(key)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item === 'string' || typeof item === 'number') out.push(String(item));
        else if (item && typeof item === 'object' && item['#text'] != null) out.push(String(item['#text']));
      }
    } else if (!key.startsWith('@_')) gatherXmlText(value, out);
  }
}

function arrayOf(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function xmlValue(value) { return value && typeof value === 'object' ? String(value['#text'] ?? '') : String(value ?? ''); }
function spreadsheetText(parsed, sharedStrings) {
  const lines = [];
  for (const row of arrayOf(parsed.worksheet?.sheetData?.row)) {
    const cells = [];
    for (const cell of arrayOf(row.c)) {
      let value = '';
      const type = cell['@_t'];
      if (type === 's') value = sharedStrings[Number(xmlValue(cell.v))] ?? '[共享文字索引缺失]';
      else if (type === 'inlineStr') { const parts = []; gatherXmlText(cell.is, parts); value = parts.join(''); }
      else if (type === 'b') value = xmlValue(cell.v) === '1' ? 'TRUE' : 'FALSE';
      else value = xmlValue(cell.v) || (cell.f ? `=${xmlValue(cell.f)}` : '');
      const column = String(cell['@_r'] || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase();
      const index = column ? [...column].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1 : cells.length;
      if (index < 2000) cells[index] = value;
    }
    if (cells.length) lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

function defaultDescription(filePath, extraction) {
  const ext = path.extname(filePath).toLowerCase();
  const lines = (extraction.text || '').split(/\r?\n/).map(value => value.trim()).filter(value => value && !/^\[[^\]]+\.xml\]$/.test(value));
  const heading = lines.find(value => /^#{1,6}\s+/.test(value));
  const excerpt = (heading || lines[0] || '').replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').slice(0, 60);
  if (excerpt) return `自动摘录：${excerpt}${(heading || lines[0]).length > 60 ? '…' : ''}`;
  if (IMAGE_EXTS.has(ext)) return '图片资料，可预览；尚未识别图片内容。';
  if (extraction.error) return '资料已索引；文字解析失败，可查看原文件。';
  return `${ext.slice(1).toUpperCase() || '文件'} 附件，保留路径供查看和使用。`;
}

async function extractText(filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return { text: '', type: 'image', note: '图片已索引，可预览；未自动识别图片文字。' };
  if (!TEXT_EXTS.has(ext) && !OFFICE_EXTS.has(ext) && ext !== '.pdf') return { text: '', type: 'attachment', note: '此格式保留文件路径和用途说明，可交给 Codex 分析。' };
  if (stat.size > MAX_TEXT_BYTES) return { text: '', type: 'document', error: '文件超过 20 MB 文本解析限制，已保留路径。' };
  try {
    let text = '';
    if (TEXT_EXTS.has(ext)) text = decode(await fsp.readFile(filePath));
    else if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(await fsp.readFile(filePath), { max: 100 });
      text = parsed.text || '';
      if (!text.trim()) return { text: '', type: 'document', error: 'PDF 未提取到文字，可能是扫描件；请在 Codex 中查看原文件。' };
    } else {
      const AdmZip = require('adm-zip');
      const { XMLParser } = require('fast-xml-parser');
      const zip = new AdmZip(await fsp.readFile(filePath));
      const entries = zip.getEntries().filter(entry => {
        if (ext === '.docx') return /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(entry.entryName);
        if (ext === '.pptx') return /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(entry.entryName);
        return /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(entry.entryName);
      }).sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
      if (entries.length > 500 || entries.reduce((total, entry) => total + (entry.header.size || 0), 0) > MAX_ZIP_EXPANDED) throw new Error('Office 文档解压后的内容超过安全解析限制');
      const parser = new XMLParser({ ignoreAttributes: false, processEntities: true, trimValues: false, parseTagValue: false });
      const parts = [];
      let sharedStrings = [];
      for (const entry of entries) {
        const parsed = parser.parse(entry.getData().toString('utf8'));
        if (ext === '.xlsx' && entry.entryName === 'xl/sharedStrings.xml') {
          sharedStrings = arrayOf(parsed.sst?.si).map(item => { const strings = []; gatherXmlText(item, strings); return strings.join(''); });
          // Workbooks without sheet content still expose their shared text for lookup.
          if (!entries.some(item => item.entryName.startsWith('xl/worksheets/'))) parts.push(sharedStrings.join('\n'));
          continue;
        }
        if (ext === '.xlsx') {
          const sheetText = spreadsheetText(parsed, sharedStrings);
          if (sheetText) parts.push(`[${entry.entryName}]\n${sheetText}`);
          continue;
        }
        const values = [];
        gatherXmlText(parsed, values);
        if (values.length) parts.push(`[${entry.entryName}]\n${values.join('\n')}`);
      }
      text = parts.join('\n\n');
      if (!text.trim()) throw new Error('未提取到 Office 正文');
    }
    const truncated = text.length > MAX_PREVIEW_CHARS;
    return { text: text.slice(0, MAX_PREVIEW_CHARS), type: 'document', ...(truncated ? { note: '文本已截取前 80,000 字符，完整内容请查看原文件。' } : {}) };
  } catch (error) {
    return { text: '', type: 'document', error: `解析失败：${error.message || '未知错误'}；原文件路径仍可使用。` };
  }
}

async function inspectFile(filePath, kind, old = null, { force = false } = {}) {
  const stat = await fsp.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('只支持普通文件，不能导入符号链接或目录');
  const unchanged = !force && old && old.size === stat.size && old.mtime === stat.mtime.toISOString();
  const extraction = unchanged ? { text: old.textPreview || '', type: old.type, note: old.previewNote, error: old.parseError } : await extractText(filePath, stat);
  const userDescription = old && (old.descriptionSource === 'user' || (!old.descriptionSource && old.description));
  return {
    id: old?.id || stableId(filePath), path: path.resolve(filePath), name: path.basename(filePath), kind,
    description: userDescription ? old.description : defaultDescription(filePath, extraction), descriptionSource: userDescription ? 'user' : 'automatic', textPreview: extraction.text || '', ext: path.extname(filePath).toLowerCase(),
    size: stat.size, mtime: stat.mtime.toISOString(), missing: false, type: extraction.type,
    previewNote: extraction.note || '', parseError: extraction.error || '',
  };
}

async function scanDirectory(root, kind, options = {}) {
  const warnings = [];
  const results = [];
  const folders = [];
  const maxFiles = options.maxFiles || 1500;
  const maxBytes = options.maxBytes || 512 * 1024 * 1024;
  let bytes = 0;
  let visited = 0;
  let limited = false;
  let rootStat;
  try { rootStat = await fsp.lstat(root); } catch { return { files: [], warnings: [`目录不存在或无法读取：${root}`], complete: false }; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { files: [], warnings: [`目录无效或属于链接：${root}`], complete: false };
  if (isExcludedPath(root, root, kind, options, true)) return { files: [], warnings: [], complete: true };
  const existing = new Map((options.existing || []).map(file => [canonical(file.path), file]));
  async function walk(dir, depth) {
    if (depth > 30) { warnings.push(`目录层级超过限制，跳过：${dir}`); return; }
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { warnings.push(`无法读取目录：${dir}`); return; }
    for (const entry of entries) {
      if (limited) return;
      const full = path.join(dir, entry.name);
      visited += 1;
      if (visited > 15_000) { limited = true; warnings.push('扫描条目达到 15,000 项限制，请缩小目录范围。'); return; }
      if (entry.isSymbolicLink() || isExcludedPath(full, root, kind, options, entry.isDirectory())) continue;
      if (entry.isDirectory()) { folders.push({path:full,name:entry.name,kind}); await walk(full, depth + 1); continue; }
      if (!entry.isFile() || !shouldIndexFile(full, root, kind, options)) continue;
      try {
        const stat = await fsp.lstat(full);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (results.length >= maxFiles || bytes + stat.size > maxBytes) { limited = true; warnings.push('达到扫描文件数量或总大小限制，部分文件未索引。'); return; }
        bytes += stat.size;
        results.push(await inspectFile(full, kind, existing.get(canonical(full)), { force: options.force }));
      } catch (error) { warnings.push(`读取失败：${full}（${error.message}）`); }
    }
  }
  await walk(root, 0);
  return { files: results, folders, warnings, complete: !limited && warnings.length === 0 };
}

module.exports = { scanDirectory, extractText, inspectFile, canonical, isWithin, isExcludedPath, shouldIndexFile, IMAGE_EXTS, SOURCE_EXTS, DEV_EXTS };
