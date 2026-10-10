'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { Store } = require('../src/core/store.cjs');
const { shouldIndexFile, canonical } = require('../src/core/files.cjs');

function fixture(t) {
  // Keep fixtures in the authorized workspace; Windows sandbox temp redirection
  // can deny native realpath even though the redirected file is writable.
  const tempBase = path.resolve(__dirname, '..', '.test-tmp');
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'fde-core-'));
  const sourceDir = path.join(root, 'source');
  const devDir = path.join(root, 'development');
  const dataDir = path.join(root, 'management');
  fs.mkdirSync(sourceDir); fs.mkdirSync(devDir);
  t.after(() => {
    assert.ok(root.startsWith(tempBase + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new Store(dataDir);
  const project = store.createProject({ name: '客户项目', customer: '测试客户', sourceDir, devDir });
  return { root, sourceDir, devDir, dataDir, store, project };
}

test('仅资料收录不扫描开发仓库，刷新和重启不恢复代码索引，会话与工作记录保留', async t => {
  const {store,project,sourceDir,devDir,dataDir}=fixture(t);
  fs.writeFileSync(path.join(sourceDir,'客户要求.md'),'客户的业务要求');
  fs.writeFileSync(path.join(devDir,'README.md'),'代码仓库说明');
  let p=await store.scanProject(project.id);
  assert.ok(p.files.some(f=>f.kind==='开发成果'));
  store.updateProject(project.id,{codex:{threadId:'preserved-thread'}});
  store.upsertRecord(project.id,{title:'客户工作',date:'2026-10-10',action:'梳理要求',status:'已完成'});
  p=store.updateProject(project.id,{indexArtifacts:false});
  assert.equal(p.files.some(f=>f.kind==='开发成果'),false);
  p=await store.scanProject(project.id,{force:true});
  assert.equal(p.files.length,1);assert.equal(p.files[0].name,'客户要求.md');
  assert.equal(p.codex.threadId,'preserved-thread');assert.equal(p.records.length,1);
  const reopened=new Store(dataDir);p=await reopened.scanProject(project.id);
  assert.equal(p.indexArtifacts,false);assert.equal(p.files.length,1);
  assert.ok(fs.existsSync(path.join(devDir,'README.md')));
  assert.throws(()=>reopened.updateProject(project.id,{indexArtifacts:'false'}),/布尔值/);
});

test('关联资料只读，扫描跳过开发依赖，用户介绍和缺失信息保留', async t => {
  const { sourceDir, devDir, store, project } = fixture(t);
  const original = path.join(sourceDir, '需求.md');
  fs.writeFileSync(original, '客户要求按月份导出报表。');
  const before = fs.statSync(original);
  fs.mkdirSync(path.join(devDir, 'node_modules'));
  fs.writeFileSync(path.join(devDir, 'node_modules', 'ignored.md'), '不索引');
  fs.writeFileSync(path.join(devDir, '方案.md'), '方案内容');
  fs.writeFileSync(path.join(devDir, 'index.js'), '开发代码不当作业务资料');
  let result = await store.scanProject(project.id);
  assert.equal(result.files.length, 2);
  const raw = result.files.find(file => file.kind === '原始资料');
  assert.match(raw.textPreview, /按月份/);
  store.updateFile(project.id, raw.id, { description: '业务流程和导出需求', path: '不允许覆盖', id: '不允许覆盖' });
  result = await store.scanProject(project.id);
  assert.equal(result.files.find(file => file.id === raw.id).description, '业务流程和导出需求');
  assert.equal(fs.readFileSync(original, 'utf8'), '客户要求按月份导出报表。');
  assert.equal(fs.statSync(original).mtimeMs, before.mtimeMs);
  fs.unlinkSync(original);
  result = await store.scanProject(project.id);
  assert.equal(result.files.find(file => file.id === raw.id).missing, true);
});

test('补充资料复制到管理区，重名不覆盖，并发导入与扫描串行', async t => {
  const { sourceDir, dataDir, store, project } = fixture(t);
  const original = path.join(sourceDir, '反馈.txt');
  fs.writeFileSync(original, '新增字段');
  await Promise.all([store.addFiles(project.id, [original]), store.scanProject(project.id), store.addFiles(project.id, [original])]);
  const files = store.getState().projects[0].files.filter(file => file.kind === '补充资料');
  assert.equal(files.length, 2);
  assert.notEqual(files[0].path, files[1].path);
  assert.ok(files.every(file => file.path.startsWith(dataDir)));
  assert.match(files[0].path, /supplements[\\/]\d{4}-\d{2}-\d{2}/);
  assert.equal(fs.readFileSync(original, 'utf8'), '新增字段');
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), '新增字段');
});

test('按日保留进展，日报仅汇总已确认记录并合并同一事项多轮', t => {
  const { store, project } = fixture(t);
  let p = store.upsertRecord(project.id, { issueKey: 'BUG-1', title: '表格导入失败', date: '2026-10-08', cause: '字段识别异常', action: '复现客户问题', result: '已定位，尚未修复', status: '未解决' });
  const first = p.records[0];
  p = store.upsertRecord(project.id, { id: first.id, date: '2026-10-09', action: '调整字段识别', result: '样例通过，待客户验证', status: '待验证' });
  assert.equal(p.records.length, 2);
  assert.equal(p.records.find(record => record.date === '2026-10-08').result, '已定位，尚未修复');
  store.upsertRecord(project.id, { issueKey: 'BUG-1', title: '表格导入失败', date: '2026-10-09', action: '补充异常提示', result: '样例通过，待客户验证', status: '待验证' });
  store.upsertRecord(project.id, { title: '未确认的自动记录', date: '2026-10-09', result: '所有问题已完成', status: '已完成', confirmed: false });
  const report = store.generateReport(project.id, '2026-10-09');
  assert.equal(report.recordIds.length, 1);
  assert.equal((report.text.match(/\*\*表格导入失败\*\*/g) || []).length, 1);
  assert.match(report.text, /调整字段识别/);
  assert.match(report.text, /补充异常提示/);
  assert.doesNotMatch(report.text, /所有问题已完成|未确认的自动记录/);
  assert.doesNotMatch(store.generateReport(project.id, '2026-10-08').text, /补充异常提示|样例通过/);
});

test('JSON、独立 Markdown 日报落地且重启后保留编辑', t => {
  const { dataDir, store, project } = fixture(t);
  store.upsertRequirement(project.id, { title: '导出报表', description: '按月导出', status: '已明确', sourceRef: '需求.md' });
  store.upsertRecord(project.id, { title: '需求梳理', date: '2026-10-08', action: '明确导出范围', result: '已确认', status: '已完成' });
  const generated = store.generateReport(project.id, '2026-10-08');
  store.saveReport(project.id, generated.date, generated.text + '\n人工补充。');
  const restarted = new Store(dataDir);
  assert.equal(restarted.getState().projects[0].requirements[0].title, '导出报表');
  assert.match(restarted.getState().projects[0].reports[0].text, /人工补充/);
  const base = store.projectFolder(project.id);
  assert.ok(fs.existsSync(path.join(base, '项目档案.md')));
  assert.ok(fs.existsSync(path.join(base, '需求清单.md')));
  assert.match(fs.readFileSync(path.join(base, '日报', '2026-10-08.md'), 'utf8'), /人工补充/);
  assert.ok(fs.existsSync(path.join(base, '工作记录', '2026-10-08.md')));
});

test('损坏主档案从备份恢复，不静默清空项目', t => {
  const { dataDir, store, project } = fixture(t);
  store.updateProject(project.id, { nextAction: '继续开发' });
  store.updateProject(project.id, { nextAction: '继续测试' });
  fs.writeFileSync(path.join(dataDir, 'store.json'), '{broken');
  const recovered = new Store(dataDir);
  assert.equal(recovered.getState().projects.length, 1);
  assert.equal(recovered.getState().projects[0].nextAction, '继续开发');
  assert.match(recovered.getState().recoveryWarning, /备份恢复/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).projects.length, 1);
});

