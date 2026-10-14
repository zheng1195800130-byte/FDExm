'use strict';
const {materialOnly,workReport}=require('./daily-report.cjs');

const fs = require('node:fs');
const fsp = fs.promises;
const { displaySettings } = require('./file-display.cjs');
const materialTags = require('./material-tags.cjs');
const { normalizePreset } = require('./summary-preset.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const realpath = promisify(fs.realpath);
const { scanDirectory, inspectFile, canonical, isWithin, shouldIndexFile, isOfficeTemporaryFile, IMAGE_EXTS } = require('./files.cjs');

const REQUIREMENT_STATUS = new Set(['待确认', '已明确', '已变更', '已完成']);
const RECORD_STATUS = new Set(['进行中', '已完成', '待验证', '未解决']);
const STAGES = new Set(['需求梳理', '开发中', '自测中', '客户测试', '反馈修复', '已交付', '维护中', '已完成']);
const SUMMARY_ITEM_STATUS = new Set(['待确认', ...RECORD_STATUS]);
const SUMMARY_STATES = new Set(['idle', 'running', 'error', 'ready']);
const REQUIREMENT_ANALYSIS_STATES = new Set([...SUMMARY_STATES, 'unconfigured']);
const SUMMARIZER_DEFAULTS = { enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const clone = value => JSON.parse(JSON.stringify(value));
function today() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(item => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function plain(value, label, max = 30_000) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${label}必须是文字`);
  if (value.length > max) throw new Error(`${label}过长`);
  return value.replace(/\u0000/g, '').trim();
}
function dateValue(value = today()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期格式应为 YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('日期无效');
  return value;
}
function sourceTimestamp(value, label = '来源时间') {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label}必须是含时区的 ISO 时间`);
  dateValue(value.slice(0, 10));
  if (Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59 || Number(value.slice(17,19)) > 59) throw new Error(`${label}无效`);
  return new Date(value).toISOString();
}
function sourceTimeText(value) {
  if (!value) return '';
  const valid = sourceTimestamp(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(valid)).map(item => [item.type,item.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
function mergedSourceDates(items) {
  const dates = [...new Set(items.flatMap(item => [sourceTimestamp(item.sourceFirstAt),sourceTimestamp(item.sourceLastAt)]).filter(Boolean))].sort();
  return { sourceFirstAt: dates[0] || '', sourceLastAt: dates.at(-1) || '' };
}
function required(value, label, max = 1000) {
  const text = plain(value, label, max);
  if (!text) throw new Error(`请填写${label}`);
  return text;
}
function directory(value, label) {
  const resolved = path.resolve(required(value, label, 4000));
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error(`${label}不存在：${resolved}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}必须是普通目录，不能是链接`);
  return fs.realpathSync(resolved);
}
function artifactDirectory(value, devDir, dataDir) {
  const artifactDir = directory(value, '开发成果目录');
  if (!isWithin(artifactDir, devDir)) throw new Error('开发成果目录必须是项目开发目录自身或其子目录');
  if (isWithin(artifactDir, dataDir)) throw new Error('开发成果目录不能位于 FDE 管理目录内');
  return artifactDir;
}
function safeId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value); }
function same(a, b) { return canonical(a) === canonical(b); }
function line(value) { return String(value || '').replace(/[\r\n]+/g, ' '); }
function field(label, value) { return value ? `- ${label}：${value}\n` : ''; }
function normalizeOrigin(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return plain(value, '记录来源', 1000);
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('记录来源无效');
  return { threadId: plain(value.threadId, '会话编号', 1000), turnId: plain(value.turnId, '轮次编号', 1000) };
}
function originKey(value) {
  // A string such as "manual" is a source label, not a unique turn identity.
  if (typeof value === 'string') return '';
  return value && (value.threadId || value.turnId) ? `${value.threadId || ''}:${value.turnId || ''}` : '';
}
function mergeActions(a, b) { return [...new Set([...(a || '').split('\n'), ...(b || '').split('\n')].map(item => item.trim()).filter(Boolean))].join('\n'); }
function codexDefaults(value = {}) {
  value ||= {};
  return { ...value, threadId: value.threadId || '', lastSyncAt: value.lastSyncAt || '',
    dailySummaries: Array.isArray(value.dailySummaries) ? value.dailySummaries : [],
    summaryStatus: value.summaryStatus && SUMMARY_STATES.has(value.summaryStatus.state) ? value.summaryStatus : { state: 'idle', message: '', updatedAt: '' },
  };
}
function requirementAnalysisDefaults(value = {}) {
  return { ...value, status: value.status || { state: 'idle', message: '', updatedAt: '' }, dismissedKeys: Array.isArray(value.dismissedKeys) ? value.dismissedKeys : [],
    dismissedRequirements: Array.isArray(value.dismissedRequirements) ? value.dismissedRequirements : [],
    dismissedConfirmations: Array.isArray(value.dismissedConfirmations) ? value.dismissedConfirmations : [] };
}
function requirementScope(project) {
  return crypto.createHash('sha256').update(JSON.stringify({ sourceDir: canonical(project.sourceDir), devDir: canonical(project.devDir), threadId: project.codex?.threadId || '' })).digest('hex');
}
function requirementTitleIdentity(title) { return normalizedTitle(title).replace(/[\s\p{P}\p{S}]+/gu, ''); }
function requirementSourceIdentities(item) {
  // A changed/reshuffled paragraph still belongs to the same original file.
  const ids = [...new Set((item.sourceIds || []).filter(value => typeof value === 'string' && value).map(value => value.replace(/^(file:.+):\d+$/, '$1')))];
  const refs = [...new Set(String(item.sourceRef || '').split(/\r?\n/).map(value => value.trim().replace(/\\/g, '/').toLowerCase()).filter(Boolean))];
  return { ids, refs };
}
function requirementDeletionIdentity(project, item) {
  const { ids, refs } = requirementSourceIdentities(item);
  const entry = { scope: requirementScope(project), keys: requirementKeys(item), title: requirementTitleIdentity(item.title), sourceIds: ids, sourceRefs: refs };
  return { ...entry, id: crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex'), deletedAt: now() };
}
function isDismissedRequirement(item, scope, legacyKeys, tombstones) {
  const keys = new Set(requirementKeys(item));
  if ([...keys].some(key => legacyKeys.has(key))) return true;
  const sources = requirementSourceIdentities(item), ids = new Set(sources.ids), refs = new Set(sources.refs);
  const title = requirementTitleIdentity(item.title);
  return tombstones.some(entry => entry?.scope === scope && (
    (Array.isArray(entry.keys) && entry.keys.some(key => keys.has(key)))
    || (entry.title && entry.title === title && (Array.isArray(entry.sourceIds) && entry.sourceIds.length && ids.size
      ? entry.sourceIds.some(source => ids.has(source))
      : Array.isArray(entry.sourceRefs) && entry.sourceRefs.some(source => refs.has(source))))
  ));
}
function requirementAnalysisPatch(input = {}) {
  const output = {};
  for (const key of ['contextKey','fingerprint','blockedFingerprint','threadId','updatedAt','method']) if (own(input,key)) output[key] = plain(input[key],key,4000);
  for (const key of ['processedSources','processedTurns']) if (own(input,key)) {
    const values = input[key];
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 10_000) throw new Error('需求来源检查点无效');
    output[key] = Object.fromEntries(Object.entries(values).map(([source,hash]) => [required(source,'来源编号',500),required(hash,'来源指纹',200)]));
  }
  for (const key of ['initialTurnIds','warnings']) if (own(input,key)) {
    if (!Array.isArray(input[key]) || input[key].length > 500) throw new Error('需求整理范围无效');
    output[key] = [...new Set(input[key].map(value => required(value,key,key === 'warnings' ? 2000 : 500)))];
  }
  if (own(input,'sourceCount')) {
    if (!Number.isInteger(input.sourceCount) || input.sourceCount < 0 || input.sourceCount > 10_000) throw new Error('需求来源数量无效');
    output.sourceCount = input.sourceCount;
  }
  if (own(input,'coveragePartial')) {
    if (typeof input.coveragePartial !== 'boolean') throw new Error('需求资料读取范围无效');
    output.coveragePartial = input.coveragePartial;
  }
  if (own(input,'omittedCount')) {
    if (!Number.isInteger(input.omittedCount) || input.omittedCount < 0 || input.omittedCount > 1_000_000) throw new Error('未读取资料数量无效');
    output.omittedCount = input.omittedCount;
  }
  if (own(input,'status')) {
    if (!input.status || !REQUIREMENT_ANALYSIS_STATES.has(input.status.state)) throw new Error('需求整理状态无效');
    output.status = { state: input.status.state, message: plain(input.status.message,'整理说明',4000), updatedAt: plain(input.status.updatedAt || now(),'更新时间',100) };
  }
  return output;
}
function requirementKeys(item) { return [...new Set([item.requirementKey,...(item.relatedRequirementKeys || [])].filter(Boolean))]; }
function confirmationKeys(item) { return [...new Set([item.confirmationKey,...(item.relatedConfirmationKeys || [])].filter(Boolean))]; }
function confirmationDeletionItem(item) { return { ...item, requirementKey: item.confirmationKey, relatedRequirementKeys: item.relatedConfirmationKeys || [], title: item.scenario }; }
function normalizeConfirmation(input) {
  if (!input || !['待确认','已解决'].includes(input.status)) throw new Error('需求确认状态无效');
  const value = { confirmationKey: required(input.confirmationKey,'确认事项编号',300), scenario: required(input.scenario,'业务场景',500),
    question: required(input.question,'待确认问题',1000), workaround: plain(input.workaround,'临时方案',1000), status: input.status,
    resolution: plain(input.resolution,'解决结论',1000), sourceIds: requirementStrings(input.sourceIds || [],'确认事项来源',500,500),
    relatedConfirmationKeys: requirementStrings(input.relatedConfirmationKeys || [],'关联确认事项',100,300),
    requirementKeys: requirementStrings(input.requirementKeys || [],'关联业务需求',100,300),
    sourceRef: plain(input.sourceRef,'确认事项来源说明',10_000), attachments: summaryAttachments(input.attachments || []),
    sourceFirstAt: sourceTimestamp(input.sourceFirstAt), sourceLastAt: sourceTimestamp(input.sourceLastAt),
  };
  if (value.status === '已解决' && !value.resolution) throw new Error('已解决事项需填写明确结论');
  if (value.sourceFirstAt && value.sourceLastAt && value.sourceFirstAt > value.sourceLastAt) throw new Error('来源起止时间无效');
  return value;
}
function requirementStrings(value, label, maxItems = 200, maxLength = 500) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label}无效`);
  return [...new Set(value.map(text => required(text,label,maxLength)))];
}
function summarizerConfig(input = {}, current = SUMMARIZER_DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('自动整理配置无效');
  const enabled = input.enabled ?? current.enabled;
  if (typeof enabled !== 'boolean') throw new Error('自动整理开关必须是布尔值');
  const provider = required(input.provider ?? current.provider, '模型服务', 100);
  const model = required(input.model ?? current.model, '模型名称', 200);
  const baseUrl = required(input.baseUrl ?? current.baseUrl, '模型服务地址', 2000).replace(/\/+$/, '');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('模型服务地址无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型服务地址应为 HTTP(S) 地址，不能包含密钥、用户名或查询参数');
  return { enabled, provider, baseUrl, model };
}
function brief(value, label, max) { return plain(value, label, 30_000).slice(0, max); }
function summaryAttachments(value = []) {
  if (!Array.isArray(value) || value.length > 50) throw new Error('自动整理附件列表无效');
  return value.map(item => {
    if (typeof item === 'string') return plain(item, '附件路径', 4000);
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('自动整理附件无效');
    return { path: plain(item.path, '附件路径', 4000), name: brief(item.name, '附件名称', 300), description: brief(item.description, '附件说明', 300), ...(item.type ? { type: brief(item.type, '附件类型', 100) } : {}) };
  });
}
function uniqueValues(values) { return [...new Map(values.map(value => [JSON.stringify(value), value])).values()]; }
function autoRecordId(threadId, date, issueKey) { return `auto-${crypto.createHash('sha256').update(`${threadId}:${date}:${issueKey}`).digest('hex').slice(0, 24)}`; }
function normalizedTitle(value) { return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function relatedKeys(value, issueKey) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('关联事项编号列表无效');
  return [...new Set(value.map(key => required(key, '关联事项编号', 300)))].filter(key => key !== issueKey);
}
function itemKeys(item) { return [item.issueKey, ...(item.relatedIssueKeys || [])].filter(Boolean); }
function sameIssue(a, b) { const keys = new Set(itemKeys(a)); return itemKeys(b).some(key => keys.has(key)); }
function reportLine(item) {
  const compact = value => line(value).trim().replace(/[。；;]+$/, '');
  return `- **${line(item.title)}**：${[['原因', item.cause], ['处理', item.action], ['结果', item.result]].filter(([, value]) => value).map(([label, value]) => `${label}：${compact(value)}`).join('；')}。`;
}
function summaryReport(project, date, items) {
  const parts = items.map(reportLine);
  return `# ${project.name} · ${date} 日报\n\n${parts.length ? parts.join('\n\n') : '当天暂无可整理的有效事项。'}\n`;
}

