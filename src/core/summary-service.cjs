'use strict';
const { createHash } = require('node:crypto');
const issueKeys = item => [item.issueKey, ...(item.relatedIssueKeys || [])].filter(Boolean);
const contentFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Network requests stay outside the mutation queue; only validated results are committed.
class SummaryService {
  constructor({ store, reader, summarizer, getModel, getRules, commit = fn => Promise.resolve().then(fn), notify = () => {}, delay = 5000 }) {
    Object.assign(this, { store, reader, summarizer, getModel, getRules, commit, notify, delay });
    this.jobs = new Map();
    this.stopped = false;
    this.revision = 0;
  }
  schedule(id, { force = false, retryFailed = false, delay = this.delay } = {}) {
    if (this.stopped || !id) return;
    let job = this.jobs.get(id);
    if (!job) { job = { running: false, pending: false, force: false, retryFailed: false, timer: null }; this.jobs.set(id, job); }
    job.pending = true;
    job.force ||= force;
    job.retryFailed ||= retryFailed;
    clearTimeout(job.timer);
    if (!job.running) job.timer = setTimeout(() => this.run(id), delay);
  }
  invalidate() {
    this.revision++;
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.pending = false; job.force = false; job.retryFailed = false;
    }
  }
  project(id) { return this.store.getState().projects.find(p => p.id === id); }
  async status(id, state, message, threadId) {
    await this.commit(() => {
      if (this.stopped || !this.project(id)) return;
      if (threadId && this.project(id).codex?.threadId !== threadId) return;
      this.store.setSummaryStatus(id, { state, message, updatedAt: new Date().toISOString() });
      this.notify({ summaryUpdated: id });
    });
  }
  async run(id) {
    const job = this.jobs.get(id);
    if (!job || job.running || this.stopped) return;
    job.running = true;
    job.pending = false;
    const force = job.force; job.force = false;
    const retryFailed = job.retryFailed; job.retryFailed = false;
    const revision = this.revision;
    const project = this.project(id);
    const threadId = project?.codex?.threadId;
    let rules, rulesCaptured = false;
    const rulesUnchanged = () => {
      if (!rulesCaptured || !this.getRules) return true;
      try { return this.getRules() === rules; } catch { return false; }
    };
    const valid = () => !!project && !this.stopped && this.revision === revision && this.project(id)?.codex?.threadId === threadId && this.project(id)?.devDir === project.devDir && rulesUnchanged();
    try {
      if (!threadId) return;
      // One snapshot drives both the fingerprint and every chunk of this job.
      rules = this.getRules?.(); rulesCaptured = true;
      const { config, apiKey } = this.getModel();
      const effectiveConfig = { ...config, enabled: !!(config.enabled && (apiKey || this.summarizer.requiresApiKey(config) === false)) };
      const read = await this.reader.readThread({ threadId, cwd: project.devDir, history: true });
      if (!valid()) return;
      const grouped = this.summarizer.groupCompletedTurns(read.turns);
      const allDates = [...new Set([...(read.discoveredDates || []), ...grouped.keys()])].sort();
      const catalogTruncated = allDates.length > 4000;
      const dates = allDates.slice(-4000);
      const failures = new Map((this.project(id).codex.history?.failedDates || []).filter(item => dates.includes(item.date)).map(item => [item.date, item]));
      // Content-only identity: file touches, tool output, settings and unfinished
      // turns cannot release a failed request. Persist it so restart is quiet too.
      const eventFingerprint = contentFingerprint([...grouped].map(([date, turns]) => [date, this.summarizer.turnCheckpoints(turns)]));
      for (const [date, failure] of failures) if (!failure.eventFingerprint) failures.set(date, { ...failure, eventFingerprint });
      let blockedSourceFingerprint = this.project(id).codex.history?.blockedSourceFingerprint || '';
      const context = JSON.stringify({ threadId, cwd: project.devDir, config: effectiveConfig, rules });
      const sameRead = !!read.coverage?.sourceStamp && job.settledStamp === read.coverage.sourceStamp && job.settledContext === context;
      let truncated = catalogTruncated || (sameRead ? !!this.project(id).codex.history?.truncated : read.workTruncated ?? read.truncated ?? false);
      let scopedReads = 0, scopedTruncated = false;
      const publishHistory = async () => this.commit(() => {
        if (!valid()) return;
        this.store.setCodexHistory(id, { threadId, dates, completedDates: (this.project(id).codex.dailySummaries || []).map(item => item.date), failedDates: [...failures.values()], truncated, blockedSourceFingerprint });
        this.notify({ summaryUpdated: id });
      });
      await publishHistory();
      if (!force && !retryFailed && blockedSourceFingerprint === eventFingerprint) return;
      if (!force && !retryFailed && sameRead && !failures.size) {
        if (['running', 'error'].includes(this.project(id).codex.summaryStatus?.state)) {
          await this.status(id, 'ready', (effectiveConfig.enabled ? '已按日整理，新的成果会自动更新' : '已整理明确成果；配置模型后可提炼普通对话') + (truncated ? '。部分历史未读取，请核对遗漏内容' : ''), threadId);
        }
        return;
      }
      // A bounded full scan discovers every date. Only sessions exceeding the
      // in-memory turn limit need date-scoped rereads; ordinary history scans
      // (including large files containing tool/media payloads) are reused.
      let attempted = 0;
      for (const [index, date] of dates.entries()) {
        if (!valid()) return;
        if (!force && sameRead && !failures.has(date)) continue;
        const dayRead = read.workTruncated && this.reader.readThread ? await this.reader.readThread({ threadId, cwd: project.devDir, history: true, date }) : read;
        if (!valid()) return;
        if (dayRead !== read) { scopedReads++; scopedTruncated ||= !!(dayRead.workTruncated ?? dayRead.truncated); }
        const turns = dayRead === read ? grouped.get(date) || [] : this.summarizer.groupCompletedTurns(dayRead.turns).get(date) || [];
        if (!turns.length) continue;
        const day = { date, turns, fingerprint: this.summarizer.dayFingerprint(turns, effectiveConfig, rules) };
        const saved = this.project(id).codex.dailySummaries?.find(item => item.date === date);
        const checkpoints = this.summarizer.turnCheckpoints(turns);
        // Losing credentials never replaces richer model work with local extraction.
        if (!effectiveConfig.enabled && saved?.method === 'model') continue;
        if (!force && saved?.fingerprint === day.fingerprint) {
          // Upgrade a successful legacy summary locally; no historical text is
          // resent just to introduce the new incremental checkpoint format.
          if (!saved.processedTurns) await this.commit(() => { if (valid()) this.store.setDailySummaryCheckpoint(id, { date, threadId, processedTurns: checkpoints }); });
          failures.delete(date); continue;
        }
        const priorFailure = failures.get(date);
        if (!force && !retryFailed && priorFailure && (!priorFailure.eventFingerprint || priorFailure.eventFingerprint === eventFingerprint)) continue;
        const modelUpgrade = saved?.method === 'local' && effectiveConfig.enabled;
        const incremental = !force && !modelUpgrade && !!saved?.processedTurns;
        const delta = incremental ? turns.filter(turn => saved.processedTurns[turn.id] !== checkpoints[turn.id]) : turns;
        if (!delta.length) { failures.delete(date); continue; }
        attempted++;
        await this.status(id, 'running', `${incremental ? '正在整理新增成果' : '正在补齐'} ${day.date}（${index + 1}/${dates.length} 天）`, threadId);
        if (!valid()) return;
        const previousItems = (this.project(id).codex.dailySummaries || []).filter(summary => summary.date <= day.date).flatMap(summary => summary.items.map(item => ({ ...item, date: summary.date }))).slice(-60);
        try {
        const result = await this.summarizer.summarizeDay({ ...day, turns: delta, existingItems: incremental ? saved.items : [], previousItems, config: effectiveConfig, apiKey, rules });
        if (!valid()) return;
        await this.commit(() => {
          if (!valid()) return;
          let items = result.items;
          if (dayRead.workTruncated ?? dayRead.truncated) {
            const available = new Set(day.turns.map(turn => turn.id));
            const previous = this.project(id).codex.dailySummaries?.find(summary => summary.date === day.date)?.items || [];
            const hidden = previous.filter(item => item.turnIds?.some(turnId => !available.has(turnId)));
            const merged = new Map(items.map(item => [item.issueKey, item]));
            const byIdentity = new Map();
            for (const item of items) for (const key of issueKeys(item)) byIdentity.set(key, item);
            for (const old of hidden) {
              const next = issueKeys(old).map(key => byIdentity.get(key)).find(Boolean);
              const combined = next ? { ...next,
                cause: next.cause && next.cause !== '未明确' ? next.cause : old.cause,
                action: next.action && next.action !== '未明确' ? next.action : old.action,
                relatedIssueKeys: [...new Set([...issueKeys(old), ...issueKeys(next)])].filter(key => key !== next.issueKey),
                turnIds: [...new Set([...old.turnIds, ...next.turnIds])],
                attachments: [...new Map([...(old.attachments || []), ...(next.attachments || [])].map(a => [JSON.stringify(a), a])).values()].slice(0, 50),
                sourceRef: [...new Set([old.sourceRef, next.sourceRef].filter(Boolean))].join('\n').slice(0, 4000),
              } : old;
              merged.set(combined.issueKey, combined);
              for (const key of issueKeys(combined)) byIdentity.set(key, combined);
            }
            items = [...merged.values()];
          }
          this.store.applyDailySummary(id, { date: day.date, fingerprint: day.fingerprint, method: result.method, items, threadId,
            processedTurns: { ...(saved?.processedTurns || {}), ...checkpoints }, updatedAt: new Date().toISOString() });
          this.notify({ summaryUpdated: id });
        });
        failures.delete(date); blockedSourceFingerprint = '';
        } catch (error) {
          if (!valid()) return;
          const message = String(error.message || '整理失败，可手动重试').slice(0, 300);
          failures.set(date, { date, message, eventFingerprint });
          // Connection/authentication failures affect the service, not a day's
          // content. Stop until a new completed turn or an explicit user action.
          if (/无法连接|请求超时|密钥|认证|权限|模型服务|模型接口|过于频繁|余额不足|请求格式不被模型支持|模型参数不被支持|HTTP\s*(?:40[01234]|429|5\d\d)/i.test(message)) {
            blockedSourceFingerprint = eventFingerprint;
            await publishHistory(); break;
          }
        }
        await publishHistory();
      }
      if (read.workTruncated) truncated = catalogTruncated || (sameRead && !force ? truncated || scopedTruncated : !read.coverage?.scanComplete || scopedTruncated || scopedReads < dates.length);
      await publishHistory();
      job.settledStamp = read.coverage?.sourceStamp; job.settledContext = context;
      if (valid()) {
        if (failures.size) {
          const first = [...failures.values()][0];
          await this.status(id, 'error', `${first.date}：${first.message}；已有成果已保留。新成果出现或手动整理时重试。`, threadId);
        } else if (attempted || ['running', 'error'].includes(this.project(id).codex.summaryStatus?.state)) {
          blockedSourceFingerprint = '';
          await this.status(id, 'ready', (effectiveConfig.enabled ? '已按日整理，新的成果会自动更新' : '已整理明确成果；配置模型后可提炼普通对话') + (truncated ? '。部分历史未读取，请核对遗漏内容' : ''), threadId);
        }
      }
    } catch (error) {
      // Reader and adapter use safe errors. Never surface arbitrary remote response bodies.
      if (valid()) {
        await this.status(id, 'error', String(error.message || '整理失败，可手动重试').slice(0, 300), threadId);
      }
    } finally {
      job.running = false;
      if (job.pending && !this.stopped) this.schedule(id, { force: job.force, retryFailed: job.retryFailed });
    }
  }
  stop() {
    this.stopped = true;
    this.revision++;
    for (const job of this.jobs.values()) clearTimeout(job.timer);
  }
}
module.exports = { SummaryService };