test('日期、项目编号、资料路径限制有效，补丁不能覆写内部集合', async t => {
  const { root, store, project } = fixture(t);
  assert.throws(() => store.projectFolder('../outside'), /编号无效/);
  assert.throws(() => store.saveReport(project.id, '../../outside', 'test'), /日期格式/);
  assert.throws(() => store.saveReport(project.id, '2026-02-30', 'test'), /日期无效/);
  const p = store.updateProject(project.id, { id: 'changed', files: [{ path: 'outside' }], requirements: [] });
  assert.equal(p.id, project.id);
  assert.deepEqual(p.files, []);
  const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, '外部文件');
  store.state.projects[0].files.push({ id: 'injected', path: outside });
  await assert.rejects(() => store.previewFile(project.id, 'injected'), /超出关联项目范围/);
});

test('OpenXML 文档提取文本，解析失败明确可见', async t => {
  const { sourceDir, store, project } = fixture(t);
  const docx = new AdmZip();
  docx.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>业务要求按客户汇总</w:t></w:r></w:p></w:body></w:document>'));
  docx.writeZip(path.join(sourceDir, '需求.docx'));
  const xlsx = new AdmZip();
  xlsx.addFile('xl/sharedStrings.xml', Buffer.from('<sst><si><t>客户名称</t></si><si><t>订单金额</t></si></sst>'));
  xlsx.addFile('xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1"><v>128</v></c><c r="E1" t="inlineStr"><is><t>说明</t></is></c></row></sheetData></worksheet>'));
  xlsx.writeZip(path.join(sourceDir, '样例.xlsx'));
  fs.writeFileSync(path.join(sourceDir, '损坏.docx'), 'invalid zip');
  fs.writeFileSync(path.join(sourceDir, '截图.png'), 'placeholder');
  const p = await store.scanProject(project.id);
  assert.match(p.files.find(file => file.name === '需求.docx').textPreview, /按客户汇总/);
  assert.match(p.files.find(file => file.name === '样例.xlsx').textPreview, /客户名称/);
  assert.match(p.files.find(file => file.name === '样例.xlsx').textPreview, /客户名称\t\t订单金额\t128\t说明/);
  assert.match(p.files.find(file => file.name === '需求.docx').description, /自动摘录：业务要求/);
  assert.match(p.files.find(file => file.name === '损坏.docx').parseError, /解析失败/);
  const picture = p.files.find(file => file.name === '截图.png');
  const preview = await store.previewFile(project.id, picture.id);
  assert.equal(preview.type, 'image');
  assert.equal(preview.imagePath, picture.path);
});