class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(typeof dataDir === 'object' ? dataDir.dataDir : required(dataDir, '管理目录', 4000));
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.dataDir = fs.realpathSync(this.dataDir);
    this.statePath = path.join(this.dataDir, 'store.json');
    this.backupPath = path.join(this.dataDir, 'store.backup.json');
    this.recoveryWarning = '';
    this.projectLocks = new Map();
    this.state = this._load();
    if (!fs.existsSync(this.statePath) || this.recoveryWarning) this._persist();
  }

  _readState(filePath) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.projects) || !data.settings || typeof data.settings !== 'object') throw new Error('档案结构无效');
    for (const project of data.projects) {
      if (!safeId(project.id) || !Array.isArray(project.files) || !Array.isArray(project.records) || !Array.isArray(project.requirements) || !Array.isArray(project.reports) || !Array.isArray(project.cycles) || !Array.isArray(project.deliveries)) throw new Error('项目档案结构无效');
      for (const record of project.records) dateValue(record.date);
      for (const report of project.reports) { dateValue(report.date); if (typeof report.text !== 'string') throw new Error('日报结构无效'); }
      project.codex = codexDefaults(project.codex);
      if (project.archivedAt !== undefined) project.archivedAt = sourceTimestamp(project.archivedAt, '项目归档时间');
      if (project.archiveRevision !== undefined && (!Number.isSafeInteger(project.archiveRevision) || project.archiveRevision < 0)) throw new Error('项目归档版本无效');
      if (project.requirementConfirmations !== undefined && !Array.isArray(project.requirementConfirmations)) throw new Error('需求确认档案结构无效');
      project.requirementConfirmations ||= [];
      project.requirementsAfter = sourceTimestamp(project.requirementsAfter || '', '需求时间筛选');
      project.requirementsDateMode = ['today','date','all'].includes(project.requirementsDateMode) ? project.requirementsDateMode : 'today';
      for (const summary of project.codex.dailySummaries) dateValue(summary.date);
    }
    data.settings.summarizer = summarizerConfig(data.settings.summarizer || {});
    return data;
  }

  _load() {
    if (!fs.existsSync(this.statePath)) {
      if (fs.existsSync(this.backupPath)) {
        try { const backup = this._readState(this.backupPath); this.recoveryWarning = '主档案缺失，已从备份恢复。'; return backup; }
        catch (error) { throw new Error(`主档案缺失且备份损坏，请保留管理目录后恢复备份。原因：${error.message}`); }
      }
      return { version: 1, settings: { summarizer: { ...SUMMARIZER_DEFAULTS } }, projects: [] };
    }
    try { return this._readState(this.statePath); } catch (error) {
      try {
        const backup = this._readState(this.backupPath);
        fs.copyFileSync(this.statePath, path.join(this.dataDir, `store.corrupt-${Date.now()}.json`));
        this.recoveryWarning = '主档案损坏，已从上一次有效备份恢复；损坏文件已保留。';
        return backup;
      } catch { throw new Error(`项目档案及备份无法读取，请保留管理目录后恢复备份。原因：${error.message}`); }
    }
  }

  _atomicWrite(filePath, text) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx');
      fs.writeFileSync(descriptor, text, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filePath);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  _persist() {
    // Back up only valid JSON. A damaged primary must never replace a valid backup.
    if (fs.existsSync(this.statePath)) {
      try { this._readState(this.statePath); this._atomicWrite(this.backupPath, fs.readFileSync(this.statePath, 'utf8')); } catch { /* Keep the previous valid backup. */ }
    }
    this._atomicWrite(this.statePath, JSON.stringify(this.state, null, 2));
    if (!fs.existsSync(this.backupPath)) this._atomicWrite(this.backupPath, JSON.stringify(this.state, null, 2));
  }

  _project(projectId) {
    if (!safeId(projectId)) throw new Error('项目编号无效');
    const project = this.state.projects.find(item => item.id === projectId);
    if (!project) throw new Error('项目不存在');
    return project;
  }

  _projectDir(projectId) { this._project(projectId); return path.join(this.dataDir, 'projects', projectId); }

  _archive(project) {
    const base = this._projectDir(project.id);
    const overview = `# ${project.name}\n\n${field('客户', project.customer)}${field('原始资料目录', project.sourceDir)}${field('开发目录', project.devDir)}${field('当前阶段', project.stage)}${field('下一步', project.nextAction)}${field('阻塞', project.blocker)}${field('创建时间', project.createdAt)}${field('更新时间', project.updatedAt)}\n## 管理周期\n\n${project.cycles.map(cycle => `- ${cycle.name} · ${cycle.status} · ${cycle.startedAt}${cycle.endedAt ? ` — ${cycle.endedAt}` : ''}`).join('\n')}\n\n## 交付记录\n\n${project.deliveries.map(delivery => `- ${delivery.date} ${delivery.version || delivery.title || ''}：${delivery.summary || ''}`).join('\n') || '暂无交付记录。'}\n`;
    this._atomicWrite(path.join(base, '项目档案.md'), overview);
    const requirements = project.requirements.map(item => `## ${item.title}\n\n${field('编号', item.id)}${field('状态', item.status)}${field('内容', item.description)}${field('待确认问题', (item.questions || []).join('；'))}${field('来源', item.sourceRef)}${field('最早相关对话', sourceTimeText(item.sourceFirstAt))}${field('最近相关对话', sourceTimeText(item.sourceLastAt))}${field('周期', project.cycles.find(cycle => cycle.id === item.cycleId)?.name || '')}`).join('\n');
    const confirmations = (project.requirementConfirmations || []).map(item => `## ${item.scenario}\n\n${field('状态', item.status)}${field('待确认', item.question)}${field('临时方案', item.workaround)}${field('解决结论', item.resolution)}${field('来源', item.sourceRef)}${field('最早相关对话', sourceTimeText(item.sourceFirstAt))}${field('最近相关对话', sourceTimeText(item.sourceLastAt))}`).join('\n');
    this._atomicWrite(path.join(base, '需求清单.md'), `# ${project.name} · 需求清单\n\n${requirements || '暂无需求。\n'}\n# 需求确认（含已解决历史）\n\n${confirmations || '暂无确认事项。\n'}`);
    this._atomicWrite(path.join(base, '需求确认.md'), `# ${project.name} · 需求确认\n\n${confirmations || '暂无确认事项。\n'}`);
    const dates = [...new Set(project.records.map(record => record.date))];
    const recordsDir = path.join(base, '工作记录');
    fs.mkdirSync(recordsDir, { recursive: true });
    for (const name of fs.readdirSync(recordsDir)) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name) && !dates.includes(name.slice(0, 10))) fs.unlinkSync(path.join(recordsDir, name));
    }
    for (const date of dates) {
      const entries = project.records.filter(record => record.date === date).map(record => `## ${record.title}\n\n${field('编号', record.id)}${field('确认', record.confirmed ? '已确认' : '待确认，不纳入日报')}${field('原因', record.cause)}${field('处理', record.action)}${field('结果', record.result)}${field('状态', record.status)}${field('来源', record.sourceRef)}${record.attachments.length ? field('附件', record.attachments.map(item => typeof item === 'string' ? item : item.path || item.name || '').join('；')) : ''}`).join('\n');
      this._atomicWrite(path.join(recordsDir, `${date}.md`), `# ${project.name} · ${date}\n\n${entries}`);
    }
    for (const report of project.reports) this._atomicWrite(path.join(base, '日报', `${report.date}.md`), report.text);
    const autoDir = path.join(base, '自动整理');
    fs.mkdirSync(autoDir, { recursive: true });
    const codex = codexDefaults(project.codex);
    for (const archive of codex.summaryArchives || []) {
      const threadFolder = crypto.createHash('sha256').update(archive.threadId || '').digest('hex').slice(0, 16);
      for (const summary of archive.dailySummaries || []) this._atomicWrite(path.join(autoDir, '会话归档', threadFolder, `${dateValue(summary.date)}.md`), summary.reportText || summaryReport(project, summary.date, summary.items || []));
    }
    const autoDates = new Set(codex.dailySummaries.map(summary => summary.date));
    for (const summary of codex.dailySummaries) this._atomicWrite(path.join(autoDir, `${summary.date}.md`), summary.reportText);
    for (const name of fs.readdirSync(autoDir)) if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name) && !autoDates.has(name.slice(0, 10))) fs.unlinkSync(path.join(autoDir, name));
  }

  _commit(project) {
    project.updatedAt = now();
    this._persist();
    try { this._archive(project); project.archiveWarning = ''; } catch (error) { project.archiveWarning = `档案文件写入失败：${error.message}`; this._persist(); }
    return clone(project);
  }

  getState() {
    return { ...clone(this.state), ...(this.recoveryWarning ? { recoveryWarning: this.recoveryWarning } : {}) };
  }

  setSettings(patch = {}) {
    const updates = {};
    if (own(patch, 'summaryPreset')) updates.summaryPreset = normalizePreset(patch.summaryPreset);
    if (own(patch, 'materialDisplay')) updates.materialDisplay = displaySettings(patch.materialDisplay);
    if (own(patch, 'activeProjectId')) {
      if (patch.activeProjectId !== '' && this._project(patch.activeProjectId).archivedAt) throw new Error('项目已归档，请先恢复项目');
      updates.activeProjectId = patch.activeProjectId;
    }
    for (const key of ['alwaysOnTop', 'autoScan']) if (own(patch, key)) {
      if (typeof patch[key] !== 'boolean') throw new Error(`${key}必须是布尔值`);
      updates[key] = patch[key];
    }
    if (own(patch, 'summarizer')) updates.summarizer = summarizerConfig(patch.summarizer, this.state.settings.summarizer || SUMMARIZER_DEFAULTS);
    for (const key of ['ballPosition', 'mainBounds']) if (own(patch, key)) {
      if (!patch[key] || typeof patch[key] !== 'object') throw new Error('窗口位置无效');
      const rect = {};
      for (const dimension of (key === 'ballPosition' ? ['x', 'y'] : ['x', 'y', 'width', 'height'])) {
        const value = patch[key][dimension];
        if (!Number.isFinite(value) || Math.abs(value) > 100_000 || (['width', 'height'].includes(dimension) && value < 100)) throw new Error('窗口尺寸或位置无效');
        rect[dimension] = Math.round(value);
      }
      updates[key] = rect;
    }
    for (const [key, value] of Object.entries(updates)) this.state.settings[key] = value;
    this._persist();
    return this.getState();
  }

  saveSummarizerSettings(config) {
    const previous=clone(this.state.settings);
    try{return this.setSettings({summarizer:config});}
    catch(error){this.state.settings=previous;throw error;}
  }

  projectFolder(projectId) { return this._projectDir(projectId); }

  async _withProjectLock(projectId, task) {
    this._project(projectId);
    const previous = this.projectLocks.get(projectId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.projectLocks.set(projectId, current);
    await previous;
    try { return await task(); } finally {
      release();
      if (this.projectLocks.get(projectId) === current) this.projectLocks.delete(projectId);
    }
  }

  createProject(input = {}) {
    const name = required(input.name, '项目名称', 300);
    const sourceDir = directory(input.sourceDir, '原始资料目录');
    const devDir = directory(input.devDir, '项目开发目录');
    if (same(sourceDir, devDir)) throw new Error('原始资料目录和项目开发目录不能相同');
    if (isWithin(sourceDir, this.dataDir) || isWithin(devDir, this.dataDir)) throw new Error('关联目录不能位于 FDE 管理目录内');
    const artifactDir = artifactDirectory(input.artifactDir || devDir, devDir, this.dataDir);
    const indexArtifacts = input.indexArtifacts ?? true;
    if (typeof indexArtifacts !== 'boolean') throw new Error('开发成果收录开关必须是布尔值');
    const time = now();
    const cycle = { id: id(), name: '首次交付', status: '进行中', startedAt: time };
    const project = { id: id(), name, customer: plain(input.customer, '客户', 300), sourceDir, devDir, artifactDir, indexArtifacts,
      stage: '需求梳理', nextAction: '', blocker: '', createdAt: time, updatedAt: time, archivedAt: '', archiveRevision: 0,
      cycles: [cycle], activeCycleId: cycle.id, files: [], requirements: [], requirementConfirmations: [], requirementsAfter: '', records: [], deliveries: [], reports: [],
      codex: codexDefaults(), requirementAnalysis: requirementAnalysisDefaults(), scanWarning: '', lastScanAt: '',
    };
    this.state.projects.push(project);
    this.state.settings.activeProjectId = project.id;
    return this._commit(project);
  }

  setProjectArchived(projectId, archived) {
    if (typeof archived !== 'boolean') throw new Error('项目归档状态无效');
    const project = this._project(projectId);
    if (!!project.archivedAt === archived) return clone(project);
    project.archivedAt = archived ? now() : '';
    project.archiveRevision = (project.archiveRevision || 0) + 1;
    if (archived && this.state.settings.activeProjectId === projectId) this.state.settings.activeProjectId = this.state.projects.find(item => !item.archivedAt)?.id || '';
    if (!archived) this.state.settings.activeProjectId = projectId;
    return this._commit(project);
  }

  // Directory correction and the explicitly selected thread are persisted in
  // one commit. Normal project edits still clear bindings when cwd changes.
  bindCodexThread(projectId, { threadId = '', devDir } = {}) {
    const selected = plain(threadId, 'Codex 会话', 1000);
    const project = this._project(projectId);
    const patch = { codex: { threadId: selected, lastSyncAt: '' } };
    if (devDir !== undefined) {
      patch.devDir = devDir;
      if (same(project.artifactDir || project.devDir, project.devDir)) patch.artifactDir = devDir;
    }
    return this.updateProject(projectId, patch, { boundThreadId: selected });
  }

  updateProject(projectId, patch = {}, { boundThreadId = '' } = {}) {
    const project = this._project(projectId);
    const updates = {};
    for (const key of ['name', 'customer', 'nextAction', 'blocker']) if (own(patch, key)) updates[key] = key === 'name' ? required(patch[key], '项目名称', 300) : plain(patch[key], key, 10_000);
    if (own(patch, 'stage')) { if (!STAGES.has(patch.stage)) throw new Error('项目阶段无效'); updates.stage = patch.stage; }
    for (const key of ['sourceDir', 'devDir']) if (own(patch, key)) updates[key] = directory(patch[key], key === 'sourceDir' ? '原始资料目录' : '项目开发目录');
    const source = updates.sourceDir || project.sourceDir;
    const dev = updates.devDir || project.devDir;
    if (same(source, dev)) throw new Error('原始资料目录和项目开发目录不能相同');
    if (isWithin(source, this.dataDir) || isWithin(dev, this.dataDir)) throw new Error('关联目录不能位于 FDE 管理目录内');
    if (own(patch, 'codex')) {
      if (!patch.codex || typeof patch.codex !== 'object') throw new Error('Codex 关联无效');
      updates.codex = codexDefaults(project.codex);
      for (const key of ['threadId', 'lastSyncAt']) if (own(patch.codex, key)) updates.codex[key] = plain(patch.codex[key], key, 1000);
    }
    const sourceChanged = !same(source, project.sourceDir);
    const devChanged = !same(dev, project.devDir);
    const previousArtifactDir = project.artifactDir || project.devDir;
    let artifactDir = previousArtifactDir;
    if (own(patch, 'artifactDir')) artifactDir = artifactDirectory(patch.artifactDir == null || patch.artifactDir === '' ? dev : patch.artifactDir, dev, this.dataDir);
    else if (devChanged && !isWithin(previousArtifactDir, dev)) artifactDir = dev;
    const artifactChanged = !same(artifactDir, previousArtifactDir);
    if (own(patch, 'artifactDir') || devChanged) updates.artifactDir = artifactDir;
    if (own(patch, 'indexArtifacts')) {
      if (typeof patch.indexArtifacts !== 'boolean') throw new Error('开发成果收录开关必须是布尔值');
      updates.indexArtifacts = patch.indexArtifacts;
      if (!patch.indexArtifacts) { this._rememberFileAnnotations(project, project.files); project.files = project.files.filter(file => file.kind !== '开发成果'); }
    }
    if (devChanged) updates.codex = { threadId: boundThreadId, lastSyncAt: '' };
    const previousCodex = codexDefaults(project.codex);
    const nextCodex = codexDefaults(updates.codex || project.codex);
    if (devChanged) {
      const previousAutoRecords = project.records.filter(record => record.managedBy === 'codex-auto' && !record.confirmed && !record.manual);
      const archives = [...(previousCodex.summaryArchives || [])];
      if (previousCodex.dailySummaries.length || previousAutoRecords.length) archives.push({ threadId: previousCodex.threadId, archivedAt: now(), dailySummaries: previousCodex.dailySummaries, records: previousAutoRecords });
      project.records = project.records.filter(record => record.managedBy !== 'codex-auto' || record.confirmed || record.manual);
      updates.codex = codexDefaults({ ...nextCodex, dailySummaries: [], history: null, summaryStatus: { state: 'idle', message: '', updatedAt: now() }, summaryArchives: archives, summaryDismissals: [] });
      if (project.dailyDesk) updates.dailyDesk = { days: {}, archives: [...(project.dailyDesk.archives || []), { threadId: previousCodex.threadId, days: project.dailyDesk.days || {}, overview: project.dailyDesk.overview, archivedAt: now() }] };
    } else if (nextCodex.threadId !== previousCodex.threadId) {
      // A replacement chat in the same repository continues the same project.
      // Preserve daily evidence/checkpoints, summaries, drafts and dismissals.
      updates.codex = codexDefaults({ ...nextCodex, history: null,
        summaryStatus: { state: 'idle', message: '会话入口已更新，点击整理时接续本项目当日对话', updatedAt: now() },
        summaryDismissals: (previousCodex.summaryDismissals || []).map(item => ({ ...item, threadId: nextCodex.threadId })),
      });
    }
    if (sourceChanged || devChanged) {
      updates.requirementAnalysis = requirementAnalysisDefaults({ dismissedKeys: project.requirementAnalysis?.dismissedKeys || [], dismissedRequirements: project.requirementAnalysis?.dismissedRequirements || [], dismissedConfirmations: project.requirementAnalysis?.dismissedConfirmations || [] });
    }
    if (sourceChanged || devChanged || artifactChanged) {
      this._rememberFileAnnotations(project, project.files);
      project.files = project.files.filter(file => !((sourceChanged && file.kind === '原始资料') || ((devChanged || artifactChanged) && file.kind === '开发成果')));
      project.lastScanAt = '';
      project.scanWarning = '';
    }
    for (const [key, value] of Object.entries(updates)) project[key] = value;
    if (updates.stage === '已完成') {
      const cycle = project.cycles.find(item => item.id === project.activeCycleId);
      if (cycle) { cycle.status = '已结束'; cycle.endedAt ||= now(); }
    }
    return this._commit(project);
  }

  scanProject(projectId, { force = false } = {}) { return this._withProjectLock(projectId, () => this._scanProject(projectId, { force })); }

  async _scanProject(projectId, { force = false } = {}) {
    const project = this._project(projectId);
    const exclude = [this.dataDir];
    const artifactDir = project.artifactDir || project.devDir;
    const sourceOptions = { exclude: [...exclude, ...(isWithin(project.devDir, project.sourceDir) ? [project.devDir] : [])], existing: project.files, force };
    const devOptions = { exclude: [...exclude, ...(isWithin(project.sourceDir, artifactDir) ? [project.sourceDir] : [])], existing: project.files, force };
    const sourceResult = await scanDirectory(project.sourceDir, '原始资料', sourceOptions);
    const devResult = project.indexArtifacts === false ? { files: [], warnings: [], complete: true } : await scanDirectory(artifactDir, '开发成果', devOptions);
    const supplementsDir = path.join(this._projectDir(projectId), 'supplements');
    const supplementResult = fs.existsSync(supplementsDir) ? await scanDirectory(supplementsDir, '补充资料', { existing: project.files, force }) : { files: [], warnings: [], complete: true };
    const currentFiles = new Map(project.files.map(file => [canonical(file.path), file]));
    this._rememberFileAnnotations(project, project.files);
    const found = [...sourceResult.files, ...devResult.files, ...supplementResult.files].map(file => {
      const current = currentFiles.get(canonical(file.path)) || project.fileAnnotations?.[canonical(file.path)];
      return current ? { ...file, ...(current.descriptionSource === 'user' ? { description: current.description, descriptionSource: 'user' } : {}), ...(current.importedAt ? { importedAt: current.importedAt, originalPath: current.originalPath } : {}) } : file;
    });
    const foundPaths = new Set(found.map(file => canonical(file.path)));
    for (const old of project.files) {
      if (old.kind === '开发成果' && project.indexArtifacts === false) continue;
      if (foundPaths.has(canonical(old.path))) continue;
      if (isOfficeTemporaryFile(old.path)) continue;
      if (old.kind === '原始资料' && !shouldIndexFile(old.path, project.sourceDir, old.kind, sourceOptions)) continue;
      if (old.kind === '开发成果' && !shouldIndexFile(old.path, artifactDir, old.kind, devOptions)) continue;
      let missing = true;
      try { missing = !fs.statSync(old.path).isFile(); } catch { /* Missing is explicitly kept in the index. */ }
      found.push({ ...old, missing });
    }
    const folderMap=new Map([...sourceResult.folders||[],...devResult.folders||[],...supplementResult.folders||[]].map(folder=>[canonical(folder.path),folder]));
    for(const folder of project.folders||[]){if(folder.kind==='开发成果'&&project.indexArtifacts===false)continue;const root=folder.kind==='原始资料'?project.sourceDir:folder.kind==='开发成果'?artifactDir:supplementsDir;
      if(!isWithin(folder.path,root)||folderMap.has(canonical(folder.path)))continue;
      const options=folder.kind==='原始资料'?sourceOptions:folder.kind==='开发成果'?devOptions:{};
      if(require('./files.cjs').isExcludedPath(folder.path,root,folder.kind,options,true))continue;
      try{const stat=fs.lstatSync(folder.path);if(stat.isDirectory()&&!stat.isSymbolicLink())folderMap.set(canonical(folder.path),folder);}catch{/* Deleted folders disappear from display. */}
    }
    const folders=[...folderMap.values()];
    project.lastScanAt = now();
    const scanWarning = [...sourceResult.warnings, ...devResult.warnings, ...supplementResult.warnings].join('\n');
    const fileSignature = files => JSON.stringify([...files].sort((a, b) => canonical(a.path).localeCompare(canonical(b.path))));
    if (scanWarning === project.scanWarning && fileSignature(found) === fileSignature(project.files) && fileSignature(folders)===fileSignature(project.folders||[])) return clone(project);
    project.files = found;
    project.folders = folders;
    project.scanWarning = scanWarning;
    return this._commit(project);
  }

  saveMaterialReferences(projectId, hints, historyToken) {
    const project=this._project(projectId);const before=JSON.stringify([project.materialReferences,project.materialAnnotations,project.materialTagHistoryToken]);
    project.materialReferences=hints.slice(-200);
    project.materialAnnotations||={};
    materialTags.mergeAnnotations({...project,managementDir:this._projectDir(projectId)},hints,'user');
    if(historyToken!==undefined)project.materialTagHistoryToken=historyToken;
    if(before!==JSON.stringify([project.materialReferences,project.materialAnnotations,project.materialTagHistoryToken]))return this._commit(project);
    return clone(project);
  }
  setMaterialTags(projectId, targetId, labels) {
    const project=this._project(projectId),view={...project,managementDir:this._projectDir(projectId)};
    if(!materialTags.targets(view).some(item=>item.id===targetId))throw new Error('资料或目录不存在，请刷新资料');
    if(!Array.isArray(labels)||labels.length>8||labels.some(label=>typeof label!=='string'||!label.trim()||label.trim().length>24))throw new Error('最多 8 个标签，每个不超过 24 字');
    project.materialAnnotations||={};view.materialAnnotations=project.materialAnnotations;
    materialTags.mergeAnnotations(view,[{targetId,labels}],'manual');return this._commit(project);
  }

  addFiles(projectId, paths, kind = '补充资料') { return this._withProjectLock(projectId, () => this._addFiles(projectId, paths, kind)); }

  async _addFiles(projectId, paths, kind = '补充资料') {
    const project = this._project(projectId);
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) throw new Error('请选择 1 至 100 个文件');
    if (kind !== '补充资料') throw new Error('新增资料以副本保存为补充资料；原始资料通过关联目录索引');
    const selected = [];
    let total = 0;
    for (const item of paths) {
      const source = path.resolve(required(item, '文件路径', 4000));
      const stat = await fsp.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('只能导入普通文件，不能导入目录或链接');
      // Resolve and compare so a selected junction cannot redirect a managed attachment.
      const real = await realpath(source);
      if (!same(real, source)) throw new Error('不能通过链接路径导入文件');
      total += stat.size;
      if (stat.size > 100 * 1024 * 1024 || total > 300 * 1024 * 1024) throw new Error('单个文件不能超过 100 MB，一次导入不能超过 300 MB');
      selected.push(source);
    }
    const targetDir = path.join(this._projectDir(projectId), 'supplements', today());
    await fsp.mkdir(targetDir, { recursive: true });
    for (const source of selected) {
      const parsed = path.parse(source);
      let target = path.join(targetDir, parsed.base);
      let suffix = 1;
      while (fs.existsSync(target)) { target = path.join(targetDir, `${parsed.name}_${suffix}${parsed.ext}`); suffix += 1; }
      if (!isWithin(target, targetDir)) throw new Error('文件路径越界');
      await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      const file = await inspectFile(target, '补充资料');
      file.importedAt = now();
      file.originalPath = source;
      project.files.push(file);
    }
    return this._commit(project);
  }

  _file(project, fileId) {
    const file = project.files.find(item => item.id === fileId);
    if (!file) throw new Error('资料不存在');
    const allowed = [project.sourceDir, project.devDir, path.join(this._projectDir(project.id), 'supplements')];
    if (!allowed.some(root => isWithin(file.path, root))) throw new Error('文件路径超出关联项目范围');
    return file;
  }

  updateFile(projectId, fileId, patch = {}) {
    const project = this._project(projectId);
    const file = this._file(project, fileId);
    if (own(patch, 'description')) { file.description = plain(patch.description, '资料介绍', 10_000); file.descriptionSource = 'user'; }
    this._rememberFileAnnotations(project, [file]);
    return this._commit(project);
  }

  _rememberFileAnnotations(project, files) {
    for (const file of files) {
      if (file.descriptionSource !== 'user' && !(!file.descriptionSource && file.description)) continue;
      project.fileAnnotations ||= {};
      project.fileAnnotations[canonical(file.path)] = { id: file.id, path: file.path, description: file.description, descriptionSource: 'user' };
    }
  }

  async previewFile(projectId, fileId) {
    const project = this._project(projectId);
    const file = this._file(project, fileId);
    let real;
    try { real = await realpath(file.path); } catch { throw new Error('文件不存在，请重新扫描资料'); }
    if (!same(real, file.path)) throw new Error('文件已变为链接路径，无法预览');
    const inspected = await inspectFile(file.path, file.kind, file, { force: true });
    return { file: inspected, text: inspected.textPreview, type: inspected.type,
      ...(IMAGE_EXTS.has(inspected.ext) ? { imagePath: inspected.path } : {}),
      ...(inspected.parseError ? { error: inspected.parseError } : {}),
      ...(inspected.previewNote ? { note: inspected.previewNote } : {}),
    };
  }

  upsertRequirement(projectId, input = {}) {
    const project = this._project(projectId);
    const existing = input.id ? project.requirements.find(item => item.id === input.id) : null;
    const origin = normalizeOrigin(input.origin ?? existing?.origin);
    if (input.id && !existing && !originKey(origin)) throw new Error('需求不存在');
    if (!existing && originKey(origin) && project.requirements.some(item => originKey(item.origin) === originKey(origin) && item.title === input.title)) return clone(project);
    const status = input.status ?? existing?.status ?? '待确认';
    if (!REQUIREMENT_STATUS.has(status)) throw new Error('需求状态无效');
    const cycleId = input.cycleId || existing?.cycleId || project.activeCycleId;
    if (!project.cycles.some(cycle => cycle.id === cycleId)) throw new Error('管理周期不存在');
    const item = { ...(existing || {}), id: existing?.id || id(), title: required(input.title ?? existing?.title, '需求标题', 1000),
      description: plain(input.description ?? existing?.description, '需求说明'), status,
      sourceRef: plain(input.sourceRef ?? existing?.sourceRef, '来源', 10_000), cycleId,
      origin,
      sourceFirstAt: existing?.sourceFirstAt || '', sourceLastAt: existing?.sourceLastAt || '',
      createdAt: existing?.createdAt || now(), updatedAt: now(),
    };
    if (existing?.managedBy === 'requirements-auto') item.manual = true;
    if (own(input,'questions')) item.questions = requirementStrings(input.questions,'待确认问题',20,500);
    if (existing) project.requirements[project.requirements.indexOf(existing)] = item; else project.requirements.push(item);
    return this._commit(project);
  }

  removeRequirement(projectId, reqId) {
    const project = this._project(projectId);
    const existing = project.requirements.find(item => item.id === reqId);
    if (existing) {
      const analysis = requirementAnalysisDefaults(project.requirementAnalysis), tombstone = requirementDeletionIdentity(project, existing);
      project.requirementAnalysis = requirementAnalysisDefaults({ ...analysis,
        dismissedKeys: [...new Set([...analysis.dismissedKeys,...requirementKeys(existing)])],
        dismissedRequirements: [...analysis.dismissedRequirements.filter(entry => entry?.id !== tombstone.id),tombstone],
      });
    }
    project.requirements = project.requirements.filter(item => item.id !== reqId);
    return this._commit(project);
  }

  setRequirementAnalysis(projectId, patch = {}) {
    const project = this._project(projectId), updates = requirementAnalysisPatch(patch);
    project.requirementAnalysis = requirementAnalysisDefaults({ ...project.requirementAnalysis,...updates });
    return this._commit(project);
  }

  setRequirementFilter(projectId, afterISO = '', mode = afterISO ? 'date' : 'all') {
    const project = this._project(projectId), value = sourceTimestamp(afterISO, '需求时间筛选');
    if (!['today','date','all'].includes(mode) || mode === 'date' && !value) throw new Error('需求日期筛选无效');
    if ((project.requirementsAfter || '') === value && project.requirementsDateMode === mode) return clone(project);
    project.requirementsAfter = value;
    project.requirementsDateMode = mode;
    return this._commit(project);
  }

  upsertRequirementConfirmation(projectId, input = {}) {
    const project = this._project(projectId), entries = project.requirementConfirmations || [];
    const existing = input.id ? entries.find(item => item.id === input.id) : null;
    if (input.id && !existing) throw new Error('需求确认事项不存在');
    const key = existing?.confirmationKey || input.confirmationKey || `manual_${id()}`;
    if (!existing && entries.some(item => confirmationKeys(item).includes(key))) throw new Error('需求确认事项编号已存在');
    const item = normalizeConfirmation({ ...existing, ...input, confirmationKey: key, status: input.status || existing?.status || '待确认',
      sourceFirstAt: existing?.sourceFirstAt || '', sourceLastAt: existing?.sourceLastAt || '' });
    const record = { ...existing, ...item, id: existing?.id || id(), manual: true, managedBy: existing?.managedBy || 'manual', createdAt: existing?.createdAt || now(), updatedAt: now() };
    project.requirementConfirmations = existing ? entries.map(item => item.id === existing.id ? record : item) : [...entries,record];
    return this._commit(project);
  }

  removeRequirementConfirmation(projectId, confirmationId) {
    const project = this._project(projectId), existing = (project.requirementConfirmations || []).find(item => item.id === confirmationId);
    if (existing) {
      const analysis = requirementAnalysisDefaults(project.requirementAnalysis), tombstone = requirementDeletionIdentity(project, confirmationDeletionItem(existing));
      project.requirementAnalysis = { ...analysis, dismissedConfirmations: [...analysis.dismissedConfirmations.filter(item => item.id !== tombstone.id),tombstone] };
    }
    project.requirementConfirmations = (project.requirementConfirmations || []).filter(item => item.id !== confirmationId);
    return this._commit(project);
  }

  applyRequirementSummary(projectId, input = {}) {
    const project = this._project(projectId);
    if (!Array.isArray(input.items) || input.items.length > 100) throw new Error('自动需求清单无效');
    if (input.threadId !== undefined && input.threadId !== project.codex.threadId) throw new Error('项目会话已变化，请重新整理需求');
    const analysis = requirementAnalysisPatch(input);
    const currentAnalysis = requirementAnalysisDefaults(project.requirementAnalysis);
    const tombstones = currentAnalysis.dismissedRequirements;
    const scopedKeys = new Set(tombstones.flatMap(entry => Array.isArray(entry?.keys) ? entry.keys : []));
    // Old stores have only dismissedKeys. Keep those exclusions; newer entries
    // carry their original scope so switching a project context cannot misapply
    // a former deletion to an unrelated customer requirement.
    const legacyDismissed = new Set(currentAnalysis.dismissedKeys.filter(key => !scopedKeys.has(key)));
    const scope = requirementScope(project);
    if (input.confirmations !== undefined && (!Array.isArray(input.confirmations) || input.confirmations.length > 100)) throw new Error('需求确认清单无效');
    const normalizedConfirmations = (input.confirmations || []).map(normalizeConfirmation);
    const confirmationSeen = new Set();
    for (const item of normalizedConfirmations) for (const key of confirmationKeys(item)) {
      if (confirmationSeen.has(key)) throw new Error('同一需求确认事项被重复整理');
      confirmationSeen.add(key);
    }
    // Validate the complete response before changing any saved project data.
    const normalized = input.items.map(item => {
      if (!item || !['待确认','已明确'].includes(item.status)) throw new Error('自动需求状态无效');
      const questions = requirementStrings(item.questions || [],'待确认问题',20,500);
      return { requirementKey: required(item.requirementKey,'需求编号',300), title: required(item.title,'需求标题',200),
        description: plain(item.description,'需求说明',2000), questions, status: questions.length ? '待确认' : item.status,
        relatedRequirementKeys: requirementStrings(item.relatedRequirementKeys || [],'关联需求编号',100,300),
        sourceIds: requirementStrings(item.sourceIds || [],'需求来源',500,500), sourceRef: plain(item.sourceRef,'需求来源说明',10_000),
        attachments: summaryAttachments(item.attachments || []),
        sourceFirstAt: sourceTimestamp(item.sourceFirstAt), sourceLastAt: sourceTimestamp(item.sourceLastAt),
      };
    });
    const seen = new Set();
    for (const item of normalized) for (const key of requirementKeys(item)) {
      if (seen.has(key)) throw new Error('同一业务需求被重复整理');
      seen.add(key);
    }
    let requirements = clone(project.requirements);
    for (const item of normalized) {
      const keys = new Set(requirementKeys(item));
      if (isDismissedRequirement(item, scope, legacyDismissed, tombstones)) continue;
      const matches = requirements.filter(old => requirementKeys(old).some(key => keys.has(key))
        || ((old.managedBy !== 'requirements-auto' || old.manual) && normalizedTitle(old.title) === normalizedTitle(item.title)));
      const protectedItem = matches.find(old => old.managedBy !== 'requirements-auto' || old.manual);
      if (protectedItem) {
        requirements = requirements.filter(old => !matches.includes(old) || old.managedBy !== 'requirements-auto' || old.manual);
        continue;
      }
      const existing = matches[0];
      const sourceIds = [...new Set([...matches.flatMap(old => old.sourceIds || []),...item.sourceIds])];
      const aliases = [...new Set([...matches.flatMap(requirementKeys),...item.relatedRequirementKeys])].filter(key => key !== item.requirementKey);
      const merged = { ...item, id: existing?.id || `req-${crypto.createHash('sha256').update(`${projectId}:${item.requirementKey}`).digest('hex').slice(0,24)}`,
        managedBy: 'requirements-auto', manual: false, relatedRequirementKeys: aliases, sourceIds,
        sourceRef: [...new Set([...matches.map(old => old.sourceRef),item.sourceRef].filter(Boolean))].join('\n').slice(0,10_000),
        attachments: uniqueValues([...matches.flatMap(old => old.attachments || []),...item.attachments]).slice(0,50),
        cycleId: existing?.cycleId || project.activeCycleId, origin: existing?.origin || 'requirements-auto',
        createdAt: existing?.createdAt || now(), updatedAt: now(),
        ...mergedSourceDates([...matches,item]),
      };
      requirements = requirements.filter(old => !matches.includes(old)); requirements.push(merged);
    }
    let confirmations = clone(project.requirementConfirmations || []);
    for (const item of normalizedConfirmations) {
      const keys = new Set(confirmationKeys(item));
      if (isDismissedRequirement(confirmationDeletionItem(item), scope, new Set(), currentAnalysis.dismissedConfirmations)) continue;
      const matches = confirmations.filter(old => confirmationKeys(old).some(key => keys.has(key)));
      const protectedItem = matches.find(old => old.manual || old.managedBy !== 'requirements-auto');
      if (protectedItem) {
        confirmations = confirmations.filter(old => !matches.includes(old) || old.manual || old.managedBy !== 'requirements-auto');
        continue;
      }
      const existing = matches[0], stableKey = existing?.confirmationKey || item.confirmationKey;
      const merged = { ...item, confirmationKey: stableKey,
        id: existing?.id || `confirm-${crypto.createHash('sha256').update(`${projectId}:${stableKey}`).digest('hex').slice(0,24)}`,
        managedBy: 'requirements-auto', manual: false,
        relatedConfirmationKeys: [...new Set([...matches.flatMap(confirmationKeys),...confirmationKeys(item)])].filter(key => key !== stableKey),
        sourceIds: [...new Set([...matches.flatMap(old => old.sourceIds || []),...item.sourceIds])],
        requirementKeys: [...new Set([...matches.flatMap(old => old.requirementKeys || []),...item.requirementKeys])],
        sourceRef: [...new Set([...matches.map(old => old.sourceRef),item.sourceRef].filter(Boolean))].join('\n').slice(0,10_000),
        attachments: uniqueValues([...matches.flatMap(old => old.attachments || []),...item.attachments]).slice(0,50),
        ...mergedSourceDates([...matches,item]), createdAt: existing?.createdAt || now(), updatedAt: now(),
      };
      confirmations = confirmations.filter(old => !matches.includes(old)); confirmations.push(merged);
    }
    project.requirements = requirements;
    project.requirementConfirmations = confirmations;
    const partial = analysis.coveragePartial || (analysis.warnings || []).some(warning => /未读取|截断|提取失败|无法读取|上下文不完整|尚无可提取/.test(warning));
    project.requirementAnalysis = requirementAnalysisDefaults({ ...currentAnalysis,...analysis, blockedFingerprint: '',
      updatedAt: now(), status: { state: 'ready', message: partial ? '已整理可读取内容，部分资料尚未读取' : '需求已整理', updatedAt: now() } });
    return this._commit(project);
  }

  upsertRecord(projectId, input = {}) {
    const project = this._project(projectId);
    let existing = input.id ? project.records.find(item => item.id === input.id) : null;
    const origin = normalizeOrigin(input.origin ?? existing?.origin);
    if (input.id && !existing && !originKey(origin)) throw new Error('工作记录不存在');
    const date = dateValue(input.date ?? existing?.date ?? today());
    const draft = input.status === '待确认';
    const wantedConfirmed = draft ? false : (input.confirmed ?? existing?.confirmed ?? true);
    if (!existing && originKey(origin) && project.records.some(item => item.date === date && [item.origin, ...(item.originRefs || [])].some(ref => originKey(ref) === originKey(origin)))) return clone(project);
    let mergingRounds = false;
    if (!existing && input.issueKey) {
      existing = project.records.find(item => item.date === date && item.issueKey === input.issueKey && item.cycleId === (input.cycleId || project.activeCycleId) && item.confirmed === wantedConfirmed);
      mergingRounds = !!existing;
    }
    const prior = existing;
    const newDay = !!existing && existing.date !== date;
    // A new day creates a new snapshot, even when the caller supplies yesterday's record ID.
    if (existing && existing.date !== date) existing = null;
    const base = existing || prior;
    const status = (draft ? '进行中' : input.status) ?? (newDay ? '进行中' : base?.status) ?? '进行中';
    if (!RECORD_STATUS.has(status)) throw new Error('工作状态无效');
    const confirmed = draft ? false : (input.confirmed ?? base?.confirmed ?? true);
    if (typeof confirmed !== 'boolean') throw new Error('确认状态必须为布尔值');
    const cycleId = input.cycleId || base?.cycleId || project.activeCycleId;
    if (!project.cycles.some(cycle => cycle.id === cycleId)) throw new Error('管理周期不存在');
    let attachments = input.attachments ?? base?.attachments ?? [];
    if (mergingRounds && Array.isArray(input.attachments)) attachments = [...new Map([...(base?.attachments || []), ...input.attachments].map(item => [JSON.stringify(item), item])).values()];
    if (!Array.isArray(attachments) || attachments.length > 50) throw new Error('附件列表无效');
    const cleanAttachments = attachments.map(item => {
      if (typeof item === 'string') return plain(item, '附件路径', 4000);
      if (!item || typeof item !== 'object') throw new Error('附件无效');
      return { path: plain(item.path, '附件路径', 4000), name: plain(item.name, '附件名称', 1000), description: plain(item.description, '附件说明', 10_000) };
    });
    const item = { id: existing?.id || id(), issueKey: plain(input.issueKey ?? base?.issueKey, '事项编号', 1000),
      title: required(input.title ?? base?.title, '工作事项', 1000), date,
      cause: plain(input.cause ?? base?.cause, '原因'), action: mergingRounds ? mergeActions(base?.action, plain(input.action, '处理')) : plain(input.action ?? (newDay ? '' : base?.action), '处理'),
      result: plain(input.result ?? (newDay ? '' : base?.result), '结果'), status, confirmed,
      sourceRef: mergingRounds ? mergeActions(base?.sourceRef, plain(input.sourceRef, '来源', 10_000)) : plain(input.sourceRef ?? base?.sourceRef, '来源', 10_000), cycleId,
      origin: origin || normalizeOrigin(base?.origin), attachments: cleanAttachments,
      originRefs: [...new Map([...(base?.originRefs || []), base?.origin, origin].filter(ref => originKey(ref)).map(ref => [originKey(ref), ref])).values()],
      manual: true, autoGenerated: false,
      ...(base?.relatedIssueKeys ? { relatedIssueKeys: base.relatedIssueKeys } : {}),
      ...(base?.summaryOrigin ? { summaryOrigin: base.summaryOrigin, turnIds: base.turnIds || [] } : {}),
      createdAt: existing?.createdAt || now(), updatedAt: now(),
    };
    if (existing) project.records[project.records.indexOf(existing)] = item; else project.records.push(item);
    return this._commit(project);
  }

  removeRecord(projectId, recordId) {
    const project = this._project(projectId);
    const record = project.records.find(item => item.id === recordId);
    if (record?.autoGenerated || record?.origin?.threadId) {
      project.codex = codexDefaults(project.codex);
      project.codex.summaryDismissals ||= [];
      project.codex.summaryDismissals = uniqueValues([...project.codex.summaryDismissals, ...itemKeys(record).map(issueKey => ({ date: record.date, issueKey, threadId: record.origin?.threadId || project.codex.threadId }))]);
    }
    project.records = project.records.filter(item => item.id !== recordId);
    return this._commit(project);
  }

  setSummaryStatus(projectId, input = {}) {
    const project = this._project(projectId);
    project.codex = codexDefaults(project.codex);
    if (!SUMMARY_STATES.has(input.state)) throw new Error('自动整理状态无效');
    if (own(input, 'threadId') && input.threadId !== project.codex.threadId) throw new Error('会话已变化，请重新整理');
    project.codex.summaryStatus = { state: input.state, message: brief(input.message, '整理提示', 1000), updatedAt: now() };
    this._persist();
    return clone(project);
  }

  setCodexHistory(projectId, input = {}) {
    const project = this._project(projectId);
    project.codex = codexDefaults(project.codex);
    if (input.threadId !== project.codex.threadId) throw new Error('会话已变化，请重新整理');
    const dates = value => {
      if (!Array.isArray(value) || value.length > 4000) throw new Error('历史日期列表无效');
      return [...new Set(value.map(date => dateValue(required(date, '历史日期', 10))))].sort();
    };
    const available = dates(input.dates || []), allowed = new Set(available);
    const completedDates = dates(input.completedDates || []).filter(date => allowed.has(date));
    if (!Array.isArray(input.failedDates || []) || (input.failedDates || []).length > 4000) throw new Error('历史失败日期列表无效');
    const failedDates = [...new Map((input.failedDates || []).map(item => {
      const date = dateValue(required(item.date, '历史日期', 10));
      const fingerprint = item.eventFingerprint ? required(item.eventFingerprint, '失败内容指纹', 64) : '';
      if (fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('失败内容指纹无效');
      return [date, { date, message: brief(item.message, '历史整理提示', 300), ...(fingerprint ? { eventFingerprint: fingerprint } : {}) }];
    })).values()].filter(item => allowed.has(item.date)).sort((a, b) => a.date.localeCompare(b.date));
    const blockedSourceFingerprint = input.blockedSourceFingerprint || '';
    if (blockedSourceFingerprint && !/^[a-f0-9]{64}$/.test(blockedSourceFingerprint)) throw new Error('失败内容指纹无效');
    const value = { threadId: input.threadId, dates: available, completedDates, failedDates, truncated: !!input.truncated, blockedSourceFingerprint };
    const previous = project.codex.history;
    if (previous && JSON.stringify({ ...previous, updatedAt: undefined }) === JSON.stringify(value)) return clone(project);
    project.codex.history = { ...value, updatedAt: now() };
    this._persist();
    return clone(project);
  }

  getDailySummary(projectId, date) {
    const project = this._project(projectId);
    date = dateValue(date);
    return clone(codexDefaults(project.codex).dailySummaries.find(summary => summary.date === date) || null);
  }

  _processedTurns(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 20000) throw new Error('已整理轮次指纹无效');
    return Object.fromEntries(Object.entries(value).map(([id, fingerprint]) => {
      id = required(id, '已整理轮次', 1000);
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('已整理轮次指纹无效');
      return [id, fingerprint];
    }));
  }

  setDailySummaryCheckpoint(projectId, input = {}) {
    const project = this._project(projectId);
    if (input.threadId !== project.codex.threadId) throw new Error('会话已变化，请重新整理');
    const summary = project.codex.dailySummaries.find(item => item.date === dateValue(input.date));
    if (!summary) throw new Error('当日摘要不存在');
    const processedTurns = this._processedTurns(input.processedTurns);
    if (JSON.stringify(summary.processedTurns) === JSON.stringify(processedTurns)) return clone(project);
    summary.processedTurns = processedTurns;
    this._persist();
    return clone(project);
  }

  applyDailySummary(projectId, input = {}) {
    const project = this._project(projectId);
    const codex = codexDefaults(project.codex);
    const date = dateValue(input.date);
    const threadId = own(input, 'threadId') ? plain(input.threadId, '会话编号', 1000) : codex.threadId;
    if (threadId !== codex.threadId) throw new Error('会话已变化，忽略旧会话的整理结果');
    if (!['model', 'local'].includes(input.method)) throw new Error('自动整理方式无效');
    const fingerprint = required(input.fingerprint, '内容指纹', 512);
    if (!Array.isArray(input.items) || input.items.length > 100) throw new Error('自动整理事项应为最多 100 项的列表');
    const grouped = new Map();
    for (const raw of input.items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('自动整理事项无效');
      const title = brief(raw.title, '事项标题', 160);
      if (!title) continue;
      const issueKey = brief(raw.issueKey, '事项编号', 300) || `issue-${crypto.createHash('sha256').update(normalizedTitle(title)).digest('hex').slice(0, 16)}`;
      const turnIds = raw.turnIds ?? [];
      if (!Array.isArray(turnIds) || turnIds.length > 1000) throw new Error('来源轮次列表无效');
      const item = { issueKey, title, cause: brief(raw.cause, '原因', 400), action: brief(raw.action, '处理', 800), result: brief(raw.result, '结果', 600),
        relatedIssueKeys: relatedKeys(raw.relatedIssueKeys, issueKey),
        status: SUMMARY_ITEM_STATUS.has(raw.status) ? raw.status : '待确认',
        turnIds: [...new Set(turnIds.map(turnId => plain(turnId, '来源轮次', 1000)).filter(Boolean))],
        attachments: summaryAttachments(raw.attachments), sourceRef: brief(raw.sourceRef, '来源', 4000),
      };
      const previous = grouped.get(issueKey);
      if (previous) {
        item.relatedIssueKeys = uniqueValues([...previous.relatedIssueKeys, ...item.relatedIssueKeys]);
        item.cause ||= previous.cause;
        item.action = mergeActions(previous.action, item.action).slice(0, 800);
        item.result ||= previous.result;
        item.turnIds = [...new Set([...previous.turnIds, ...item.turnIds])];
        item.attachments = uniqueValues([...previous.attachments, ...item.attachments]).slice(0, 50);
        item.sourceRef = mergeActions(previous.sourceRef, item.sourceRef).slice(0, 4000);
      }
      grouped.set(issueKey, item);
    }
    const ownedDrafts = project.records.filter(record => record.date === date && record.managedBy === 'codex-auto' && !record.confirmed && !record.manual);
    const retained = project.records.filter(record => !(record.date === date && record.managedBy === 'codex-auto' && !record.confirmed && !record.manual));
    const dismissedKey = key => (codex.summaryDismissals || []).some(entry => entry.date === date && entry.issueKey === key && entry.threadId === threadId);
    const protectedFor = item => retained.find(record => record.date === date && (sameIssue(record, item) || normalizedTitle(record.title) === normalizedTitle(item.title)));
    const reconciled = new Map(), claimed = new Map();
    for (const item of grouped.values()) {
      for (const key of itemKeys(item)) {
        if (claimed.has(key) && claimed.get(key) !== item.issueKey) throw new Error('同一关联事项不能重复分组');
        claimed.set(key, item.issueKey);
      }
      if (!itemKeys(item).some(dismissedKey)) { reconciled.set(item.issueKey, item); continue; }
      // A deleted member must not return under a merged title. Keep unaffected
      // existing drafts rather than discarding their work with the rejected group.
      for (const prior of ownedDrafts.filter(record => sameIssue(record, item) && !itemKeys(record).some(dismissedKey))) {
        reconciled.set(prior.issueKey, { issueKey: prior.issueKey, title: prior.title, cause: prior.cause, action: prior.action, result: prior.result, status: prior.status,
          relatedIssueKeys: relatedKeys(prior.relatedIssueKeys, prior.issueKey), turnIds: prior.turnIds || [], attachments: prior.attachments || [], sourceRef: prior.sourceRef || '' });
      }
    }
    const items = [...reconciled.values()];
    const time = now();
    const summary = { date, fingerprint, method: input.method, updatedAt: time, threadId, items,
      reportText: brief(input.reportText, '自动日报草稿', 30_000) || summaryReport(project, date, items.map(item => protectedFor(item) || item)),
      ...(own(input, 'processedTurns') ? { processedTurns: this._processedTurns(input.processedTurns) } : {}),
    };
    const previousSummary = codex.dailySummaries.find(item => item.date === date);
    const samePayload = previousSummary && previousSummary.fingerprint === fingerprint && previousSummary.method === summary.method && JSON.stringify(previousSummary.items) === JSON.stringify(items) && previousSummary.reportText === summary.reportText;
    if (samePayload) {
      project.codex = codex;
      if (own(summary, 'processedTurns')) previousSummary.processedTurns = summary.processedTurns;
      project.codex.summaryStatus = { state: 'ready', message: '已按日期整理，待核对。', updatedAt: time };
      this._persist();
      return clone(project);
    }
    for (const item of items) {
      const recordId = autoRecordId(threadId, date, item.issueKey);
      const protectedRecord = protectedFor(item);
      const dismissed = itemKeys(item).some(dismissedKey);
      if (protectedRecord || dismissed) continue;
      const prior = ownedDrafts.find(record => record.id === recordId) || ownedDrafts.find(record => sameIssue(record, item));
      const origin = { threadId, turnId: item.turnIds[0] || '' };
      retained.push({ id: recordId, issueKey: item.issueKey, title: item.title, date, cause: item.cause, action: item.action, result: item.result,
        relatedIssueKeys: item.relatedIssueKeys,
        status: item.status === '待确认' ? '进行中' : item.status, sourceRef: item.sourceRef, attachments: item.attachments,
        turnIds: item.turnIds, origin, originRefs: item.turnIds.map(turnId => ({ threadId, turnId })),
        summaryOrigin: { threadId, date, issueKey: item.issueKey },
        confirmed: false, managedBy: 'codex-auto', autoGenerated: true, manual: false, cycleId: prior?.cycleId || project.activeCycleId,
        createdAt: prior?.createdAt || time, updatedAt: time,
      });
    }
    project.records = retained;
    project.codex = codex;
    project.codex.dailySummaries = [...codex.dailySummaries.filter(item => item.date !== date), summary].sort((a, b) => a.date.localeCompare(b.date));
    project.codex.summaryStatus = { state: 'ready', message: '已按日期整理，待核对。', updatedAt: time };
    return this._commit(project);
  }

  generateReport(projectId, date) {
    const project = this._project(projectId);
    date = dateValue(date);
    const organized = project.dailyDesk?.days?.[date];
    if (organized?.digest?.workEvidenceVersion===2 && organized.digest.reportText && !(project.codex?.summaryDismissals||[]).some(d=>d.date===date&&d.threadId===project.codex?.threadId) && !project.records.some(r => r.date === date && (r.manual || r.confirmed))) {
      return { text: organized.digest.reportText, date, recordIds: project.records.filter(r => r.date === date).map(r => r.id), method: organized.digest.method || 'model', needsReview: true };
    }
    const confirmed = project.records.filter(record => record.date === date && record.confirmed === true);
    const drafts = project.records.filter(record => record.date === date && !record.confirmed && (record.managedBy === 'codex-auto' || record.summaryOrigin)
      && !confirmed.some(done => sameIssue(record, done) || normalizedTitle(done.title) === normalizedTitle(record.title)));
    const records = [...confirmed, ...drafts].filter(record=>record.confirmed||record.manual||!materialOnly(record));
    const dailySummary = codexDefaults(project.codex).dailySummaries.find(summary => summary.date === date);
    const canonical = new Map();
    for (const item of dailySummary?.items || []) for (const key of itemKeys(item)) canonical.set(key, item.issueKey);
    const groups = new Map();
    for (const record of records) {
      const linkedKey = itemKeys(record).map(key => canonical.get(key)).find(Boolean) || record.issueKey || record.title.trim().toLowerCase();
      const key = `${record.cycleId}:${linkedKey}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    const parts = [],reportItems=[];
    for (const rounds of groups.values()) {
      rounds.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const latest = rounds[rounds.length - 1];
      const unique = key => [...new Set(rounds.map(record => line(record[key])).filter(Boolean))].join('；');
      const cause = line([...rounds].reverse().find(record => record.cause)?.cause || '');
      const action = unique('action');
      const result = line(latest.result);
      reportItems.push({ ...latest, cause, action, result });
      parts.push(reportLine(reportItems.at(-1)));
    }
    return { text: organized ? workReport(project.name,reportItems) : `# ${project.name} · ${date} 日报\n\n${parts.length ? parts.join('\n\n') : '当天暂无已确认的工作记录。'}\n`, date, recordIds: records.map(record => record.id), method: drafts.length ? dailySummary?.method || 'local' : 'manual', includedDrafts: drafts.length, needsReview: drafts.length > 0 };
  }

  combinedReport(date, drafts = []) {
    date=dateValue(date);
    if(!Array.isArray(drafts)||drafts.length>this.state.projects.length)throw new Error('日报草稿无效');
    const overrides=new Map();
    for(const draft of drafts){this._project(draft.id);if(overrides.has(draft.id)||typeof draft.text!=='string'||draft.text.length>200000)throw new Error('日报草稿无效');overrides.set(draft.id,draft.text);}
    const texts=[],pendingProjects=[];
    for(const project of this.state.projects){
      if(project.archivedAt)continue;
      const day=project.dailyDesk?.days?.[date],saved=project.reports.find(r=>r.date===date&&!r.autoArchived);
      if(day?.unprocessedCount||day?.status==='error')pendingProjects.push(project.name);
      const text=overrides.has(project.id)?overrides.get(project.id):saved?.text || this.generateReport(project.id,date).text;
      const hasWork=overrides.has(project.id)||saved||project.records.some(r=>r.date===date&&(r.confirmed||r.manual||!materialOnly(r)))||day?.digest?.workEvidenceVersion===2&&day.digest.reportText;
      if(hasWork&&text.trim())texts.push(`## ${project.name}\n\n${text.replace(/^# .+\r?\n+/,'').trim()}`);
    }
    return {date,pendingProjects,text:`# ${date} 工作日报\n\n${texts.join('\n\n') || '当天暂无已整理工作。'}`};
  }

  saveReport(projectId, date, text, { automatic = false } = {}) {
    const project = this._project(projectId);
    date = dateValue(date);
    const value = required(text, '日报内容', 200_000);
    const existing = project.reports.find(report => report.date === date);
    const report = { id: existing?.id || id(), date, text: value, autoArchived: automatic, updatedAt: now(), path: path.join(this._projectDir(projectId), '日报', `${date}.md`) };
    if (existing) project.reports[project.reports.indexOf(existing)] = report; else project.reports.push(report);
    return this._commit(project);
  }

  saveDailyDesk(projectId, date, patch = {}) {
    const project = this._project(projectId);
    date = dateValue(date);
    project.dailyDesk ||= { days: {} };
    project.dailyDesk.days ||= {};
    const {fileCheckpoints,...dayPatch}=clone(patch);
    if(fileCheckpoints)project.dailyDesk.fileCheckpoints=fileCheckpoints;
    project.dailyDesk.days[date] = { ...project.dailyDesk.days[date], ...dayPatch };
    this._persist();
    return clone(project.dailyDesk.days[date]);
  }

  applyDailyDesk(projectId, input) {
    const project = this._project(projectId), date = dateValue(input.date);
    if (input.threadId !== project.codex.threadId) throw new Error('会话已变化');
    // Validate both existing merge contracts on an isolated state before a single
    // real commit; malformed model output cannot leave a half-applied project.
    const shadow = Object.create(Store.prototype);
    shadow.state = clone(this.state);
    shadow._persist = () => {};
    shadow._commit = value => clone(value);
    shadow.applyRequirementSummary(projectId, { items: input.requirements, confirmations: input.confirmations, method: 'model', threadId: input.threadId });
    shadow.applyDailySummary(projectId, { date, items: input.items, method: 'model', fingerprint: input.fingerprint, threadId: input.threadId });
    const next = shadow._project(projectId), time = now();
    next.materialAnnotations ||= {};
    materialTags.mergeAnnotations({...next,managementDir:this._projectDir(projectId)},input.materialTags||[],'model');
    next.dailyDesk ||= { days: {} };
    next.dailyDesk.days ||= {};
    next.dailyDesk.days[date] = { ...next.dailyDesk.days[date], digest: input.digest, processed: input.processed, sourceCheckpoints:input.sourceCheckpoints || {},evidenceVersion:input.evidenceVersion || 0,pendingFiles:input.pendingFiles || 0,pendingConfirmations:input.pendingConfirmations||0, pending: input.pending, unprocessedCount: input.pending, partial: input.partial, organizedAt: time, status: 'ready', message: input.pendingConfirmations ? `已保存本批成果，仍有 ${input.pendingConfirmations} 组确认问题待整理` : input.pending ? `已整理一批，仍有 ${input.pending} 项待整理` : input.partial ? '已整理可读取内容，原会话读取范围受限' : '已整理，新增内容收录后可再次点击整理' };
    next.dailyDesk.fileCheckpoints = input.fileCheckpoints;
    // An older day must never replace the current project introduction/progress.
    if (!next.dailyDesk.overviewDate || date >= next.dailyDesk.overviewDate) { next.dailyDesk.overview = input.digest.overview; next.dailyDesk.overviewDate = date; }
    Object.assign(project, next);
    return this._commit(project);
  }

  startCycle(projectId, name) {
    const project = this._project(projectId);
    name = required(name, '周期名称', 300);
    const previous = project.cycles.find(cycle => cycle.id === project.activeCycleId);
    if (previous) { previous.status = '已结束'; previous.endedAt ||= now(); }
    const cycle = { id: id(), name, status: '进行中', startedAt: now() };
    project.cycles.push(cycle);
    project.activeCycleId = cycle.id;
    project.stage = '需求梳理';
    project.nextAction = '';
    project.blocker = '';
    return this._commit(project);
  }

  addDelivery(projectId, input = {}) {
    const project = this._project(projectId);
    const cycleId = input.cycleId || project.activeCycleId;
    if (!project.cycles.some(cycle => cycle.id === cycleId)) throw new Error('管理周期不存在');
    project.deliveries.push({ id: id(), cycleId, date: dateValue(input.date),
      version: plain(input.version, '版本', 500), title: plain(input.title, '交付标题', 1000),
      summary: required(input.summary || input.description || input.title || input.version, '交付内容'),
      sourceRef: plain(input.sourceRef || input.path, '交付文件', 10_000),
      status: plain(input.status, '验收状态', 1000) || '待客户验证', createdAt: now(),
    });
    return this._commit(project);
  }
}

module.exports = { Store, today, dateValue, STAGES, REQUIREMENT_STATUS, RECORD_STATUS };
