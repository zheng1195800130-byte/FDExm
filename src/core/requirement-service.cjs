'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateConfig, requiresApiKey } = require('./model-api.cjs');

const VERSION = 4;
const MAX_SOURCE_CHARS = 18000;
const MAX_INPUT_CHARS = 160000;
const MAX_INPUT_SOURCES = 128; // Leaves room for 60 requirements and 60 confirmations.
const MAX_INITIAL_TURNS = 6;
const MAX_BUSINESS_TURNS = 60;
const MAX_PREVIOUS_ITEMS = 60;
const CODE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1', '.bat', '.cmd', '.exe', '.dll']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = values => [...new Set(values)];
function clean(value, limit = 1000) {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n')
    .replace(/data:[a-z0-9/+.-]+(?:;[a-z0-9=.-]+)*;base64,[a-z0-9+/=\r\n]+/gi, '[媒体数据已省略]')
    .replace(/\b[A-Za-z0-9+/]{512,}={0,2}/g, '[长编码内容已省略]').trim().slice(0, limit) : '';
}
function contextOf(project) {
  return hash({ captureVersion: VERSION, sourceDir: project.sourceDir || '', devDir: project.devDir || '', threadId: project.codex?.threadId || '' });
}
function attachments(values) {
  return (Array.isArray(values) ? values : []).filter(item => item && typeof item === 'object').slice(0, 50).map(item => ({
    type: clean(item.type, 80) || 'file',
    ...(clean(item.path, 1000) && !/^(?:data:|https?:|javascript:)/i.test(item.path) ? { path: clean(item.path, 1000) } : {}),
    description: clean(item.description, 240) || '业务资料附件',
  }));
}
function within(candidate, parent) {
  if (!candidate || !parent) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function materialPriority(file) {
  const name = clean(file.name, 500).toLowerCase();
  if (/需求|业务|规则|流程|纪要|会议|说明|范围|方案|操作|sop|requirement|business|workflow/.test(name)) return 0;
  if (/样例|示例|样本|账单|明细|流水|sample|example|demo/.test(name)) return 3;
  return /\.(?:md|markdown|txt|docx|pdf|html?)$/i.test(name) ? 1 : 2;
}
function extractionPartial(file) { return Boolean(file.parseError || /截断|前\s*\d|超出|超过|过大|限制|扫描件|未.*识别|未.*提取/.test(file.previewNote || '')); }
function partialWarnings(warnings) { return warnings.some(warning => /未读取|截断|提取失败|读取受限|上下文不完整|未能补回|尚无可提取|无法读取|未.*识别|内容过长|超过.*条/.test(warning)); }
function fileEntries(project, managedFolder) {
  const managedDataDir = managedFolder ? path.dirname(path.dirname(managedFolder)) : '';
  return (project.files || []).filter(file => file && ['原始资料', '补充资料'].includes(file.kind) && !file.missing
    && !CODE_EXTENSIONS.has(path.extname(file.name || file.path || '').toLowerCase())
    && (file.kind === '原始资料' ? within(file.path, project.sourceDir) && !within(file.path, managedDataDir)
      && (!within(project.devDir, project.sourceDir) || !within(file.path, project.devDir))
      : !managedFolder || within(file.path, path.join(managedFolder, 'supplements'))))
    .map(file => {
      const id = clean(file.id, 200) || hash(file.path || file.name).slice(0, 32);
      const body = file.parseError ? '' : clean(file.textPreview, 80000);
      const userDescription = file.descriptionSource === 'user' ? clean(file.description, 2000) : '';
      const text = [userDescription && `用户补充说明：${userDescription}`, body].filter(Boolean).join('\n\n');
      return { id, file, text, fingerprint: hash({ id, name: file.name || '', path: file.path || '', kind: file.kind, text }) };
    }).sort((a, b) => materialPriority(a.file) - materialPriority(b.file) || String(a.file.name).localeCompare(String(b.file.name), 'zh-CN') || a.id.localeCompare(b.id));
}
function fileStamp(project, managedFolder) { return hash(fileEntries(project, managedFolder).map(item => [item.id, item.fingerprint])); }
function completedTurns(values, threadId) {
  const map = new Map();
  for (const turn of Array.isArray(values) ? values : []) {
    if (!turn || !turn.completed || !clean(turn.id, 200) || !clean(turn.assistantText, 100) || (turn.threadId && turn.threadId !== threadId)) continue;
    map.set(turn.id, turn);
  }
  return [...map.values()].map((turn, index) => ({ turn, index })).sort((a, b) => {
    const timeA = Date.parse(a.turn.timestamp), timeB = Date.parse(b.turn.timestamp);
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB;
    return String(a.turn.date || '').localeCompare(String(b.turn.date || '')) || a.index - b.index;
  }).map(item => item.turn);
}
function businessTurn(turn, initial = false) {
  // Assistant implementation claims cannot turn a repair into a customer need.
  const text = clean(turn.userText, 20000).replace(/```[\s\S]*?```/g, ' ');
  if (text.length < 10) return false;
  const explicit = /(?:业务需求|需求(?:清单|范围|补充|变更|确认)|(?:客户|用户)(?:希望|要求|需要|补充)|(?:补充|新增|增加|调整|变更|修改|加个|加一个).{0,16}(?:业务|需求|规则|流程|功能|权限|角色|字段|报表|统计)|(?:必须|应当|需要|希望).{0,24}(?:支持|能够|实现|提供|业务|功能)|(?:业务资料|原始资料|会议纪要).{0,32}(?:梳理|分析|整理|需求)|(?:梳理|分析|整理).{0,32}(?:业务|需求)|(?:我想|想要).{0,24}(?:工具|系统|应用|软件))/i.test(text);
  if (explicit) return true;
  if (/(?:报错|异常|失败|崩溃|卡死|修复|修一下|测试|编译|打包|构建|控制台|堆栈|日志|npm|electron|undefined|TypeError|Error:|\bbug\b|\bfix\b)/i.test(text)) return false;
  if (/(?:客户|用户|业务|需求|审批|权限|角色|订单|采购|库存|合同|报表|排班|表单|单据|导入规则|导出规则|字段含义|使用场景|工作流程)/i.test(text)) return true;
  // Keep an early natural-language business brief even without domain keywords.
  return initial && text.length >= 30 && !/(?:继续开发|生成项目|启动项目|运行项目|安装依赖|代码|函数|接口|组件|样式|按钮|颜色|像素|截图)/i.test(text);
}
const BUSINESS_TOPIC = /客户|用户|业务|需求|数据来源|字段|口径|规则|流程|订单|采购|库存|合同|报表|审批|权限|提单|运单|配载|航班|货物|仓库|账单|结算|ERP|表格导入|Excel|接口对接/i;
const UNDECIDED = /无法(?:获取|确定|判断|确认)|获取不到|拿不到|暂时|暂缓|搁置|待确认|需(?:要)?(?:再|向|和|跟)?.{0,10}(?:确认|询问)|尚未(?:确定|明确)|不确定|不清楚|先.{0,30}(?:导入|代替|替代|处理|保留)|后续.{0,20}(?:补充|对接|确认)|是否|怎么(?:获取|确定|判断)|从哪|哪些|[？?]/i;
const TECHNICAL_REPAIR = /报错|崩溃|编译|打包|构建|堆栈|npm|electron|undefined|TypeError|Error:|\bbug\b/i;
function confirmationTurn(turn) {
  const user = clean(turn.userText, 20000), assistant = clean(turn.assistantText, 20000);
  // A generic “needs confirmation” footer in a technical repair is not a new
  // business question. Both speakers can otherwise introduce a real gap.
  if (TECHNICAL_REPAIR.test(user) && !BUSINESS_TOPIC.test(user)) return false;
  const userSignal = user.replace(/(?:梳理|整理|分析).{0,40}(?:待确认(?:的)?(?:问题|事项)|需求)/g, '');
  const assistantSignal = /无法(?:获取|确定|判断)|获取不到|拿不到|暂缓|搁置|不确定|不清楚|先.{0,30}(?:导入|代替|替代)|后续.{0,20}(?:补充|对接)|[？?]/i.test(assistant);
  return BUSINESS_TOPIC.test(`${user}\n${assistant}`) && (UNDECIDED.test(userSignal) || assistantSignal || (assistant.length >= 80 && UNDECIDED.test(assistant)));
}
function confirmationContextTurns(turns, previous = []) {
  const anchors = new Set();
  const topics = previous.flatMap(item => `${item.scenario || ''} ${item.question || ''}`.match(/提单|运单|ERP|订单|字段|口径|账单|结算|配载|库存|审批|权限|报表|航班|货物|仓库|数据来源/g) || []);
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index], text = `${clean(turn.userText, 20000)}\n${clean(turn.assistantText, 20000)}`;
    if (confirmationTurn(turn) || (topics.some(topic => text.includes(topic)) && /客户(?:确认|明确)|已确认|最终(?:采用|确定|决定)|决定|已获取|字段(?:为|是)|来源(?:为|是)|问题(?:已)?解决/.test(text))) anchors.add(index);
  }
  const selected = new Set();
  for (const index of anchors) for (let nearby = Math.max(0, index - 1); nearby <= Math.min(turns.length - 1, index + 2); nearby++) selected.add(turns[nearby].id);
  return selected;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toISOString();
}
function turnEntry(turn, threadId, initial) {
  const user = clean(turn.userText, 11000), assistant = clean(turn.assistantText, 6000);
  const text = `用户提出：\n${user}\n\nCodex 整理（仅供参考，不代表客户已确认）：\n${assistant}`;
  return { id: `turn:${hash([threadId, turn.id]).slice(0, 40)}`, type: 'business-turn', title: initial ? '初始业务沟通' : '业务补充沟通',
    text, sourceRef: clean(turn.sourceRef, 4000) || `codex:${threadId}#turn=${encodeURIComponent(turn.id)}`, attachments: attachments(turn.attachments), ...(timestamp(turn.timestamp) ? { timestamp: timestamp(turn.timestamp) } : {}) };
}
function priorContext(requirements) {
  const items = [], sources = [];
  for (const item of (requirements || []).slice(-MAX_PREVIOUS_ITEMS)) {
    if (!item || !clean(item.title, 80)) continue;
    const requirementKey = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.requirementKey || '') ? item.requirementKey : `manual_${hash(item.id || item.title).slice(0, 32)}`;
    let sourceIds = unique((item.sourceIds || []).filter(value => typeof value === 'string' && value.length <= 240 && value && !/[\u0000-\u001f\u007f]/.test(value)));
    const questions = (item.questions || []).filter(value => typeof value === 'string').map(value => clean(value, 180)).filter(Boolean).slice(0, 12);
    if (!sourceIds.length) {
      const sourceId = `req:${hash(item.id || requirementKey).slice(0, 40)}`;
      sourceIds = [sourceId];
      sources.push({ id: sourceId, type: 'existing-requirement', title: clean(item.title, 80),
        text: [clean(item.title, 80), clean(item.description, 600), ...questions].filter(Boolean).join('\n'), sourceRef: clean(item.sourceRef, 4000) || '本项目已保存的人工需求', attachments: attachments(item.attachments) });
    }
    items.push({ requirementKey, title: clean(item.title, 80), description: clean(item.description, 600), questions,
      status: questions.length || item.status === '待确认' ? '待确认' : '已明确', sourceIds,
      relatedRequirementKeys: (item.relatedRequirementKeys || []).filter(value => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)), sourceRef: clean(item.sourceRef, 4000), attachments: attachments(item.attachments), sourceFirstAt: timestamp(item.sourceFirstAt), sourceLastAt: timestamp(item.sourceLastAt) });
  }
  return { items, sources };
}
function priorConfirmations(values) {
  const items = [], sources = [], keyValid = value => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value || '');
  for (const item of (values || []).slice(-MAX_PREVIOUS_ITEMS)) {
    if (!clean(item.scenario, 240) || !clean(item.question, 180)) continue;
    const confirmationKey = keyValid(item.confirmationKey) ? item.confirmationKey : `manual_${hash(item.id || item.scenario).slice(0, 32)}`;
    let sourceIds = unique((item.sourceIds || []).filter(value => typeof value === 'string' && value.length <= 240 && value && !/[\u0000-\u001f\u007f]/.test(value)));
    if (!sourceIds.length) {
      const sourceId = `confirm:${hash(item.id || confirmationKey).slice(0, 40)}`; sourceIds = [sourceId];
      sources.push({ id: sourceId, type: 'existing-confirmation', title: clean(item.scenario, 240), text: [item.scenario, item.question, item.workaround, item.resolution].map(value => clean(value, 600)).filter(Boolean).join('\n'), sourceRef: clean(item.sourceRef, 4000) || '本项目已保存的人工确认事项', attachments: attachments(item.attachments) });
    }
    items.push({ confirmationKey, scenario: clean(item.scenario, 240), question: clean(item.question, 180), workaround: clean(item.workaround, 240), status: item.status === '已解决' && clean(item.resolution, 240) ? '已解决' : '待确认', resolution: clean(item.resolution, 240), sourceIds,
      relatedConfirmationKeys: (item.relatedConfirmationKeys || []).filter(keyValid), requirementKeys: (item.requirementKeys || []).filter(keyValid), sourceRef: clean(item.sourceRef, 4000), attachments: attachments(item.attachments), sourceFirstAt: timestamp(item.sourceFirstAt), sourceLastAt: timestamp(item.sourceLastAt) });
  }
  return { items, sources };
}
function safeError(error, apiKey) {
  let message = clean(error?.message, 1000) || '需求整理失败，请重试';
  if (apiKey) message = message.split(apiKey).join('[密钥已省略]');
  return message.replace(/Bearer\s+\S+/ig, 'Bearer [已省略]').slice(0, 300);
}