test('会话草稿来源对象去重，待确认草稿不会覆盖人工记录', t => {
  const { store, project } = fixture(t);
  store.upsertRecord(project.id, { issueKey: 'BUG-1', title: '导入失败', date: '2026-10-08', action: '人工确认后修复', result: '样例通过', status: '待验证', confirmed: true });
  const draft = { id: 'record-imported', origin: { threadId: 'thread-1', turnId: 'turn-1' }, issueKey: 'BUG-1', title: '导入失败', date: '2026-10-08', action: 'Codex 提议重写', result: '声称完成', status: '待确认' };
  let p = store.upsertRecord(project.id, draft);
  assert.equal(p.records.length, 2);
  assert.equal(p.records[1].confirmed, false);
  assert.equal(p.records[0].action, '人工确认后修复');
  p = store.upsertRecord(project.id, draft);
  assert.equal(p.records.length, 2);
  assert.deepEqual(p.records[1].origin, draft.origin);
  assert.doesNotMatch(store.generateReport(project.id, '2026-10-08').text, /Codex 提议重写|声称完成/);
  const requirement = { id: 'req-imported', title: '按月导出', status: '待确认', origin: { threadId: 'thread-1', turnId: 'turn-1' } };
  store.upsertRequirement(project.id, requirement);
  p = store.upsertRequirement(project.id, requirement);
  assert.equal(p.requirements.length, 1);
  store.upsertRequirement(project.id, { ...requirement, id: 'req-second', title: '支持批量上传' });
  assert.equal(store.getState().projects[0].requirements.length, 2);
});

test('跨天继续不会自动沿用昨天的工作或已完成状态', t => {
  const { store, project } = fixture(t);
  const p = store.upsertRecord(project.id, { title: '导入问题', issueKey: 'B1', date: '2026-10-08', action: '修复代码', result: '测试通过', status: '已完成' });
  const next = store.upsertRecord(project.id, { id: p.records[0].id, date: '2026-10-09' });
  assert.equal(next.records[1].action, '');
  assert.equal(next.records[1].result, '');
  assert.equal(next.records[1].status, '进行中');
});

test('关联目录必须存在、不可相同，扫描缺失目录保留索引并提示', async t => {
  const { sourceDir, devDir, store, project } = fixture(t);
  assert.throws(() => store.createProject({ name: '错误', sourceDir: path.join(sourceDir, '不存在'), devDir }), /不存在/);
  assert.throws(() => store.createProject({ name: '错误', sourceDir, devDir: sourceDir }), /不能相同/);
  fs.writeFileSync(path.join(sourceDir, '需求.txt'), '原始需求');
  await store.scanProject(project.id);
  fs.rmSync(sourceDir, { recursive: true });
  const p = await store.scanProject(project.id);
  assert.match(p.scanWarning, /目录不存在/);
  assert.equal(p.files[0].missing, true);
});

test('设置仅保留允许字段，管理周期与交付独立记录', t => {
  const { store, project } = fixture(t);
  const state = store.setSettings({ activeProjectId: project.id, alwaysOnTop: true, autoScan: false, ballPosition: { x: 20, y: 40 }, ignored: 'no' });
  assert.equal(state.settings.ignored, undefined);
  assert.equal(state.settings.activeProjectId, project.id);
  assert.throws(() => store.setSettings({ activeProjectId: 'missing' }), /项目不存在/);
  let p = store.startCycle(project.id, '第二轮交付');
  assert.equal(p.cycles[0].status, '已结束');
  p = store.addDelivery(project.id, { date: '2026-10-09', version: 'v0.2', summary: '修复导入失败' });
  assert.equal(p.deliveries[0].cycleId, p.activeCycleId);
  assert.equal(p.deliveries[0].status, '待客户验证');
});

