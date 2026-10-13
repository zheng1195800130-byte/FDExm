'use strict';

// Renderer-only acceptance. A dedicated Electron fixture serves in-memory
// state through the real preload; no Store, Codex home, model or OS clipboard
// is used. The real backend/model transport is tested by the integration smoke.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const PORTABLE = !!process.env.FDE_SMOKE_EXECUTABLE;
const DATE_ONLY = process.argv.includes('--date-filter-only');
const MODE = PORTABLE ? '便携版' : '源码';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function run() {
  const output = path.join(ROOT, 'test-output'); await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, '需求界面 独立mock '));
  const sourceDir = path.join(fixture, '只读原始资料'), devDir = path.join(fixture, '项目开发'), dataDir = path.join(fixture, '独立界面数据');
  await Promise.all([sourceDir, devDir, dataDir].map(dir => fs.mkdir(dir, { recursive: true })));
  const source = path.join(sourceDir, '业务说明.md'); await fs.writeFile(source, '隔离 UI 资料：订单报表与客户确认问题。');
  const sourceBefore = hash(await fs.readFile(source));
  const project = {
    requirementsDateMode:'all', id: 'ui-project-a', name: '客户报表助手', sourceDir, devDir, artifactDir: devDir, activeCycleId: 'cycle-a',
    cycles: [{ id: 'cycle-a', name: '首次交付', status: '进行中' }], records: [], reports: [], deliveries: [],
    codex: {}, files: [{ id: 'source-a', name: '业务说明.md', path: source, kind: '原始资料', textPreview: '客户需要月度订单报表', description: '客户初始业务背景' }],
    requirementAnalysis: { status: { state: 'ready', message: '已整理可读取内容，部分资料尚未读取。', updatedAt: '2026-10-09T09:00:00Z' }, sourceCount: 3, coveragePartial: true, omittedCount: 3, warnings: ['业务材料超过单次范围，有 3 个片段未读取。', '客户截图.png：图片文字未识别。'] },
    requirements: [
      { id: 'req-a', title: '按月导出订单报表', description: '业务人员按月份导出订单报表，保留退款金额口径。', status: '待确认', managedBy: 'requirements-auto', requirementKey: 'monthly-report', manual: false, questions: ['退款金额是否扣除？', '报表由谁确认？'], sourceIds: ['file:source-a:1', 'turn:initial-a'], sourceRef: `${source}\ncodex:fixture-thread#turn=initial-a`, cycleId: 'cycle-a' },
      { id: 'req-b', title: '保留附件 <script>globalThis.__requirementsAttack=1</script>', description: '上传客户提供的凭证附件，便于业务核对。', status: '待确认', managedBy: 'requirements-auto', requirementKey: 'attachment', manual: false, questions: ['附件保留多长时间？'], sourceIds: ['file:source-a:1'], sourceRef: source, cycleId: 'cycle-a' },
    ],
  };
  const otherProject = { ...structuredClone(project), id: 'ui-project-b', name: '另一项目', requirements: [], requirementConfirmations: [], requirementsAfter: '', requirementsDateMode:undefined, files: [] };
  const state = { projects: [project, otherProject], settings: { activeProjectId: project.id }, modelSettings: { enabled: true, provider: 'compatible', model: 'mock-only', baseUrl: 'http://127.0.0.1:1/v1', keyConfigured: false, keyRequired: false }, dataDir };
  await fs.writeFile(path.join(fixture, 'config.json'), JSON.stringify({ state, root: ROOT }));
  const mainPath = path.join(fixture, 'main.cjs');
  const fixtureMain = String.raw`
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));
app.setPath('userData',path.join(__dirname,'electron-user-data'));
const mock=globalThis.__requirementsUI={state:config.state,calls:[],copied:[],failNext:false};
let window;
const broadcast=()=>window.webContents.send('fde:changed',{requirementsUpdated:mock.state.settings.activeProjectId});
ipcMain.handle('fde:request',async(_event,input)=>{
  const {action,payload:p={}}=input;mock.calls.push({action,payload:p});
  try{
    let value;const project=mock.state.projects.find(item=>item.id===(p.id||mock.state.settings.activeProjectId));
    if(action==='state')value=structuredClone(mock.state);
    else if(action==='model:settings')value=mock.state.modelSettings;
    else if(action==='clipboard:text'){mock.copied.push(p.text);value=true;}
    else if(action==='requirement:analyze'){
      if(mock.failNext){mock.failNext=false;throw new Error('隔离模拟：需求整理请求失败');}
      project.requirementAnalysis.status={state:'running',message:'正在梳理业务需求和待确认问题…',updatedAt:new Date().toISOString()};broadcast();value={started:true};
    }else if(action==='requirement:save'){
      const existing=project.requirements.find(item=>item.id===p.input.id);
      if(existing){Object.assign(existing,p.input);if(existing.managedBy==='requirements-auto')existing.manual=true;}
      else project.requirements.push({...p.input,id:'manual-ui-requirement'});
      broadcast();value=structuredClone(project);
    }else if(action==='requirement:confirmation-save'){
      const existing=project.requirementConfirmations.find(item=>item.id===p.input.id);
      if(!existing)throw new Error('待确认事项不存在');Object.assign(existing,p.input,{manual:true});broadcast();value=structuredClone(project);
    }else if(action==='requirement:filter'){project.requirementsAfter=p.after;project.requirementsDateMode=p.mode;broadcast();value=structuredClone(project);}
    else if(action==='project:select'){mock.state.settings.activeProjectId=p.id;broadcast();value=true;}
    else if(action==='codex:list')value={threads:[],candidates:[]};
    else throw new Error('隔离 UI 不支持此操作：'+action);
    return {ok:true,value};
  }catch(error){return {ok:false,error:error.message};}
});
app.whenReady().then(()=>{
 window=new BrowserWindow({width:1344,height:1000,show:true,webPreferences:{preload:path.join(config.root,'desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.loadFile(path.join(config.root,'src/ui/index.html'));
});
app.on('window-all-closed',()=>app.quit());
`;
  await fs.writeFile(mainPath, fixtureMain);
  // Packaged Electron cannot be redirected to a fixture main. Start its real
  // main against an empty, model-disabled test Store, then replace only IPC
  // with the same in-memory UI fixture before reloading its packaged renderer.
  const mockModule = path.join(fixture, 'mock-ipc.cjs');
  const handler = fixtureMain.slice(fixtureMain.indexOf('const mock='), fixtureMain.indexOf('app.whenReady()'));
  await fs.writeFile(mockModule, `exports.install=(electron,state)=>{const {ipcMain,BrowserWindow}=electron;const config={state};ipcMain.removeHandler('fde:request');${handler}\nwindow=BrowserWindow.getAllWindows().find(value=>value.webContents.getURL().endsWith('/index.html'));};`);
  if (PORTABLE) await fs.writeFile(path.join(dataDir, 'store.json'), JSON.stringify({ version: 1, settings: { summarizer: { enabled: false } }, projects: [] }));
  const checks = [], errors = [], network = [], screenshots = [];
  const check = (value, description) => { assert.ok(value, description); checks.push(description); };
  let app, page;
  async function eventually(predicate, description, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await pause(60); }
    throw new Error(description);
  }
  const controls = () => app.evaluate(() => ({ calls: globalThis.__requirementsUI.calls, copied: globalThis.__requirementsUI.copied, state: globalThis.__requirementsUI.state }));
  const analyzeCalls = async () => (await controls()).calls.filter(call => call.action === 'requirement:analyze').length;
  async function patch({ project: patchProject, modelSettings, failNext }) {
    await app.evaluate(({ BrowserWindow }, input) => {
      const mock = globalThis.__requirementsUI;
      if (input.project) Object.assign(mock.state.projects[0], input.project);
      if (input.modelSettings) Object.assign(mock.state.modelSettings, input.modelSettings);
      if (input.failNext !== undefined) mock.failNext = input.failNext;
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('fde:changed', { requirementsUpdated: mock.state.projects[0].id });
    }, { project: patchProject, modelSettings, failNext });
  }
  try {
    const env = { ...process.env, FDE_DATA_DIR: dataDir, FDE_TEST: '1', CODEX_HOME: path.join(fixture, 'empty-codex') }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: process.env.FDE_SMOKE_EXECUTABLE || require('electron'), args: PORTABLE ? [] : [mainPath], env, timeout: 40000 }); await app.firstWindow();
    await eventually(async()=>{page=app.windows().find(value=>value.url().endsWith('/index.html'));return !!page;},'需求工作台没有载入');
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/i.test(request.url())) network.push(request.url()); });
    if (PORTABLE) {
      await app.evaluate((electron, input) => {
        process.mainModule.require(input.mockModule).install(electron, input.state);
        const window=electron.BrowserWindow.getAllWindows().find(value=>value.webContents.getURL().endsWith('/index.html'));
        window.setAlwaysOnTop(false);window.setContentSize(1344,950);window.show();window.focus();
      }, { mockModule, state });
      await page.reload();
    }
    await page.locator('[data-route="requirements"]').first().click();
    await page.locator('.requirement-card').first().waitFor();
    check(await app.evaluate(({app})=>app.getPath('userData')) === (PORTABLE?path.join(dataDir,'runtime'):path.join(fixture, 'electron-user-data')), 'UI验收使用自身用户目录，未接触正式项目数据或密钥');
    if (!DATE_ONLY) {
    check(await page.locator('.requirement-card').count() === 2 && await page.locator('#requirement-business-title').innerText() === '业务需求 2', '业务需求聚合显示，不将确认问题塞入需求数组');
    check(await page.locator('.requirement-question').count() === 3 && (await page.locator('#requirement-questions').innerText()).includes('对应需求：按月导出订单报表'), '待确认问题单独集中显示并标明对应业务');
    check((await page.locator('.requirement-source-brief').first().innerText()).includes('业务说明.md') && !(await page.locator('.requirement-source-brief').first().innerText()).includes(sourceDir), '来源默认显示简名，完整路径留在详细依据');
    await page.locator('.requirement-sources summary').first().click();
    check((await page.locator('.requirement-sources[open]').innerText()).includes(source), '可按需展开查看真实来源路径与会话引用');
    await page.locator('.requirement-sources summary').first().click();
    check(await page.evaluate(()=>globalThis.__requirementsAttack) === undefined && await page.locator('#workspace script').count() === 0, '需求标题与来源仅作为安全文本展示');
    check(await page.locator('.heading-actions [data-action="new-requirement"]').count() === 0 && await page.locator('.requirement-section-head [data-action="new-requirement"]').innerText() === '补充需求', '人工补充降为辅助入口，页头聚焦复制与重新整理');
    const callsBefore = await analyzeCalls(); await page.locator('[data-route="overview"]').first().click(); await page.locator('[data-route="requirements"]').first().click();
    await patch({ project: {} }); await pause(280);
    check(await analyzeCalls() === callsBefore, '切页与后台刷新只显示状态，不触发额外模型整理');

    await page.locator('[data-action="edit-requirement"][data-item="req-a"]').first().click();
    check(await page.locator('#field-questionsText').inputValue() === '退款金额是否扣除？\n报表由谁确认？', '编辑表单保留每项业务的待确认问题');
    await page.locator('#field-questionsText').fill('需要客户确认新的金额口径？\n\n');
    await page.locator('#modal-form [type="submit"]').click(); await eventually(async()=>await page.locator('#form-dialog').getAttribute('open')===null,'需求编辑弹窗未关闭');
    await eventually(async()=>(await page.locator('#requirement-questions').innerText()).includes('新的金额口径'),'编辑问题未回填');
    let saved=(await controls()).calls.filter(call=>call.action==='requirement:save').at(-1).payload.input;
    check(saved.questions.length===1 && saved.questions[0]==='需要客户确认新的金额口径？' && !('questionsText' in saved), '问题按换行转数组保存，空行不形成新问题');
    check((await controls()).state.projects[0].requirements.find(item=>item.id==='req-a').manual===true, '人工修改自动需求后保留人工标记');
    await page.locator('[data-action="edit-requirement"][data-item="req-a"]').first().click();await page.locator('#field-questionsText').fill('');await page.locator('#modal-form [type="submit"]').click();
    await eventually(async()=>await page.locator('.requirement-question').count()===1,'清空问题未从集中区移除');
    check((await controls()).calls.filter(call=>call.action==='requirement:save').at(-1).payload.input.questions.length===0, '已确认的问题可以清空，并明确保存空数组');
    await page.locator('[data-action="copy-requirements"]').click();
    const copied=(await controls()).copied.at(-1);
    check(copied.includes('业务需求')&&copied.includes('待确认问题')&&copied.includes('附件保留多长时间？')&&!copied.includes('退款金额是否扣除？'), '复制摘要同时包含业务需求与当前确认问题，不复制已删除问题');

    await patch({project:{requirements:[],files:[],codex:{},requirementAnalysis:{status:{state:'idle',message:'暂无可提取的业务正文。'},warnings:[]}}});
    await eventually(async()=>await page.locator('.requirement-card').count()===0,'空资料场景未更新');
    check(await page.locator('[data-action="add-files"]').isVisible()&&await page.locator('[data-action="bind-codex"]').isVisible()&&await page.locator('[data-action="copy-requirements"]').isDisabled(),'资料与会话都空时提供补充资料或关联入口，未要求人工写需求');
    await patch({project:{requirements:project.requirements,files:project.files,requirementAnalysis:project.requirementAnalysis}});
    await eventually(async()=>await page.locator('.requirement-card').count()===2,'截图场景未还原');

    }
    const structuredRequirements=structuredClone(project.requirements);structuredRequirements[0].questions=['退款金额是否扣除？','报表由谁确认？'];
    structuredRequirements[0].sourceFirstAt='2026-10-09T01:00:00Z';structuredRequirements[0].sourceLastAt='2026-10-09T02:15:00Z';
    const confirmationItems=[
      {id:'confirmation-amount',confirmationKey:'refund-scope',scenario:'月度订单报表需要明确退款统计口径。',workaround:'暂按退款原额独立列出。',question:'退款金额是否扣除？',status:'待确认',sourceFirstAt:'2026-10-09T01:10:00Z',sourceLastAt:'2026-10-09T02:15:00Z',sourceRef:`codex:fixture-thread#turn=amount-a`,requirementKeys:['monthly-report']},
      {id:'confirmation-bill',confirmationKey:'bill-source',scenario:'提单信息暂时无法从业务系统获取。',workaround:'暂时由业务人员通过表格导入提单信息。',question:'提单信息最终从哪里获取，是否保留表格导入？',status:'待确认',sourceFirstAt:'2026-10-09T02:40:00Z',sourceLastAt:'2026-10-09T03:30:00Z',sourceRef:`codex:fixture-thread#turn=bill-a`,requirementKeys:[]},
      {id:'confirmation-owner',confirmationKey:'report-owner',scenario:'确定月度报表的业务确认人。',workaround:'',question:'报表由谁确认？',status:'已解决',resolution:'财务负责人确认。',sourceFirstAt:'2026-10-09T01:20:00Z',sourceLastAt:'2026-10-09T02:00:00Z',sourceRef:`codex:fixture-thread#turn=owner-a`,requirementKeys:['monthly-report']},
    ];
    await patch({project:{requirements:structuredRequirements,requirementConfirmations:confirmationItems,requirementsAfter:''}});
    await eventually(async()=>await page.locator('.requirement-confirmation').count()===3,'结构化确认事项未显示');
    check(await page.locator('.requirement-question').count()===3,'旧问题与结构化未解决、已解决事项精确去重，保留无结构化记录的旧问题');
    const bill=page.locator('[data-confirmation="confirmation-bill"]').first();
    check((await bill.locator('.confirmation-scenario').innerText()).includes('提单信息暂时无法')&&(await bill.locator('.confirmation-workaround').innerText()).includes('表格导入')&&(await bill.locator('.confirmation-question').innerText()).includes('最终从哪里获取'),'待确认事项按场景、临时处理和需要问客户的问题展示');
    check((await bill.locator('.requirement-source-time').innerText())==='Codex 对话 · 2026-10-09 11:30'&&(await page.locator('.requirement-card').first().locator('.requirement-source-time').innerText())==='Codex 对话 · 2026-10-09 10:15','统一显示真实 Codex 对话日期时分，未采用整理完成的 17:00 时间');
    check(await page.locator('#requirement-resolved').getAttribute('open')===null&&!await page.locator('#requirement-resolved .requirement-confirmation').isVisible(),'已解决确认事项默认收起，避免历史问题复活至待确认区');
    await bill.locator('.requirement-sources summary').click();
    check((await bill.locator('.requirement-sources').innerText()).includes('首次 Codex 对话：2026-10-09 10:40'),'首次提出时间在来源中按需展开，默认仅看最近相关对话时分');
    await bill.locator('.requirement-sources summary').click();
    await page.locator('[data-action="copy-requirements"]').click();
    let currentCopy=(await controls()).copied.at(-1);
    check(currentCopy.includes('表格导入')&&currentCopy.includes('2026-10-09 11:30')&&!currentCopy.includes('报表由谁确认？')&&!currentCopy.includes('财务负责人确认'),'复制包含当前未解决场景和临时处理，不复制已解决问题及结论');
    await bill.locator('[data-action="edit-requirement-confirmation"]').click();
    check(await page.locator('#field-scenario').inputValue()===confirmationItems[1].scenario&&await page.locator('#field-workaround').inputValue()===confirmationItems[1].workaround,'独立确认事项编辑保留场景、临时处理和问题');
    await page.locator('#field-workaround').fill('由客户提供统一表格，暂时导入提单信息。');await page.locator('#field-status').selectOption('已解决');await page.locator('#field-resolution').fill('客户确认先使用标准表格导入。');await page.locator('#modal-form [type="submit"]').click();
    await eventually(async()=>await page.locator('#form-dialog').getAttribute('open')===null,'确认事项保存未关闭弹窗');
    let confirmationSaved=(await controls()).calls.filter(call=>call.action==='requirement:confirmation-save').at(-1).payload;
    check(confirmationSaved.id===project.id&&confirmationSaved.input.id==='confirmation-bill'&&confirmationSaved.input.status==='已解决'&&confirmationSaved.input.resolution==='客户确认先使用标准表格导入。'&&!('sourceLastAt' in confirmationSaved.input),'确认事项独立保存到对应项目，人工编辑不改写原对话时间');
    await eventually(async()=>await page.locator('#requirement-resolved .requirement-confirmation').count()===2,'人工解决未移入已解决区');
    await patch({project:{}});await page.locator('[data-route="overview"]').first().click();await page.locator('[data-route="requirements"]').first().click();
    check(await page.locator('#requirement-resolved .requirement-confirmation').count()===2&&!(await page.locator('#requirement-questions').innerText()).includes('客户确认先使用标准表格导入。'),'切页和刷新保留人工解决状态，已解决内容默认不可见');
    await page.locator('[data-action="copy-requirements"]').click();currentCopy=(await controls()).copied.at(-1);
    check(!currentCopy.includes('提单信息最终从哪里获取')&&!currentCopy.includes('客户确认先使用标准表格导入'),'人工解决后复制摘要立即排除该事项');
    await patch({project:{requirementConfirmations:confirmationItems}});
    await eventually(async()=>await page.locator('#requirement-resolved .requirement-confirmation').count()===1,'时间筛选场景未恢复');
    structuredRequirements[0].sourceLastAt='2026-10-08T16:00:00Z';
    confirmationItems[0].sourceLastAt='2026-10-08T15:59:00Z';
    confirmationItems[2].sourceLastAt='2026-10-08T15:59:00Z';
    await patch({project:{requirements:structuredRequirements,requirementConfirmations:confirmationItems,requirementsAfter:'2026-10-09T02:15:00.000Z',requirementsDateMode:'date'}});
    await eventually(async()=>await page.locator('#requirement-after').inputValue()==='2026-10-09','历史时分筛选未按日期显示');
    check(await page.locator('#requirement-after').getAttribute('type')==='date'&&await page.locator('.requirement-card').count()===1,'筛选只到日，历史时分筛选按当天零点兼容并包含零点事项');
    await page.locator('[data-action="clear-requirement-filter"]').first().click();
    const beforeFilterCalls=await analyzeCalls();
    await page.locator('#requirement-after').fill('2026-10-09');await page.locator('#requirement-after').dispatchEvent('change');
    await eventually(async()=>await page.locator('.requirement-card').count()===1&&await page.locator('.requirement-confirmation').count()===1,'对话日期过滤没有生效');
    let filterCall=(await controls()).calls.filter(call=>call.action==='requirement:filter').at(-1).payload;
    check(filterCall.id===project.id&&filterCall.after==='2026-10-08T16:00:00.000Z','日期筛选按上海当天零点转换并保存到对应项目');
    check(await page.locator('.requirement-confirmation[data-confirmation="confirmation-bill"]').isVisible()&&await page.locator('.requirement-confirmation[data-confirmation="confirmation-amount"]').count()===0&&(await page.locator('#requirement-undated').innerText()).includes('无日期 1'),'包含当天事项，隐藏前一天和无对话时间的内容并说明');
    await page.locator('[data-action="copy-requirements"]').click();currentCopy=(await controls()).copied.at(-1);
    check(currentCopy.includes('对话日期：2026-10-09')&&currentCopy.includes('提单信息最终从哪里获取')&&!currentCopy.includes('退款金额是否扣除？')&&!currentCopy.includes('附件保留多长时间？')&&currentCopy.includes('按月导出订单报表'),'复制遵循日期范围并明确包含当天，不带出历史事项');
    await page.locator('[data-route="overview"]').first().click();await page.locator('[data-route="requirements"]').first().click();
    check(await page.locator('#requirement-after').inputValue()==='2026-10-09','切页保留当前项目已保存的日期筛选');
    await page.locator('#project-select').selectOption(otherProject.id);await eventually(async()=>await page.locator('#requirement-after').inputValue()===new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),'另一项目没有默认当日筛选');
    check((await controls()).state.projects[1].requirementsAfter===''&&await page.locator('.requirement-confirmation').count()===0,'项目切换不串需求、确认事项或时间筛选');
    await page.locator('#project-select').selectOption(project.id);await eventually(async()=>await page.locator('#requirement-after').inputValue()==='2026-10-09','原项目筛选未恢复');
    await page.reload();await page.locator('[data-route="requirements"]').first().click();
    check(await page.locator('#requirement-after').inputValue()==='2026-10-09'&&await page.locator('.requirement-confirmation').count()===1,'重新载入界面后仍使用后台保存的项目筛选');
    await page.locator('[data-action="clear-requirement-filter"]').first().click();await eventually(async()=>await page.locator('.requirement-card').count()===2,'清除筛选没有恢复旧需求');
    check((await controls()).calls.filter(call=>call.action==='requirement:filter').at(-1).payload.after===''&&await page.locator('#requirement-after').inputValue()===''&&await page.locator('.requirement-confirmation').count()===3,'清除筛选只恢复显示，历史数据始终保留');
    check(await analyzeCalls()===beforeFilterCalls,'设置或清除日期筛选、项目切换和重新载入均不请求 AI');
    // Today's default uses Shanghai boundaries and never leaks tomorrow's work.
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
    const midnight=Date.parse(today+'T00:00:00+08:00');
    const many=Array.from({length:24},(_,i)=>({...structuredRequirements[0],id:'scroll-'+i,title:'当日业务需求 '+i,sourceLastAt:new Date(midnight+i*60000).toISOString()}));
    await patch({project:{requirements:[...many,{...structuredRequirements[1],id:'yesterday',sourceLastAt:new Date(midnight-1).toISOString()},{...structuredRequirements[1],id:'tomorrow',sourceLastAt:new Date(midnight+86400000).toISOString()}],requirementsDateMode:undefined}});
    await eventually(async()=>await page.locator('.requirement-card').count()===24,'默认当日筛选没有排除昨日和次日');
    check(await page.locator('#requirement-after').inputValue()===today,'旧项目和未设日期的项目默认上海当日');
    const scrolling=await page.locator('.requirement-list').evaluate(element=>{element.scrollTop=100;const rows=[...element.querySelectorAll('.requirement-card')].slice(0,2).map(row=>row.getBoundingClientRect());return {scrolls:element.scrollHeight>element.clientHeight&&element.scrollTop>0,oneColumn:rows[0].x===rows[1].x&&rows[1].y>=rows[0].bottom-1};});
    check(scrolling.scrolls&&scrolling.oneColumn,'业务需求纵向排列，长列表在面板内滚动');
    await page.locator('[data-action="clear-requirement-filter"]').first().click();await eventually(async()=>await page.locator('.requirement-card').count()===26,'全部日期没有保留历史与次日需求');
    check(await page.locator('.requirement-list').count()===1&&await page.locator('.requirement-grid').count()===0,'全部日期仍使用相同纵向列表');
    await page.locator('[data-action="today-requirement-filter"]').click();await eventually(async()=>await page.locator('.requirement-card').count()===24,'当日按钮没有恢复动态今日筛选');
    check((await controls()).state.projects[0].requirementsDateMode==='today','当日模式持久化，跨日不固定在旧日期');
    await page.evaluate(()=>{document.querySelector('.requirement-list').scrollTop=0;window.scrollTo(0,0);});
    const desktop=path.join(output,`23-自动需求-UI桌面-${MODE}.png`);await page.screenshot({path:desktop,fullPage:true});screenshots.push(desktop);
    await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(value=>value.webContents.getURL().endsWith('/index.html'));window.setMinimumSize(600,500);window.setContentSize(900,760);});
    await pause(220);
    const narrow=path.join(output,`23-自动需求-UI窄窗-${MODE}.png`);await page.screenshot({path:narrow,fullPage:true});screenshots.push(narrow);
    const layout=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('#workspace *')].filter(element=>element.getBoundingClientRect().right>document.documentElement.clientWidth+1).slice(0,12).map(element=>({tag:element.tagName,class:element.className,right:element.getBoundingClientRect().right}))}));
    if(layout.scrollWidth>layout.width+1)console.error(JSON.stringify(layout));
    check(layout.scrollWidth<=layout.width+1,'900px窄窗口中业务卡片和来源自动换行，不横向溢出');
    check(network.length===0&&errors.length===0,'所有UI场景无网络、模型调用或渲染错误');
    check(hash(await fs.readFile(source))===sourceBefore,'测试原始资料保持不变，全部编辑仅进入内存 mock');
    const report={mode:MODE,checks:checks.length,results:checks,screenshots,fixture,networkRequests:network.length,rendererErrors:errors};
    await fs.writeFile(path.join(output,`${DATE_ONLY?'requirements-date-filter':'requirements-ui-smoke'}-${PORTABLE?'portable':'source'}.json`),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  }finally{if(app)await app.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