// Event-driven only. The desktop layer schedules after material/turn changes;
// this service has no polling interval and never writes raw conversations.
class RequirementService {
  constructor({ store, reader, summarizer, getModel, commit = fn => Promise.resolve().then(fn), notify = () => {}, delay = 5000 }) {
    Object.assign(this, { store, reader, summarizer, getModel, commit, notify, delay });
    this.jobs = new Map(); this.revision = 0; this.stopped = false;
  }
  project(id) { return this.store.getState().projects.find(project => project.id === id && !project.archivedAt); }
  schedule(id, { force = false, retryFailed = false, delay = this.delay } = {}) {
    if (this.stopped || !id) return;
    let job = this.jobs.get(id);
    if (!job) { job = { running: false, pending: false, force: false, retryFailed: false, timer: null }; this.jobs.set(id, job); }
    job.pending = true; job.force ||= force; job.retryFailed ||= retryFailed;
    clearTimeout(job.timer);
    if (!job.running) job.timer = setTimeout(() => this.run(id), Math.max(0, delay));
  }
  invalidate() {
    this.revision++;
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.pending = false; job.force = false; job.retryFailed = false; }
  }
  stop() { this.stopped = true; this.invalidate(); }
  async patch(id, patch, valid) {
    await this.commit(() => {
      if (!valid()) return;
      const current = this.project(id).requirementAnalysis || {};
      // Repeated watcher events must not rewrite an identical status/checkpoint.
      const comparable = value => ({ ...value, ...(value.status ? { status: { state: value.status.state, message: value.status.message } } : {}) });
      if (Object.entries(comparable(patch)).every(([key, value]) => JSON.stringify(value) === JSON.stringify(comparable(current)[key]))) return;
      this.store.setRequirementAnalysis(id, patch);
      this.notify({ type: 'requirementsUpdated', projectId: id });
    });
  }
  async status(id, state, message, warnings, sourceCount, valid, coveragePartial = partialWarnings(warnings), omittedCount = 0) {
    return this.patch(id, { status: { state, message, updatedAt: new Date().toISOString() }, warnings, sourceCount, coveragePartial, omittedCount }, valid);
  }
  async readConversation(project, warnings, valid) {
    const threadId = project.codex?.threadId || '';
    if (!threadId || !this.reader?.readThread) return [];
    try {
      const read = await this.reader.readThread({ threadId, cwd: project.devDir, history: true });
      if (!valid()) return [];
      if (read.thread?.id && read.thread.id !== threadId) throw new Error('项目会话不一致，未采用本次对话内容');
      let turns = read.turns || [];
      if (read.workTruncated ?? read.truncated) {
        warnings.push('会话历史读取受限；已保存的需求会保留，请核对遗漏的业务补充。');
        const firstDates = unique((read.discoveredDates || []).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))).sort().slice(0, 2);
        const initial = [];
        for (const date of firstDates) {
          const scoped = await this.reader.readThread({ threadId, cwd: project.devDir, history: true, date });
          if (!valid()) return [];
          if (scoped.thread?.id && scoped.thread.id !== threadId) continue;
          initial.push(...(scoped.turns || []));
          if (scoped.workTruncated ?? scoped.truncated) warnings.push('初始业务沟通也超出读取范围，本次上下文不完整。');
          if (completedTurns(initial, threadId).length >= MAX_INITIAL_TURNS) break;
        }
        if (!initial.length) warnings.push('未能补回初始业务沟通，本次仅采用可读取的资料和业务补充。');
        turns = [...initial, ...turns];
      }
      return completedTurns(turns, threadId);
    } catch (error) {
      warnings.push('Codex 业务对话暂时无法读取，本次仅采用可提取的资料；原有需求保留。');
      return [];
    }
  }
  async run(id) {
    const job = this.jobs.get(id);
    if (!job || job.running || this.stopped) return;
    clearTimeout(job.timer); job.timer = null; job.running = true; job.pending = false;
    const force = job.force, retryFailed = job.retryFailed, revision = this.revision;
    job.force = false; job.retryFailed = false;
    const captured = this.project(id);
    if (!captured) { job.running = false; return; }
    const managedFolder = this.store.projectFolder?.(id);
    const contextKey = contextOf(captured), stamp = fileStamp(captured, managedFolder), threadId = captured.codex?.threadId || '';
    let config, apiKey = '', fingerprint = '', warnings = [], sourceCount = 0;
    const valid = () => {
      const current = this.project(id);
      if (this.stopped || this.revision !== revision || !current || (current.archiveRevision || 0) !== (captured.archiveRevision || 0) || contextOf(current) !== contextKey || fileStamp(current, managedFolder) !== stamp) return false;
      if (!config) return true;
      try {
        const model = this.getModel();
        return JSON.stringify(validateConfig(model.config)) === JSON.stringify(config) && (model.apiKey || '') === apiKey;
      } catch { return false; }
    };
    try {
      const model = this.getModel(); config = validateConfig(model.config); apiKey = model.apiKey || '';
      const files = fileEntries(captured, managedFolder);
      if (captured.scanWarning) warnings.push(clean(captured.scanWarning, 1000));
      for (const entry of files) {
        const name = clean(entry.file.name, 160) || '未命名资料';
        if (entry.file.parseError) warnings.push(`${name}：正文提取失败，未依据文件名推断需求。`);
        else if (!clean(entry.file.textPreview, 1)) warnings.push(`${name}：尚无可提取正文${entry.file.type === 'image' ? '，图片文字未识别' : ''}。`);
        if (/截断|前\s*\d|超出|超过|过大|限制|扫描件|未.*识别|未.*提取/.test(entry.file.previewNote || '')) warnings.push(`${name}：${clean(entry.file.previewNote, 350)}`);
      }
      if (!config.enabled || (!apiKey && requiresApiKey(config))) {
        await this.status(id, 'unconfigured', config.enabled ? '填写模型密钥后自动整理业务需求；已有需求保留。' : '启用整理模型后自动提炼业务需求；已有需求保留。', unique(warnings).slice(0, 100), files.filter(file => file.text).length, valid);
        return;
      }
      const turns = await this.readConversation(captured, warnings, valid);
      if (!valid()) return;
      const analysis = this.project(id).requirementAnalysis || {};
      const sameContext = analysis.contextKey === contextKey;
      const previousSources = sameContext ? analysis.processedSources || {} : {};
      const previousTurns = sameContext ? analysis.processedTurns || {} : {};
      const knownInitial = new Set(sameContext ? analysis.initialTurnIds || [] : []);
      const confirmationTurns = confirmationContextTurns(turns, this.project(id).requirementConfirmations || []);
      const business = turns.filter((turn, index) => knownInitial.has(turn.id) || businessTurn(turn, index < MAX_INITIAL_TURNS) || confirmationTurns.has(turn.id));
      const initialTurnIds = unique([...knownInitial, ...business.map(turn => turn.id)]).slice(0, MAX_INITIAL_TURNS);
      const initialSet = new Set(initialTurnIds);
      if (business.length > MAX_INITIAL_TURNS && !analysis.fingerprint) warnings.push(`初始业务背景最多采用 ${MAX_INITIAL_TURNS} 轮，其余业务内容按补充沟通整理。`);
      const entries = business.map(turn => ({ turn, source: turnEntry(turn, threadId, initialSet.has(turn.id)), fingerprint: hash({ user: clean(turn.userText, 20000), assistant: clean(turn.assistantText, 20000), timestamp: timestamp(turn.timestamp), attachments: attachments(turn.attachments), sourceRef: clean(turn.sourceRef, 4000) }) }));
      const usableFiles = files.filter(entry => entry.text);
      const publicInput = { version: VERSION, contextKey, config, files: usableFiles.map(entry => [entry.id, entry.fingerprint]), turns: entries.map(entry => [entry.turn.id, entry.fingerprint]) };
      const fullFingerprint = hash({ ...publicInput, mode: 'requirements-and-confirmations' });
      const confirmationsFingerprint = hash({ ...publicInput, mode: 'confirmations-only' });
      // During an upgrade, existing business requirements stay in place while
      // the model fills the newly supported confirmation history. Keep the
      // failed migration mode stable too, so watcher events cannot retry it.
      const confirmationsOnly = (this.project(id).requirements || []).length > 0
        && (!sameContext || analysis.blockedFingerprint === confirmationsFingerprint);
      fingerprint = confirmationsOnly ? confirmationsFingerprint : fullFingerprint;
      sourceCount = usableFiles.length + business.length;
      if (!usableFiles.length && !business.length) {
        await this.status(id, 'idle', '暂无可提取的业务正文或已完成的业务沟通；已有需求保留。', unique(warnings).slice(0, 100), 0, valid);
        return;
      }
      if (!force && !retryFailed && sameContext && analysis.blockedFingerprint === fingerprint) {
        await this.patch(id, { warnings: unique([...warnings, ...(analysis.warnings || [])]).slice(0, 100), sourceCount }, valid);
        return;
      }
      if (!force && sameContext && [fullFingerprint, confirmationsFingerprint].includes(analysis.fingerprint)) {
        const keptWarnings = unique([...warnings, ...(analysis.warnings || [])]).slice(0, 100);
        const partial = Boolean(analysis.coveragePartial || partialWarnings(keptWarnings));
        await this.status(id, 'ready', partial ? '已整理可读取内容，部分资料未读取，请核对范围提示。' : '业务需求已整理，新的资料和业务补充会合并更新。', keptWarnings, sourceCount, valid, partial, analysis.omittedCount || 0);
        return;
      }
      let deltaFiles = usableFiles.filter(entry => force || !sameContext || previousSources[entry.id] !== entry.fingerprint);
      let deltaTurns = entries.filter(entry => force || !sameContext || previousTurns[entry.turn.id] !== entry.fingerprint);
      // A changed model/configuration with unchanged material deliberately gets
      // a fresh snapshot. Changes in generated requirements never trigger this.
      if (!deltaFiles.length && !deltaTurns.length) { deltaFiles = usableFiles; deltaTurns = entries; }
      const previous = priorContext(this.project(id).requirements);
      const previousQuestions = priorConfirmations(this.project(id).requirementConfirmations);
      if ((this.project(id).requirements || []).length > MAX_PREVIOUS_ITEMS) warnings.push(`已有需求超过 ${MAX_PREVIOUS_ITEMS} 条，本次仅携带最近 ${MAX_PREVIOUS_ITEMS} 条作合并参考，其他需求保留。`);
      if ((this.project(id).requirementConfirmations || []).length > MAX_PREVIOUS_ITEMS) warnings.push(`已有确认事项超过 ${MAX_PREVIOUS_ITEMS} 条，本次仅携带最近 ${MAX_PREVIOUS_ITEMS} 条作合并参考，其他事项保留。`);
      const sources = [], processedSources = { ...previousSources }, processedTurns = { ...previousTurns };
      let chars = 0, omitted = 0;
      const append = source => {
        if (sources.length >= MAX_INPUT_SOURCES || chars >= MAX_INPUT_CHARS) { omitted++; return null; }
        const available = Math.min(MAX_SOURCE_CHARS, MAX_INPUT_CHARS - chars);
        const complete = source.text.length <= available;
        if (!complete) { omitted++; warnings.push(`${source.title || '业务资料'}：本次整理正文已截断，请核对未读取部分。`); }
        const next = { ...source, text: source.text.slice(0, available) };
        sources.push(next); chars += next.text.length; return { complete };
      };
      // Fresh conversation/changed supplements should not be starved by a large
      // initial directory. Files retain their stable IDs across incremental runs.
      const confirmationDelta = deltaTurns.filter(entry => confirmationTurns.has(entry.turn.id)).slice(-MAX_BUSINESS_TURNS);
      const priorityIds = new Set(confirmationDelta.map(entry => entry.turn.id));
      const initialDelta = deltaTurns.filter(entry => initialSet.has(entry.turn.id) && !priorityIds.has(entry.turn.id));
      const selectedTurns = [...confirmationDelta, ...initialDelta.slice(0, MAX_BUSINESS_TURNS - confirmationDelta.length), ...deltaTurns.filter(entry => !initialSet.has(entry.turn.id) && !priorityIds.has(entry.turn.id)).slice(-Math.max(0, MAX_BUSINESS_TURNS - confirmationDelta.length - initialDelta.length))].slice(0, MAX_BUSINESS_TURNS);
      if (deltaTurns.length > selectedTurns.length) { omitted += deltaTurns.length - selectedTurns.length; warnings.push(`本次最多采用 ${MAX_BUSINESS_TURNS} 轮业务沟通，较早的部分未重新读取，已有需求保留。`); }
      const appendTurn = entry => {
        if (clean(entry.turn.userText, 30000).length > 11000 || clean(entry.turn.assistantText, 30000).length > 6000) warnings.push('部分业务沟通内容过长，本次仅采用摘要范围内的文字。');
        if (entry.source.attachments.length) warnings.push('会话媒体附件仅保留路径或描述，未识别媒体中的文字。');
        if (append(entry.source)?.complete) processedTurns[entry.turn.id] = entry.fingerprint;
      };
      for (const entry of selectedTurns) appendTurn(entry);
      for (const entry of deltaFiles) {
        let complete = !extractionPartial(entry.file);
        for (let offset = 0; offset < entry.text.length; offset += MAX_SOURCE_CHARS) {
          const part = Math.floor(offset / MAX_SOURCE_CHARS) + 1;
          const name = clean(entry.file.name, 160) || '业务资料';
          const source = { id: `file:${entry.id}:${part}`, type: entry.file.kind === '补充资料' ? 'supplement' : 'original', title: name,
            text: entry.text.slice(offset, offset + MAX_SOURCE_CHARS), sourceRef: clean(entry.file.originalPath || entry.file.path, 4000),
            attachments: attachments([{ type: entry.file.type === 'image' ? 'image' : 'file', path: entry.file.path, description: clean(entry.file.description, 240) || name }]) };
          const partFingerprint = hash({ source, config });
          if (!force && previousSources[source.id] === partFingerprint) continue;
          if (append(source)?.complete) processedSources[source.id] = partFingerprint;
          else complete = false;
        }
        if (complete) processedSources[entry.id] = entry.fingerprint;
        else delete processedSources[entry.id];
      }
      if (omitted) warnings.push(`业务材料超过单次整理范围，有 ${omitted} 个正文片段未读取；已有需求保留。`);
      const coveragePartial = Boolean(omitted || partialWarnings(warnings));
      warnings = unique(warnings).slice(-100);
      if (!sources.length) {
        await this.status(id, 'idle', '本次没有可整理的业务正文；已有需求保留。', warnings, sourceCount, valid); return;
      }
      await this.status(id, 'running', analysis.fingerprint ? '正在合并新增业务资料和需求补充…' : '正在梳理业务需求和待确认问题…', warnings, sourceCount, valid, coveragePartial, omitted);
      if (!valid()) return;
      const result = await this.summarizer.summarizeRequirements({ sources: [...sources, ...previous.sources, ...previousQuestions.sources], previousItems: previous.items, previousConfirmations: previousQuestions.items, confirmationsOnly, config, apiKey });
      if (!valid()) return;
      if (result?.method !== 'model' || !Array.isArray(result.items)) throw new Error('需求整理结果格式无效，已有需求保留');
      if (result.confirmations !== undefined && !Array.isArray(result.confirmations)) throw new Error('需求确认结果格式无效，已有确认事项保留');
      await this.commit(() => {
        if (!valid()) return;
        this.store.applyRequirementSummary(id, { items: result.items, confirmations: result.confirmations || [], method: 'model', fingerprint, contextKey,
          processedSources: Object.fromEntries(Object.entries(processedSources).slice(-8000)), processedTurns: Object.fromEntries(Object.entries(processedTurns).slice(-4000)), initialTurnIds, warnings, sourceCount,
          coveragePartial, omittedCount: omitted, threadId, updatedAt: new Date().toISOString() });
        this.notify({ type: 'requirementsUpdated', projectId: id });
      });
    } catch (error) {
      if (valid()) await this.patch(id, { ...(fingerprint ? { blockedFingerprint: fingerprint, contextKey } : {}), warnings: unique(warnings).slice(0, 100), sourceCount,
        status: { state: 'error', message: `${safeError(error, apiKey)}；已有需求保留，新的业务资料出现或手动整理时重试。`, updatedAt: new Date().toISOString() } }, valid);
    } finally {
      job.running = false;
      if (job.pending && !this.stopped) this.schedule(id, { force: job.force, retryFailed: job.retryFailed });
    }
  }
}

module.exports = { RequirementService };