test('人工完成结束当前周期，开始下一周期重置阶段和阻塞', t => {
  const { store, project } = fixture(t);
  let p = store.updateProject(project.id, { stage: '已完成', nextAction: '上轮下一步', blocker: '上轮阻塞' });
  assert.equal(p.cycles[0].status, '已结束');
  assert.ok(p.cycles[0].endedAt);
  const endedAt = p.cycles[0].endedAt;
  p = store.startCycle(project.id, '新增需求');
  assert.equal(p.cycles[0].endedAt, endedAt);
  assert.equal(p.cycles[1].status, '进行中');
  assert.equal(p.stage, '需求梳理');
  assert.equal(p.nextAction, '');
  assert.equal(p.blocker, '');
});

test('目录实际变更清理对应旧索引，开发目录变更解除会话绑定', async t => {
  const { root, sourceDir, devDir, store, project } = fixture(t);
  fs.writeFileSync(path.join(sourceDir, '旧需求.txt'), '旧需求');
  fs.writeFileSync(path.join(devDir, '旧成果.md'), '旧成果');
  await store.scanProject(project.id);
  await store.addFiles(project.id, [path.join(sourceDir, '旧需求.txt')]);
  store.updateProject(project.id, { codex: { threadId: 'old-thread', lastSyncAt: '2026-10-08' } });
  let p = store.updateProject(project.id, { devDir });
  assert.equal(p.codex.threadId, 'old-thread');
  const nextDev = path.join(root, 'next-dev'); fs.mkdirSync(nextDev);
  p = store.updateProject(project.id, { devDir: nextDev, codex: { threadId: 'unsafe-rebind' } });
  assert.equal(p.codex.threadId, '');
  assert.equal(p.files.some(file => file.kind === '开发成果'), false);
  assert.equal(p.files.some(file => file.kind === '原始资料'), true);
  const nextSource = path.join(root, 'next-source'); fs.mkdirSync(nextSource);
  p = store.updateProject(project.id, { sourceDir: nextSource });
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].kind, '补充资料');
  p = await store.scanProject(project.id);
  assert.equal(p.files.length, 1);
});

test('未变化的周期扫描不写 JSON 或重写历史日报', async t => {
  const { sourceDir, store, project } = fixture(t);
  fs.writeFileSync(path.join(sourceDir, '需求.txt'), '客户业务资料');
  await store.scanProject(project.id);
  store.saveReport(project.id, '2026-10-08', '人工确认日报');
  const reportPath = path.join(store.projectFolder(project.id), '日报', '2026-10-08.md');
  const stateBefore = fs.statSync(store.statePath).mtimeMs;
  const reportBefore = fs.statSync(reportPath).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 20));
  const p = await store.scanProject(project.id);
  assert.ok(p.lastScanAt);
  assert.equal(fs.statSync(store.statePath).mtimeMs, stateBefore);
  assert.equal(fs.statSync(reportPath).mtimeMs, reportBefore);
});

function makeFiles(root, names) {
  return names.map(name => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `fixture ${name}`);
    return target;
  });
}

function legacyIndex(filePath, kind, description = '') {
  const stat = fs.statSync(filePath);
  return { id: `legacy-${Buffer.from(filePath).toString('hex').slice(-30)}`, path: filePath, name: path.basename(filePath), kind, description, descriptionSource: description ? 'user' : 'automatic', textPreview: '', ext: path.extname(filePath), size: stat.size, mtime: stat.mtime.toISOString(), missing: false };
}

test('原始与开发扫描都排除管理区，历史自引用移出活动索引并保留用户介绍', async t => {
  const { root, sourceDir, devDir, dataDir, store, project } = fixture(t);
  const managerFile = path.join(dataDir, 'store.json');
  const managedDoc = path.join(store.projectFolder(project.id), '需求清单.md');
  const ownSupplement = makeFiles(sourceDir, ['补充.log'])[0];
  await store.addFiles(project.id, [ownSupplement]);
  let p = store.updateProject(project.id, { devDir: root });
  store.state.projects[0].files.push(legacyIndex(managerFile, '开发成果', '曾手工标记的管理档案'));
  store.state.projects[0].files.push(legacyIndex(managedDoc, '开发成果'));
  p = await store.scanProject(project.id);
  assert.equal(p.files.some(file => file.kind === '开发成果' && file.path.startsWith(dataDir)), false);
  assert.equal(p.files.filter(file => file.kind === '补充资料').length, 1);
  assert.equal(p.fileAnnotations[canonical(managerFile)].description, '曾手工标记的管理档案');
  assert.ok(fs.existsSync(managerFile));
  assert.ok(fs.existsSync(managedDoc));
  // Swap only the test fixture's roots to exercise the source-side exclusion too.
  store.updateProject(project.id, { sourceDir: root, devDir });
  store.state.projects[0].files.push(legacyIndex(managerFile, '原始资料'));
  store.state.projects[0].files.push(legacyIndex(managedDoc, '原始资料'));
  p = await store.scanProject(project.id);
  assert.equal(p.files.some(file => file.kind === '原始资料' && file.path.startsWith(dataDir)), false);
  assert.equal(p.files.filter(file => file.kind === '补充资料').length, 1);
  assert.ok(fs.existsSync(managerFile));
});

