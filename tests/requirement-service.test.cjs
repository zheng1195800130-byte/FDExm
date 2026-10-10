'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RequirementService } = require('../src/core/requirement-service.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const root = path.resolve(__dirname, '../.test-tmp/requirement-service-fixture');
const sourceDir = path.join(root, 'source'), devDir = path.join(root, 'dev'), managedDir = path.join(root, 'data/projects/p');
const config = { enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
function file(id, text = '业务人员需要导入订单，并按客户和日期筛选统计。', patch = {}) {
  return { id, name: `${id}.md`, path: path.join(sourceDir, `${id}.md`), kind: '原始资料', type: 'text', textPreview: text,
    description: '', descriptionSource: 'automatic', missing: false, previewNote: '', ...patch };
}
function turn(id, userText = '用户希望按部门查看订单统计，需要提供导出功能。', patch = {}) {
  return { id, threadId: 'thread', date: '2026-10-09', timestamp: `2026-10-09T${String(Number(id.replace(/\D/g, '')) || 1).padStart(2, '0')}:00:00Z`,
    completed: true, userText, assistantText: '业务范围已梳理，导出权限仍需和客户确认。', sourceRef: `session#turn=${id}`, attachments: [], ...patch };
}
class FakeStore {
  constructor(project) { this.value = { id: 'p', name: '需求服务测试', sourceDir, devDir, files: [], requirements: [], requirementConfirmations: [], codex: { threadId: 'thread' }, requirementAnalysis: {}, ...project }; this.applies = []; this.patches = []; }
  getState() { return { projects: [copy(this.value)] }; }
  projectFolder() { return managedDir; }
  setRequirementAnalysis(id, patch) { assert.equal(id, 'p'); this.patches.push(copy(patch)); Object.assign(this.value.requirementAnalysis, copy(patch)); }
  applyRequirementSummary(id, payload) {
    assert.equal(id, 'p'); this.applies.push(copy(payload));
    for (const item of payload.items) {
      const existing = this.value.requirements.find(old => old.requirementKey === item.requirementKey);
      if (existing) Object.assign(existing, item); else this.value.requirements.push({ id: item.requirementKey, managedBy: 'requirements-auto', ...copy(item) });
    }
    for (const item of payload.confirmations || []) {
      const existing = this.value.requirementConfirmations.find(old => old.confirmationKey === item.confirmationKey);
      if (existing) Object.assign(existing, item); else this.value.requirementConfirmations.push({ id: item.confirmationKey, managedBy: 'requirements-auto', ...copy(item) });
    }
    const { items, confirmations, ...analysis } = payload;
    Object.assign(this.value.requirementAnalysis, analysis, { blockedFingerprint: '', status: { state: 'ready', message: '需求已整理' } });
  }
}
function fixture(t, options = {}) {
  const store = options.store || new FakeStore(options.project), turns = options.turns || [], calls = [], notifications = [];
  const model = options.model || { config, apiKey: 'test-only-secret' };
  const adapter = options.adapter || (async ({ sources, previousItems }) => ({ method: 'model', items: previousItems.length ? previousItems : [{
    requirementKey: 'orders', title: '订单统计与导出', description: '导入订单后按部门统计并导出。', questions: ['哪些角色可以导出？'], status: '待确认', sourceIds: [sources[0].id], relatedRequirementKeys: [], sourceRef: sources[0].sourceRef, attachments: sources[0].attachments,
  }] }));
  const service = new RequirementService({ store, reader: options.reader || { readThread: async () => ({ turns }) },
    summarizer: { summarizeRequirements: async input => { calls.push(copy(input)); return adapter(input); } },
    getModel: options.getModel || (() => model), notify: event => notifications.push(event), delay: 5 });
  t.after(() => service.stop());
  return { store, turns, calls, service, model, notifications };
}
async function run(service, options = {}) {
  service.schedule('p', { ...options, delay: 10000 });
  clearTimeout(service.jobs.get('p').timer);
  await service.run('p');
}
const warnings = store => store.value.requirementAnalysis.warnings.join('\n');

test('只聚合原始与补充正文，排除成果、代码、备忘录、越界和缺失文件', async t => {
  const { store, service, calls } = fixture(t, { project: { files: [file('business'),
    file('supplement', '客户补充：导出结果需要合计金额。', { kind: '补充资料', path: path.join(managedDir, 'supplements/2026-10-09/supplement.md') }),
    file('readme', '开发技术记录', { kind: '开发成果', path: path.join(devDir, 'README.md') }),
    file('memo', '私人备忘录内容', { path: path.join(managedDir, '备忘录/memo.md') }),
    file('code', 'const unrelated = true;', { name: 'code.js', path: path.join(sourceDir, 'code.js') }),
    file('missing', '已丢失资料正文', { missing: true }), file('outside', '其他项目正文', { path: path.join(root, 'other/project.md') }),
  ] } });
  await run(service);
  assert.equal(calls.length, 1); assert.equal(calls[0].sources.length, 2);
  assert.deepEqual(calls[0].sources.map(source => source.type).sort(), ['original', 'supplement']);
  assert.doesNotMatch(JSON.stringify(calls), /私人备忘录|开发技术记录|unrelated|已丢失资料|其他项目/);
  assert.equal(store.applies[0].sourceCount, 2);
});

test('只有资料无需绑定会话，线程空串交给Store，父级devDir不误排原始资料', async t => {
  const nestedSource = path.join(root, 'source');
  const { service, calls, store } = fixture(t, { project: { devDir: root, sourceDir: nestedSource, codex: { threadId: '' }, files: [file('business')] },
    reader: { readThread: async () => { assert.fail('未绑定项目不读取会话'); } } });
  await run(service); assert.equal(calls.length, 1); assert.equal(store.applies[0].threadId, '');
});

test('首次业务对话与新增业务增量整理，未结束和纯开发修复轮不触发', async t => {
  const turns = [turn('1', '这个目录是用户提供的业务资料，帮我梳理业务需求和待确认的问题。')];
  const { service, calls, store } = fixture(t, { turns, project: { files: [file('business')] } });
  await run(service); assert.equal(calls.length, 1);
  assert.match(calls[0].sources.find(source => source.type === 'business-turn').text, /不代表客户已确认/);
  turns.push(turn('2', '用户反馈导入报错，请修复，完成后运行测试。'));
  turns.push(turn('3', '客户希望新增按月份统计的业务需求。', { completed: false }));
  await run(service); assert.equal(calls.length, 1);
  turns[2].completed = true; await run(service); assert.equal(calls.length, 2);
  assert.equal(calls[1].sources.length, 1); assert.equal(calls[1].sources[0].type, 'business-turn');
  assert.match(calls[1].sources[0].text, /按月份统计/);
  assert.ok(calls[1].previousItems.length); assert.equal(store.value.requirements.length, 1);
});

test('相同材料、mtime变化和整理输出不会重复调用，检查点在服务重启后仍有效', async t => {
  const { service, calls, store } = fixture(t, { project: { files: [file('business')] } });
  await run(service); const fingerprint = store.value.requirementAnalysis.fingerprint;
  store.value.files[0].mtime = 'new touch'; store.value.requirements[0].description = '人工调整现有需求的描述';
  await run(service); assert.equal(calls.length, 1); assert.equal(store.value.requirementAnalysis.fingerprint, fingerprint);
  const restarted = fixture(t, { store }); await run(restarted.service); assert.equal(restarted.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(store.value.requirementAnalysis), /业务人员需要导入|人工调整现有需求|test-only-secret/);
});

test('仅发送新增或改变正文，人工需求作为显式短上下文参与去重且不自激活', async t => {
  const { service, calls, store } = fixture(t, { project: { files: [file('one'), file('two')], requirements: [{ id: 'manual', title: '人工范围', description: '客户只需要销售订单统计。', status: '已明确' }] } });
  await run(service); assert.ok(calls[0].sources.some(source => source.type === 'existing-requirement'));
  assert.ok(calls[0].previousItems[0].sourceIds[0].startsWith('req:'));
  store.value.files[1].textPreview = '客户补充：导出的合计金额按含税价格计算。';
  await run(service); assert.equal(calls.length, 2);
  const real = calls[1].sources.filter(source => source.type !== 'existing-requirement');
  assert.equal(real.length, 1); assert.match(real[0].text, /含税价格/);
  await run(service); assert.equal(calls.length, 2);
});

test('图片未OCR、解析失败与提取截断明确提示，不凭自动介绍推断需求', async t => {
  const { service, calls, store } = fixture(t, { project: { files: [
    file('image', '', { name: '订单截图.png', type: 'image', description: '自动摘录：订单统计', previewNote: '图片已索引；未自动识别图片文字' }),
    file('broken', '', { name: '需求.pdf', parseError: 'PDF解析失败' }),
  ] } });
  await run(service); assert.equal(calls.length, 0); assert.equal(store.value.requirementAnalysis.status.state, 'idle');
  assert.match(warnings(store), /未识别|未.*识别/); assert.match(warnings(store), /提取失败/);
  store.value.files[0].description = '客户说明：截图展示的是订单按部门汇总的业务范围。';
  store.value.files[0].descriptionSource = 'user';
  await run(service); assert.equal(calls.length, 1); assert.match(calls[0].sources[0].text, /用户补充说明/);
});

test('长资料分段，数量和文字总量受限且范围缺口显式提示', async t => {
  const manyFiles = Array.from({ length: 25 }, (_, index) => file(`doc${String(index).padStart(2, '0')}`, '业务需求文字。'.repeat(12000), { previewNote: '正文过长，已截断为前80000字。' }));
  const manyTurns = Array.from({ length: 65 }, (_, index) => turn(String(index + 1), '客户补充：需要增加按地区统计的业务需求。'));
  const { service, calls, store } = fixture(t, { project: { files: manyFiles }, turns: manyTurns });
  await run(service); assert.equal(calls.length, 1);
  assert.ok(calls[0].sources.length <= 188); assert.ok(calls[0].sources.every(source => source.text.length <= 20000));
  assert.ok(calls[0].sources.reduce((total, source) => total + source.text.length, 0) <= 160000);
  assert.match(warnings(store), /片段未读取/); assert.match(warnings(store), /截断/); assert.match(warnings(store), /最多采用 6 轮/); assert.match(warnings(store), /最多采用 60 轮/);
  await run(service); assert.equal(calls.length, 1, '范围受限不会自行循环付费');
});

test('大目录优先业务需求和规则文档；部分文件只记完整片段，状态持续说明未读范围', async t => {
  const files = Array.from({ length: 35 }, (_, index) => file(`bill${String(index).padStart(2, '0')}`, '这是账单样例数据。'.repeat(10000), { name: `样例账单${index}.xlsx`, previewNote: '正文过长，已截断为前80000字。' }));
  files.push(file('zz-important', '客户业务需求：账单按结算客户匹配运输单，异常记录应进入人工核对清单。', { name: '业务需求说明.docx' }));
  files.push(file('zz-rules', '业务规则：同一运输单可以关联多张账单，不能按单据编号去重后丢失费用。', { name: '结算业务规则.md' }));
  const { service, calls, store } = fixture(t, { project: { files } });
  await run(service); assert.equal(calls.length, 1);
  assert.ok(calls[0].sources.slice(0, 2).every(source => /业务需求|业务规则/.test(source.title)));
  assert.match(JSON.stringify(calls[0].sources), /不能按单据编号去重/);
  const analysis = store.value.requirementAnalysis;
  assert.equal(analysis.coveragePartial, true); assert.ok(analysis.omittedCount > 0);
  assert.ok(analysis.processedSources['zz-important']); assert.ok(analysis.processedSources['zz-rules']);
  assert.ok(!own(analysis.processedSources, 'bill00'), '被提取阶段截断的文件不记整份完成');
  assert.ok(Object.keys(analysis.processedSources).some(key => key.startsWith('file:bill00:')));
  assert.ok(!own(analysis.processedSources, 'bill34'), '未发送的文件不记完成');
  await run(service); assert.equal(calls.length, 1); assert.equal(store.value.requirementAnalysis.coveragePartial, true);
  assert.match(store.value.requirementAnalysis.status.message, /部分资料未读取/);
});

test('会话较长时按最早日期补回初始业务背景，不以最近开发修复冒充初始需求', async t => {
  const reads = [];
  const initial = turn('initial', '用户初次业务需求：把线下采购单据整理成可审核的清单。', { date: '2026-09-01', timestamp: '2026-09-01T01:00:00Z' });
  const { service, calls, store } = fixture(t, { reader: { readThread: async input => {
    reads.push(input);
    return input.date ? { turns: [initial], workTruncated: false } : { turns: [turn('latest', '构建失败，请修复打包报错。')], workTruncated: true, discoveredDates: ['2026-09-01', '2026-10-09'] };
  } } });
  await run(service); assert.equal(calls.length, 1); assert.ok(reads.some(read => read.date === '2026-09-01'));
  assert.match(calls[0].sources[0].text, /采购单据/); assert.doesNotMatch(JSON.stringify(calls), /构建失败/);
  assert.match(warnings(store), /历史读取受限/);
});

test('模型失败保留已有需求并持久阻断同输入；重启和纯修复不重试，业务补充释放', async t => {
  const turns = [turn('1')]; let failing = false;
  const { service, calls, store } = fixture(t, { turns, adapter: async ({ sources, previousItems }) => {
    if (failing) throw new Error('无法连接模型服务');
    return { method: 'model', items: previousItems.length ? previousItems : [{ requirementKey: 'orders', title: '订单业务', description: '按部门统计订单。', questions: [], status: '已明确', sourceIds: [sources[0].id] }] };
  } });
  await run(service); failing = true; turns.push(turn('2', '客户补充：需要增加订单金额导出的功能。'));
  await run(service); assert.equal(calls.length, 2); assert.equal(store.value.requirements.length, 1);
  const restarted = fixture(t, { store, turns, adapter: async () => { throw new Error('仍然失败'); } });
  await run(restarted.service); assert.equal(restarted.calls.length, 0);
  turns.push(turn('3', '测试失败，继续修复这个报错。')); await run(restarted.service); assert.equal(restarted.calls.length, 0);
  turns.push(turn('4', '客户补充：需要增加按地区统计的业务功能。')); await run(restarted.service); assert.equal(restarted.calls.length, 1);
  await run(restarted.service, { retryFailed: true }); assert.equal(restarted.calls.length, 2);
  assert.equal(store.value.requirements.length, 1); assert.equal(store.value.requirementAnalysis.status.state, 'error');
});

test('关闭模型或远程缺密钥仅提示配置，原需求与检查点保留；本地匿名模型可调用', async t => {
  const { service, calls, store, model } = fixture(t, { project: { files: [file('business')] } });
  await run(service); const fingerprint = store.value.requirementAnalysis.fingerprint;
  model.config = { ...config, enabled: false }; await run(service, { force: true });
  assert.equal(calls.length, 1); assert.equal(store.value.requirementAnalysis.status.state, 'unconfigured');
  model.config = { ...config }; model.apiKey = ''; await run(service);
  assert.equal(calls.length, 1); assert.equal(store.value.requirementAnalysis.fingerprint, fingerprint); assert.equal(store.value.requirements.length, 1);
  model.config = { ...config, provider: 'compatible', baseUrl: 'http://localhost:11434/v1', model: 'local' };
  await run(service); assert.equal(calls.length, 2); assert.equal(calls[1].apiKey, '');
});

test('网络返回前资料、绑定或模型配置变化不会回写过期结果', async t => {
  for (const change of ['files', 'thread', 'config']) await t.test(change, async sub => {
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    const { service, store, model } = fixture(sub, { project: { files: [file('business')] }, adapter: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
    const pending = run(service); await entered;
    if (change === 'files') store.value.files[0].textPreview = '客户改变范围：只需采购审批功能。';
    else if (change === 'thread') store.value.codex.threadId = 'other-thread';
    else model.config = { ...config, model: 'other-model' };
    release({ method: 'model', items: [] }); await pending; assert.equal(store.applies.length, 0);
  });
});

test('事件防抖合并，不启动心跳；stop后拒绝排队和在途写回', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const { service, calls, store } = fixture(t, { project: { files: [file('business')] }, adapter: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  service.schedule('p'); service.schedule('p'); service.schedule('p'); await entered;
  assert.equal(calls.length, 1); service.stop(); release({ method: 'model', items: [] });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(store.applies.length, 0);
  service.schedule('p', { force: true }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls.length, 1);
});

test('读取对话失败可仅整理资料，并明确业务背景缺口', async t => {
  const { service, calls, store } = fixture(t, { project: { files: [file('business')] }, reader: { readThread: async () => { throw new Error('会话暂不可用'); } } });
  await run(service); assert.equal(calls.length, 1); assert.match(warnings(store), /对话暂时无法读取/);
});

test('模型错误不把当前密钥写进状态或检查点', async t => {
  const { service, store } = fixture(t, { project: { files: [file('business')] }, adapter: async () => { throw new Error('Bearer test-only-secret unavailable'); } });
  await run(service); assert.doesNotMatch(JSON.stringify(store.value), /test-only-secret/);
  assert.equal(store.value.requirementAnalysis.status.state, 'error'); assert.ok(store.value.requirementAnalysis.blockedFingerprint);
});

test('开发中双方ERP提单缺口带前1后2轮和短答复优先发送，临时导入不冒充解决', async t => {
  const turns = Array.from({ length: 15 }, (_, i) => turn(String(i + 1), '修复编译报错。', { assistantText: '已修复构建。' }));
  turns[9] = turn('10', '继续', { assistantText: '提单信息应从 ERP 获取，但现在字段尚不明确，是否先支持 Excel 表格导入？' });
  turns[10] = turn('11', '先表格导入提单，ERP获取方式后续补充。', { assistantText: '先使用表格导入，ERP 来源仍待确认。' });
  turns[11] = turn('12', '好', { assistantText: '已保留临时方案。' });
  turns[12] = turn('13', '生成', { assistantText: '表格导入已经实现，原 ERP 信息缺口仍保留。' });
  const files = Array.from({ length: 20 }, (_, i) => file(`large${i}`, '账单样例数据'.repeat(12000)));
  const f = fixture(t, { turns, project: { files }, adapter: async ({ sources }) => ({ method: 'model', items: [], confirmations: [{ confirmationKey: 'bill_source', scenario: '提单数据无法从 ERP 获取', question: '提单信息最终怎样从 ERP 获取？', workaround: '暂时使用 Excel 表格导入', status: '待确认', resolution: '', sourceIds: sources.filter(s => s.type === 'business-turn').map(s => s.id) }] }) });
  await run(f.service);
  const input = f.calls[0], texts = input.sources.map(s => s.text).join('\n');
  assert.match(texts, /先表格导入提单/); assert.match(texts, /用户提出：\n好/); assert.match(texts, /用户提出：\n生成/);
  assert.ok(input.sources.findIndex(s => s.type !== 'business-turn') >= 5, '确认上下文先于大文件');
  assert.ok(input.sources.filter(s => s.type === 'business-turn').every(s => /^2026-10-09T/.test(s.timestamp)));
  assert.equal(f.store.applies[0].confirmations[0].status, '待确认');
  await run(f.service); assert.equal(f.calls.length, 1, '没有新增信息不会心跳重试');
});

test('已有确认事项作为短上下文参与后续明确答复，保留真实来源时间，无时间不伪造', async t => {
  const previous = { confirmationKey: 'bill_source', scenario: '提单 ERP 数据来源不明', question: '提单从哪个 ERP 字段获取？', workaround: '暂用 Excel', status: '待确认', resolution: '', sourceIds: ['turn:old'], sourceFirstAt: '2026-10-01T02:15:00Z', sourceLastAt: '2026-10-01T02:15:00Z' };
  const turns = [turn('1', '客户确认：提单 ERP 来源为运输单主表的提单号字段。', { timestamp: '2026-10-09T04:35:00Z', assistantText: '按客户确认的来源对接。' }), turn('2', '好', { timestamp: '', assistantText: '收到。' })];
  const f = fixture(t, { turns, project: { requirementConfirmations: [previous] }, adapter: async ({ previousConfirmations, sources }) => ({ method: 'model', items: [], confirmations: [{ ...previousConfirmations[0], status: '已解决', resolution: '客户明确采用运输单主表提单号字段', sourceIds: [sources[0].id], sourceLastAt: sources[0].timestamp }] }) });
  await run(f.service);
  assert.equal(f.calls[0].previousConfirmations[0].confirmationKey, 'bill_source');
  assert.equal(f.calls[0].previousConfirmations[0].sourceFirstAt, '2026-10-01T02:15:00.000Z');
  const unknown = f.calls[0].sources.find(s => s.text.includes('用户提出：\n好'));
  assert.ok(unknown); assert.ok(!own(unknown, 'timestamp'), '未知对话时间不以整理时间补造');
  assert.equal(f.store.applies[0].confirmations[0].status, '已解决');
});

test('旧版本检查点升级只补确认与来源时间，不重排旧需求，随后及重启不重复调用', async t => {
  const turns = [turn('1', '用户业务需求：订单按部门统计。')];
  const f = fixture(t, { turns }); await run(f.service);
  const state = f.store.value.requirementAnalysis;
  state.contextKey = '旧版仅目录与会话context'; state.fingerprint = 'version1fingerprint';
  const migrated = fixture(t, { store: f.store, turns }); await run(migrated.service);
  assert.equal(migrated.calls.length, 1); assert.equal(migrated.calls[0].sources[0].timestamp, '2026-10-09T01:00:00.000Z');
  assert.equal(migrated.calls[0].confirmationsOnly, true);assert.equal(f.calls[0].confirmationsOnly, false);
  await run(migrated.service); assert.equal(migrated.calls.length, 1);
  const restarted = fixture(t, { store: f.store, turns }); await run(restarted.service); assert.equal(restarted.calls.length, 0);
  turns.push(turn('2','客户补充：新增按月份统计的业务功能。'));await run(migrated.service);
  assert.equal(migrated.calls.length,2);assert.equal(migrated.calls[1].confirmationsOnly,false,'正常新增业务继续整理业务需求');
});

test('确认历史迁移失败保持同模式锁定，重启和无变化事件不重复请求',async t=>{
  const old={id:'old',requirementKey:'orders',title:'既有订单业务',description:'原业务范围保持不变',questions:[],status:'已明确',sourceIds:['turn:old']};
  const turns=[turn('1','提单字段获取不到，先用Excel导入，ERP以后再补。')];
  const f=fixture(t,{turns,project:{requirements:[old]},adapter:async input=>{assert.equal(input.confirmationsOnly,true);throw new Error('模型返回未通过确认来源校验');}});
  await run(f.service);assert.equal(f.calls.length,1);assert.deepEqual(f.store.value.requirements,[old]);
  await run(f.service);assert.equal(f.calls.length,1);
  const restarted=fixture(t,{store:f.store,turns,adapter:async()=>{assert.fail('失败的同份迁移不自动重试');}});
  await run(restarted.service);assert.equal(restarted.calls.length,0);
  await run(f.service,{retryFailed:true});assert.equal(f.calls.length,2);assert.equal(f.calls[1].confirmationsOnly,true);
});

test('人工确认事项作现有来源上下文但修改文字不单独触发AI，失败仍保留确认历史', async t => {
  const manual = { id: 'manual-confirm', confirmationKey: 'manual_bill', scenario: '提单来源待确认', question: '哪个渠道提供提单？', workaround: '先表格导入', status: '待确认', resolution: '', manual: true };
  let fail = false;
  const f = fixture(t, { project: { files: [file('business')], requirementConfirmations: [manual] }, adapter: async () => { if (fail) throw new Error('模型不可用'); return { method: 'model', items: [], confirmations: [] }; } });
  await run(f.service); assert.equal(f.calls[0].previousConfirmations[0].sourceIds.length, 1);
  assert.ok(f.calls[0].sources.some(s => s.type === 'existing-confirmation'));
  f.store.value.requirementConfirmations[0].workaround = '人工修改临时方案'; await run(f.service); assert.equal(f.calls.length, 1);
  fail = true; f.store.value.files[0].textPreview += '客户补充新的业务范围。'; await run(f.service);
  assert.equal(f.store.value.requirementConfirmations[0].workaround, '人工修改临时方案');
  await run(f.service); assert.equal(f.calls.length, 2); assert.equal(f.store.value.requirementAnalysis.status.state, 'error');
});
