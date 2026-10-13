'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const codex=require('../src/core/codex.cjs');
const {Store}=require('../src/core/store.cjs');
const {DailyDesk}=require('../src/core/daily-desk.cjs');
const DATE='2026-10-12';
function fixture(t){
  const base=path.resolve(__dirname,'../.test-tmp');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'project-day-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'codex'),cwd=path.join(root,'development'),source=path.join(root,'source');
  fs.mkdirSync(home);fs.mkdirSync(cwd);fs.mkdirSync(source);
  const store=new Store(path.join(root,'data')),p=store.createProject({name:'连续工作',sourceDir:source,devDir:cwd});store.bindCodexThread(p.id,{threadId:'old-chat'});
  const calls=[],reader={readThread:input=>codex.readThread({...input,home}),readProjectDay:input=>codex.readProjectDay({...input,home})};
  const service=new DailyDesk({store,reader,now:()=>new Date(`${DATE}T10:00:00Z`),getModel:()=>({config:{enabled:true,provider:'compatible',baseUrl:'http://127.0.0.1:1/v1',model:'fixture'},apiKey:'test-only'}),request:async(_c,_k,messages)=>{
    const input=JSON.parse(messages[1].content);calls.push(input);const sourceIds=input.sources.map(s=>s.id);
    return {overview:{scene:'核对账单',requirements:'接续处理',progress:'完成后续处理',nextAction:'等待验证',blocker:''},items:[{issueKey:'continuous-work',title:'账单核对',cause:'规则调整',action:'接续修改',result:'完成后续处理',status:'待验证',sourceIds}],requirements:[],confirmations:[],reportText:'接续完成账单核对，待验证。',reportIssueKeys:['continuous-work']};
  }});
  const work=(id,text,hour=3,date=DATE)=>{const timestamp=`${date}T${String(hour).padStart(2,'0')}:00:00Z`;return [{type:'event_msg',timestamp,payload:{type:'task_started',turn_id:id}},{type:'event_msg',timestamp,payload:{type:'user_message',message:text}},{type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:id,last_agent_message:`处理结果：${text}`}}];};
  const write=(id,rows,{archived=false,directory=cwd,subagent=false}={})=>{
    const folder=path.join(home,archived?'archived_sessions':'sessions');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,`rollout-${id}.jsonl`);
    const meta={type:'session_meta',payload:{id,cwd:directory,...(subagent?{source:{subagent:{thread_spawn:{}}}}:{})}};
    fs.writeFileSync(file,[meta,...rows].map(JSON.stringify).join('\n')+'\n');return file;
  };
  return {root,home,cwd,store,p,service,reader,calls,work,write,current:()=>store.getState().projects[0]};
}
test('仅归档目录存在时仍能找到原会话，缓存后的归档移动也可继续读取',async t=>{
  const f=fixture(t),rows=f.work('morning','上午核对');const original=f.write('old-chat',rows);
  assert.equal((await codex.readThread({home:f.home,cwd:f.cwd,threadId:'old-chat',date:DATE})).turns.length,1);
  fs.mkdirSync(path.join(f.home,'archived_sessions'));fs.renameSync(original,path.join(f.home,'archived_sessions',path.basename(original)));fs.rmdirSync(path.join(f.home,'sessions'));
  const threads=await codex.listThreads({home:f.home,cwd:f.cwd});assert.equal(threads.length,1);assert.equal(threads[0].archived,true);
  assert.equal((await codex.readThread({home:f.home,cwd:f.cwd,threadId:'old-chat',date:DATE})).turns[0].id,'morning');
});
test('归档旧会话与新会话按上海当日接续，其他目录、子智能体和昨日不混入',async t=>{
  const f=fixture(t);f.write('old-chat',[...f.work('morning','上午未完成',1),...f.work('yesterday','昨日内容',1,'2026-10-11')],{archived:true});f.write('new-chat',f.work('afternoon','下午已完成',7));
  f.write('sibling',f.work('private','其他项目'),{directory:f.cwd+'-other'});f.write('child',f.work('agent','子智能体'),{subagent:true});
  const read=await f.reader.readProjectDay({threadId:'old-chat',cwd:f.cwd,date:DATE});assert.deepEqual(read.turns.map(t=>t.originalTurnId),['morning','afternoon']);assert.equal(read.threads.length,2);assert.ok(read.turns[1].id.includes('new-chat'));
  await f.service.run(f.p.id,DATE);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].sources.map(s=>s.threadId),['old-chat','new-chat']);assert.equal(f.current().dailyDesk.days[DATE].threadCount,2);assert.equal(f.service.raw(f.p.id,'2026-10-11').turns.length,0);
  assert.equal((await f.service.run(f.p.id,DATE)).skipped,true);assert.equal(f.calls.length,1);
});
test('fork继承的同一轮只整理一次，不同会话同编号而不同内容仍分别保存',async t=>{
  const f=fixture(t),inherited=f.work('shared-turn','父会话成果',2);f.write('old-chat',inherited,{archived:true});f.write('fork-chat',[...inherited,...f.work('new-turn','后续成果',4)]);f.write('other-chat',f.work('shared-turn','独立会话的不同工作',6));
  const read=await f.reader.readProjectDay({threadId:'old-chat',cwd:f.cwd,date:DATE});assert.equal(read.turns.length,3);assert.equal(new Set(read.turns.map(t=>t.id)).size,3);
  await f.service.run(f.p.id,DATE);assert.equal(f.service.raw(f.p.id,DATE).turns.length,3);assert.equal(f.calls[0].sources.length,3);
});
test('归档只改变来源路径，不重新处理已完成的证据',async t=>{
  const f=fixture(t),original=f.write('old-chat',f.work('done','已整理成果'));await f.service.run(f.p.id,DATE);assert.equal(f.calls.length,1);
  fs.mkdirSync(path.join(f.home,'archived_sessions'));fs.renameSync(original,path.join(f.home,'archived_sessions',path.basename(original)));
  assert.equal((await f.service.run(f.p.id,DATE)).skipped,true);assert.equal(f.calls.length,1);assert.match(f.service.raw(f.p.id,DATE).turns[0].sourceRef,/archived_sessions/);
});
test('同目录换绑定保留结果、检查点和原文，只把后续新增内容送模型',async t=>{
  const f=fixture(t);f.write('old-chat',f.work('before','此前成果'));await f.service.run(f.p.id,DATE);const before=f.current();
  f.write('new-chat',f.work('after','后续修复',7));f.store.bindCodexThread(f.p.id,{threadId:'new-chat'});
  assert.deepEqual(f.current().records,before.records);assert.deepEqual(f.current().dailyDesk,before.dailyDesk);assert.deepEqual(f.current().codex.dailySummaries,before.codex.dailySummaries);
  await f.service.run(f.p.id,DATE);assert.equal(f.calls.length,2);assert.equal(f.calls[1].sources.length,1);assert.equal(f.calls[1].sources[0].threadId,'new-chat');assert.equal(f.calls[1].previousItems.length,1);
  assert.equal(f.service.raw(f.p.id,DATE).turns.length,2);assert.equal(f.current().records.length,1);assert.equal((await f.service.run(f.p.id,DATE)).skipped,true);
});
test('绑定入口已消失时接续同目录新会话，原已收录内容和提示保留',async t=>{
  const f=fixture(t),old=f.write('old-chat',f.work('old-turn','原已收录'));await f.service.run(f.p.id,DATE);fs.unlinkSync(old);f.write('new-chat',f.work('new-turn','新会话进展',7));
  await f.service.run(f.p.id,DATE);assert.equal(f.service.raw(f.p.id,DATE).turns.length,2);assert.equal(f.calls[1].sources.length,1);assert.match(f.current().dailyDesk.days[DATE].captureWarning,/原关联会话不可读取/);
});
test('旧版本分离的同日会话档案恢复到同日，旧文件保留',async t=>{
  const f=fixture(t);f.write('old-chat',f.work('morning','归档前工作'),{archived:true});f.write('new-chat',f.work('later','新工作',7));f.store.bindCodexThread(f.p.id,{threadId:'new-chat'});
  const archive=path.join(f.store.projectFolder(f.p.id),'每日收录','会话归档','legacy',`${DATE}.json`);fs.mkdirSync(path.dirname(archive),{recursive:true});
  const old={id:'saved-only',date:DATE,timestamp:`${DATE}T00:00:00Z`,userText:'旧版已收录原文',assistantText:'保留的答复',attachments:[],sourceRef:'local:old-chat'};fs.writeFileSync(archive,JSON.stringify({date:DATE,threadId:'old-chat',turns:[old]}));
  await f.service.run(f.p.id,DATE);assert.equal(f.service.raw(f.p.id,DATE).turns.length,3);assert.ok(fs.existsSync(archive));
});
test('所有会话不可读取时不清空原文、不请求模型，失败状态可见',async t=>{
  const f=fixture(t),file=f.write('old-chat',f.work('old-turn','保留成果'));await f.service.run(f.p.id,DATE);const before=f.service.raw(f.p.id,DATE),records=f.current().records;fs.unlinkSync(file);
  await assert.rejects(f.service.run(f.p.id,DATE),/已有收录/);assert.deepEqual(f.service.raw(f.p.id,DATE),before);assert.deepEqual(f.current().records,records);assert.equal(f.calls.length,1);assert.equal(f.current().dailyDesk.days[DATE].status,'error');
  f.write('old-chat',f.work('old-turn','保留成果'));assert.equal((await f.service.run(f.p.id,DATE)).skipped,true);assert.equal(f.calls.length,1);assert.equal(f.current().dailyDesk.days[DATE].status,'ready');
});
test('部分证据已整理后归档，只发送未处理分段，保存真实待整理数',async t=>{
  const f=fixture(t),file=f.write('old-chat',[...f.work('long-a','长段甲'.repeat(2200),1),...f.work('long-b','长段乙'.repeat(2200),2)]);
  const first=await f.service.run(f.p.id,DATE);assert.ok(first.pending>0);const sent=new Set(f.calls[0].sources.map(s=>s.id));
  fs.mkdirSync(path.join(f.home,'archived_sessions'));fs.renameSync(file,path.join(f.home,'archived_sessions',path.basename(file)));
  await f.service.run(f.p.id,DATE);assert.ok(f.calls[1].sources.length>0);assert.ok(f.calls[1].sources.every(s=>!sent.has(s.id)));
});
test('读取期间改变项目目录，旧目录在途内容不写入新目录的收录',async t=>{
  const f=fixture(t);f.write('old-chat',f.work('stale','旧目录工作'));let release,started;const ready=new Promise(r=>started=r),read=f.reader.readProjectDay;
  f.reader.readProjectDay=async input=>{const result=await read(input);started();await new Promise(r=>release=r);return result;};
  const task=f.service.capture(f.p.id,{date:DATE,materialHistory:false});await ready;const next=path.join(f.root,'different');fs.mkdirSync(next);f.store.updateProject(f.p.id,{devDir:next});release();await task;
  assert.equal(f.service.raw(f.p.id,DATE).turns.length,0);assert.equal(f.calls.length,0);
});
test('归档目录链接越界拒绝读取，日期无效在扫描前拒绝',async t=>{
  const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.home,'archived_sessions'),'junction');
  fs.writeFileSync(path.join(outside,'rollout-private.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'private',cwd:f.cwd}})+'\n');
  assert.deepEqual(await codex.listThreads({home:f.home,cwd:f.cwd}),[]);await assert.rejects(f.reader.readProjectDay({threadId:'old-chat',cwd:f.cwd,date:'2026-02-30'}),/日期/);
});
test('此前日期的归档不扫描正文，旧超长消息不误报当日遗漏',async t=>{
  const f=fixture(t);f.write('old-chat',f.work('today','当天工作'));
  const old=f.write('earlier',f.work('last-month','上月工作',1,'2026-09-01'),{archived:true});
  fs.appendFileSync(old,JSON.stringify({type:'event_msg',timestamp:'2026-09-01T01:00:00Z',payload:{type:'user_message',message:'旧超长内容'.repeat(400000)}})+'\n');
  fs.utimesSync(old,new Date('2026-09-02'),new Date('2026-09-02'));
  const read=await f.reader.readProjectDay({threadId:'old-chat',cwd:f.cwd,date:DATE});assert.equal(read.threads.length,1);assert.equal(read.workTruncated,false);assert.equal(read.warning,'');
});