test('开发成果排除发布缓存与配置噪声，旧噪声移除而业务文档和缺失证据保留', async t => {
  const { sourceDir, devDir, store, project } = fixture(t);
  const noise = makeFiles(devDir, ['release/resources/README.md', 'node_modules/dependency/README.md', '.test-tmp/scenario/result.json', '.test-ui-smoke/report.md', 'test-output/demo-data/projects/example/项目档案.md', 'test-output/screenshots/preview.png', '.pack-tmp/staging/README.md', '.tmp/scenario/result.json', '.fde-build/resources/README.md', '.fde-build-output/artifact/说明.md', '.npm-cache/_logs/install.log', 'runtime-cache/Cache/index.json', 'Local Storage/leveldb/000003.log', 'Code Cache/js/metadata.json', 'logs/runtime.txt', '000003.log', 'package.json', 'package-lock.json', 'tsconfig.node.json', 'electron-builder.config.yaml', 'store.backup.json']);
  const documents = makeFiles(devDir, ['README.md', 'docs/需求.md', 'docs/方案.md', 'reports/测试报告.md', 'preview/index.html', 'assets/流程图.svg', 'samples/业务样例.json', 'data/客户样例.json', 'data/业务说明.md']);
  makeFiles(sourceDir, ['客户报错.log', 'package.json']);
  store.state.projects[0].files.push(...noise.map(file => legacyIndex(file, '开发成果', path.basename(file) === 'package.json' ? '人工介绍需要保留' : '')));
  const vanished = path.join(devDir, '交付说明.md');
  fs.writeFileSync(vanished, '交付说明');
  store.state.projects[0].files.push(legacyIndex(vanished, '开发成果', '已交付版本说明'));
  fs.unlinkSync(vanished);
  const p = await store.scanProject(project.id);
  const paths = new Set(p.files.map(file => file.path));
  for (const file of noise) { assert.equal(paths.has(file), false, file); assert.ok(fs.existsSync(file)); }
  for (const file of documents) assert.ok(paths.has(file), file);
  assert.equal(p.files.find(file => file.path === vanished).missing, true);
  assert.equal(p.fileAnnotations[canonical(path.join(devDir, 'package.json'))].description, '人工介绍需要保留');
  assert.ok(p.files.some(file => file.kind === '原始资料' && file.name === '客户报错.log'));
  assert.ok(p.files.some(file => file.kind === '原始资料' && file.name === 'package.json'));
  assert.equal(shouldIndexFile(path.join(devDir, 'release', 'README.md'), devDir, '开发成果'), false);
});

test('排除规则不会删除补充附件，历史手工介绍在资料重新可见时恢复', async t => {
  const { root, sourceDir, devDir, store, project } = fixture(t);
  const attachment = makeFiles(sourceDir, ['客户.log'])[0];
  let p = await store.addFiles(project.id, [attachment]);
  const supplement = p.files.find(file => file.kind === '补充资料');
  store.updateFile(project.id, supplement.id, { description: '客户提供的失败日志' });
  const sourceCopy = makeFiles(sourceDir, ['package.json'])[0];
  store.state.projects[0].fileAnnotations ||= {};
  store.state.projects[0].fileAnnotations[canonical(sourceCopy)] = { id: 'old-note', path: sourceCopy, description: '客户提供的业务配置', descriptionSource: 'user' };
  p = await store.scanProject(project.id);
  assert.equal(p.files.find(file => file.path === sourceCopy).description, '客户提供的业务配置');
  assert.equal(p.files.find(file => file.id === supplement.id).description, '客户提供的失败日志');
  assert.ok(fs.existsSync(supplement.path));
  assert.equal(p.devDir, devDir);
  assert.equal(p.sourceDir, sourceDir);
});

test('开发成果子目录限定扫描范围，切换成果范围保留Codex绑定', async t => {
  const { root, sourceDir, devDir, store, project } = fixture(t);
  const selected = path.join(devDir, 'selected-project');
  const other = path.join(devDir, 'other-project');
  const [chosenDoc] = makeFiles(selected, ['README.md']);
  const [otherDoc] = makeFiles(other, ['README.md']);
  store.updateProject(project.id, { codex: { threadId: 'same-codex-thread' } });
  await store.scanProject(project.id);
  let p = store.updateProject(project.id, { artifactDir: selected });
  assert.equal(p.devDir, devDir);
  assert.equal(p.codex.threadId, 'same-codex-thread');
  assert.equal(p.files.some(file => file.kind === '开发成果'), false);
  p = await store.scanProject(project.id);
  assert.ok(p.files.some(file => file.path === chosenDoc));
  assert.equal(p.files.some(file => file.path === otherDoc), false);
  assert.throws(() => store.updateProject(project.id, { artifactDir: sourceDir }), /自身或其子目录/);
  assert.throws(() => store.updateProject(project.id, { artifactDir: path.join(devDir, 'missing') }), /不存在/);
  const nextDev = path.join(root, 'next-dev'); fs.mkdirSync(nextDev);
  p = store.updateProject(project.id, { devDir: nextDev });
  assert.equal(p.artifactDir, nextDev);
  assert.equal(p.codex.threadId, '');
});

test('新项目成果目录校验与缺省兼容，管理目录不能作为成果目录', async t => {
  const { root, sourceDir, devDir, dataDir, store, project } = fixture(t);
  assert.equal(project.artifactDir, devDir);
  assert.throws(() => store.createProject({ name: '越界成果', sourceDir, devDir, artifactDir: sourceDir }), /自身或其子目录/);
  store.updateProject(project.id, { devDir: root });
  assert.throws(() => store.updateProject(project.id, { artifactDir: dataDir }), /管理目录/);
  // Existing stores without artifactDir keep devDir as the effective scan root.
  delete store.state.projects[0].artifactDir;
  const [doc] = makeFiles(devDir, ['兼容方案.md']);
  const p = await store.scanProject(project.id);
  assert.ok(p.files.some(file => file.path === doc));
});

test('成果目录拒绝链接越界，清空可选范围恢复开发目录默认值', t => {
  const { root, sourceDir, devDir, store, project } = fixture(t);
  const selected = path.join(devDir, 'selected'); fs.mkdirSync(selected);
  const created = store.createProject({ name: '限定成果项目', sourceDir, devDir, artifactDir: selected });
  assert.equal(created.artifactDir, selected);
  const reset = store.updateProject(created.id, { artifactDir: '' });
  assert.equal(reset.artifactDir, devDir);
  const outside = path.join(root, 'outside-artifacts'); fs.mkdirSync(outside);
  const junction = path.join(devDir, 'linked-artifacts');
  try { fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('系统不允许创建测试链接；目录越界校验已由其他回归覆盖。'); return; }
    throw error;
  }
  assert.throws(() => store.updateProject(project.id, { artifactDir: junction }), /链接|自身或其子目录/);
});

function dailyInput(date, fingerprint = 'fingerprint-1', items) {
  return { date, fingerprint, method: 'local', threadId: 'summary-thread', items: items || [{ issueKey: 'BUG-IMPORT', title: '表格导入失败', cause: '字段识别异常', action: '调整字段识别', result: '客户样例通过，等待验证', status: '待验证', turnIds: ['turn-1', 'turn-2'], attachments: [{ path: 'D:\\sample\\error.png', description: '客户报错截图' }], sourceRef: 'Codex 会话第 1、2 轮' }] };
}

test('自动按日汇总创建稳定草稿，来源媒体保留且独立归档', t => {
  const { store, project, dataDir } = fixture(t);
  store.updateProject(project.id, { codex: { threadId: 'summary-thread' } });
  let p = store.applyDailySummary(project.id, dailyInput('2026-10-09'));
  assert.equal(p.records.length, 1);
  assert.equal(p.records[0].confirmed, false);
  assert.equal(p.records[0].managedBy, 'codex-auto');
  assert.equal(p.records[0].autoGenerated, true);
  assert.deepEqual(p.records[0].turnIds, ['turn-1', 'turn-2']);
  assert.equal(p.records[0].attachments[0].description, '客户报错截图');
  assert.deepEqual(p.records[0].origin, { threadId: 'summary-thread', turnId: 'turn-1' });
  const firstId = p.records[0].id;
  p = store.applyDailySummary(project.id, dailyInput('2026-10-09'));
  assert.equal(p.records.length, 1);
  assert.equal(p.records[0].id, firstId);
  assert.equal(p.codex.dailySummaries.length, 1);
  assert.equal(p.codex.summaryStatus.state, 'ready');
  const report = store.generateReport(project.id, '2026-10-09');
  assert.match(report.text, /字段识别异常/);
  assert.doesNotMatch(report.text, /状态：|待核对/);
  assert.equal(report.includedDrafts, 1);
  assert.equal(report.method, 'local');
  assert.equal(report.needsReview, true);
  const autoFile = path.join(store.projectFolder(project.id), '自动整理', '2026-10-09.md');
  assert.match(fs.readFileSync(autoFile, 'utf8'), /日报/);
  const restarted = new Store(dataDir);
  assert.equal(restarted.getDailySummary(project.id, '2026-10-09').fingerprint, 'fingerprint-1');
  assert.equal(restarted.getState().projects[0].records[0].managedBy, 'codex-auto');
});

test('同日快照替换自动稿并保留跨日工作，重复事项归并', t => {
  const { store, project } = fixture(t);
  store.updateProject(project.id, { codex: { threadId: 'summary-thread' } });
  let p = store.applyDailySummary(project.id, dailyInput('2026-10-08'));
  const previousId = p.records[0].id;
  const items = [
    { issueKey: 'BUG-IMPORT', title: '表格导入失败', action: '定位问题', status: '进行中', turnIds: ['a'] },
    { issueKey: 'BUG-IMPORT', title: '表格导入失败', action: '修复后复测', result: '样例通过', status: '待验证', turnIds: ['b'] },
    { issueKey: 'DOC-1', title: '整理客户资料', action: '建立资料索引', result: '可检索资料', status: '已完成' },
  ];
  p = store.applyDailySummary(project.id, dailyInput('2026-10-09', 'second', items));
  assert.equal(p.records.length, 3);
  assert.equal(p.records.find(record => record.date === '2026-10-08').id, previousId);
  const merged = p.records.find(record => record.date === '2026-10-09' && record.issueKey === 'BUG-IMPORT');
  assert.match(merged.action, /定位问题\n修复后复测/);
  assert.deepEqual(merged.turnIds, ['a', 'b']);
  p = store.applyDailySummary(project.id, dailyInput('2026-10-09', 'third', [{ issueKey: 'DOC-1', title: '整理客户资料', action: '补齐说明', result: '索引完善', status: '已完成' }]));
  assert.equal(p.records.length, 2);
  assert.ok(p.records.some(record => record.date === '2026-10-08'));
  assert.equal(p.records.find(record => record.date === '2026-10-09').result, '索引完善');
  assert.equal(p.codex.dailySummaries.length, 2);
});

test('人工接管或确认自动记录后，后续快照不能覆盖或生成重复项', t => {
  const { store, project } = fixture(t);
  store.updateProject(project.id, { codex: { threadId: 'summary-thread' } });
  let p = store.applyDailySummary(project.id, dailyInput('2026-10-09'));
  const recordId = p.records[0].id;
  p = store.upsertRecord(project.id, { id: recordId, title: '人工修正标题', action: '客户现场复测', result: '客户仍反馈异常', status: '未解决', confirmed: false });
  assert.equal(p.records[0].managedBy, undefined);
  assert.equal(p.records[0].manual, true);
  assert.equal(p.records[0].autoGenerated, false);
  p = store.applyDailySummary(project.id, dailyInput('2026-10-09', 'next-fingerprint'));
  assert.equal(p.records.length, 1);
  assert.equal(p.records[0].title, '人工修正标题');
  assert.equal(p.records[0].result, '客户仍反馈异常');
  assert.match(store.generateReport(project.id, '2026-10-09').text, /客户仍反馈异常/);
  store.upsertRecord(project.id, { id: recordId, confirmed: true });
  p = store.applyDailySummary(project.id, dailyInput('2026-10-09', 'again'));
  assert.equal(p.records.length, 1);
  assert.equal(p.records[0].confirmed, true);
  assert.equal(store.generateReport(project.id, '2026-10-09').includedDrafts, 0);
});

test('日报合并不重复自动事项，保留已保存人工日报，删除的自动稿不会复活', t => {
  const { store, project } = fixture(t);
  store.updateProject(project.id, { codex: { threadId: 'summary-thread' } });
  store.upsertRecord(project.id, { issueKey: 'BUG-IMPORT', title: '表格导入失败', date: '2026-10-09', action: '人工已验证', result: '确认解决', confirmed: true, status: '已完成' });
  const input = dailyInput('2026-10-09');
  input.items.push({ issueKey: 'REQ-2', title: '新增导出需求', action: '分析客户要求', status: '待确认', turnIds: ['turn-3'] });
  let p = store.applyDailySummary(project.id, input);
  assert.equal(p.records.length, 2);
  let report = store.generateReport(project.id, '2026-10-09');
  assert.equal((report.text.match(/\*\*表格导入失败\*\*/g) || []).length, 1);
  assert.match(report.text, /确认解决/);
  assert.match(report.text, /新增导出需求/);
  assert.equal(report.includedDrafts, 1);
  store.saveReport(project.id, '2026-10-09', '这是人工定稿，不允许自动覆盖。');
  const draftId = p.records.find(record => record.managedBy === 'codex-auto').id;
  store.removeRecord(project.id, draftId);
  p = store.applyDailySummary(project.id, { ...input, fingerprint: 'updated' });
  assert.equal(p.records.length, 1);
  assert.equal(p.reports[0].text, '这是人工定稿，不允许自动覆盖。');
  assert.equal(fs.readFileSync(p.reports[0].path, 'utf8'), '这是人工定稿，不允许自动覆盖。');
  report = store.generateReport(project.id, '2026-10-09');
  assert.doesNotMatch(report.text, /新增导出需求/);
});

test('更新同步时间保留摘要，换会话隔离旧自动稿并拒绝迟到结果', t => {
  const { store, project } = fixture(t);
  store.updateProject(project.id, { codex: { threadId: 'summary-thread' } });
  store.applyDailySummary(project.id, dailyInput('2026-10-09'));
  store.upsertRecord(project.id, { date: '2026-10-09', title: '人工工作', action: '客户沟通', status: '已完成', confirmed: true });
  let p = store.updateProject(project.id, { codex: { lastSyncAt: '2026-10-09T01:00:00Z' } });
  assert.equal(p.codex.dailySummaries.length, 1);
  assert.equal(p.codex.summaryStatus.state, 'ready');
  p = store.updateProject(project.id, { codex: { threadId: 'another-thread' } });
  assert.equal(p.codex.dailySummaries.length, 0);
  assert.equal(p.codex.summaryStatus.state, 'idle');
  assert.equal(p.codex.summaryArchives[0].dailySummaries.length, 1);
  assert.equal(p.codex.summaryArchives[0].records[0].title, '表格导入失败');
  assert.equal(p.records.length, 1);
  assert.equal(p.records[0].title, '人工工作');
  assert.throws(() => store.applyDailySummary(project.id, dailyInput('2026-10-09', 'late')), /会话已变化/);
  assert.throws(() => store.setSummaryStatus(project.id, { state: 'ready', threadId: 'summary-thread' }), /会话已变化/);
  assert.equal(fs.existsSync(path.join(store.projectFolder(project.id), '自动整理', '2026-10-09.md')), false);
  const archiveDir = path.join(store.projectFolder(project.id), '自动整理', '会话归档');
  assert.ok(fs.readdirSync(archiveDir).some(name => fs.existsSync(path.join(archiveDir, name, '2026-10-09.md'))));
});

test('旧档案兼容每日摘要，公开模型设置不保存密钥', t => {
  const { store, project, dataDir } = fixture(t);
  assert.equal(store.getState().settings.summarizer.model, 'deepseek-flash');
  const state = store.saveSummarizerSettings({ enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-flash', apiKey: 'never-save-this', secret: 'never-save-secret' });
  assert.deepEqual(Object.keys(state.settings.summarizer).sort(), ['baseUrl', 'enabled', 'model', 'provider']);
  assert.doesNotMatch(fs.readFileSync(store.statePath, 'utf8'), /never-save-this|never-save-secret/);
  assert.throws(() => store.saveSummarizerSettings({ baseUrl: 'https://api.example.com/?key=secret' }), /不能包含密钥/);
  assert.throws(() => store.saveSummarizerSettings({ enabled: 'yes' }), /布尔值/);
  store.setSummaryStatus(project.id, { state: 'running', message: '正在整理' });
  assert.equal(store.getState().projects[0].codex.summaryStatus.state, 'running');
  store.setSummaryStatus(project.id, { state: 'error', message: '服务暂不可用' });
  assert.equal(store.getState().projects[0].codex.summaryStatus.state, 'error');
  // Simulate the actual previous store shape without the new optional fields.
  const old = JSON.parse(fs.readFileSync(store.statePath, 'utf8'));
  old.projects[0].codex = { threadId: 'old-thread', lastSyncAt: '' };
  delete old.settings.summarizer;
  fs.writeFileSync(store.statePath, JSON.stringify(old));
  const migrated = new Store(dataDir).getState();
  assert.deepEqual(migrated.projects[0].codex.dailySummaries, []);
  assert.equal(migrated.projects[0].codex.summaryStatus.state, 'idle');
  assert.equal(migrated.settings.summarizer.provider, 'deepseek');
});
