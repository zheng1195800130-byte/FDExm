'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { requestJson, requiresApiKey } = require('./model-api.cjs');
const { groupCompletedTurns } = require('./summarizer.cjs');
const {targets,collectReferences,validateModelTags} = require('./material-tags.cjs');
const {presetPrompt} = require('./summary-preset.cjs');
const {materialOnly,organizedReport}=require('./daily-report.cjs');
const {conversationText,parts,confirmationPoints,fileEvidence}=require('./daily-evidence.cjs');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = (value, max = 2000) => String(value || '').replace(/\u0000/g, '').replace(/data:[^\s]+;base64,[a-z0-9+/=\r\n]+/gi, '[媒体内容省略]').replace(/[a-z0-9+/]{512,}={0,2}/gi, '[长编码省略]').trim().slice(0, max);
const localDate = time => new Date(new Date(time).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const yesterday = date => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) === date;
const sourceFiles = p => (p.files || []).filter(f => !f.hidden && !f.missing && !require('./files.cjs').isOfficeTemporaryFile(f.path||f.name||'') && ['原始资料', '补充资料'].includes(f.kind));
// Previous summaries are context, never a requirement to fabricate fresh evidence.
const priorContext = i => ({issueKey:i.issueKey,title:i.title,cause:clean(i.cause,100),action:clean(i.action,100),result:clean(i.result,140),status:i.status,relatedIssueKeys:i.relatedIssueKeys || [],sourceIds:[...new Set([...(i.sourceIds || []),...(i.turnIds || []).map(id=>`turn:${id}`)])]});
// Coalesce only explicit identities/known aliases after evidence validation.
// Equal titles, shared sources or belonging to the same project are not identity.
function mergeLinked(rows,key,related,existing=[]){
  const ids=row=>[row[key],...(row[related]||[])],groups=[];
  for(const row of rows){
    const keys=new Set(ids(row));let changed=true;
    while(changed){changed=false;for(const old of existing)if(ids(old).some(id=>keys.has(id)))for(const id of ids(old))if(!keys.has(id)){keys.add(id);changed=true;}}
    const matches=groups.filter(group=>[...group.keys].some(id=>keys.has(id)));
    const members=[...matches.flatMap(group=>group.rows),row];for(const group of matches)for(const id of group.keys)keys.add(id);
    for(const group of matches)groups.splice(groups.indexOf(group),1);groups.push({rows:members,keys});
  }
  const unique=values=>[...new Set(values.filter(Boolean))];
  return groups.map(group=>{
    const ordered=group.rows.map((row,index)=>({row,index})).sort((a,b)=>String(a.row.sourceLastAt||'').localeCompare(String(b.row.sourceLastAt||''))||a.index-b.index).map(i=>i.row),latest=ordered.at(-1);
    const stable=existing.find(row=>ids(row).some(id=>group.keys.has(id)))?.[key]||ordered[0][key];
    const times=unique(ordered.flatMap(row=>[row.sourceFirstAt,row.sourceLastAt])).sort();
    const merged={...latest,[key]:stable,[related]:[...group.keys].filter(id=>id!==stable),sourceIds:unique(ordered.flatMap(row=>row.sourceIds||[])),sourceRef:unique(ordered.flatMap(row=>(row.sourceRef||'').split('\n'))).join('\n').slice(0,4000),attachments:[...new Map(ordered.flatMap(row=>row.attachments||[]).map(a=>[JSON.stringify(a),a])).values()].slice(0,30),sourceFirstAt:times[0]||'',sourceLastAt:times.at(-1)||''};
    if(key==='requirementKey')merged.description=unique(ordered.map(row=>row.description)).join('；').slice(0,2000);
    if(key==='issueKey'){merged.action=unique(ordered.map(row=>row.action)).join('；').slice(0,800);merged.turnIds=unique(ordered.flatMap(row=>row.turnIds||[]));}
    if(key==='confirmationKey'){
      merged.requirementKeys=unique(ordered.flatMap(row=>row.requirementKeys||[]));
      // Contradictory conclusions with no later evidence must remain open.
      if(latest.status==='已解决'&&ordered.some(row=>row.status==='待确认'&&(!latest.sourceLastAt||!row.sourceLastAt||row.sourceLastAt===latest.sourceLastAt))){merged.status='待确认';merged.resolution='';}
    }
    return merged;
  });
}
function carryover(project, date) {
  const previous = yesterday(date), result = [];
  for (const item of project.records || []) if (item.date === previous && ['进行中','未解决','待验证'].includes(item.status)) {
    const later = (project.records || []).find(next => next.date > item.date && next.issueKey && next.issueKey === item.issueKey && next.status === '已完成');
    if (!later) result.push({ key: item.issueKey || item.id, type: '昨日工作', text: clean(`${item.title}：${item.result || item.action || '尚未完成'}`, 240), date: previous });
  }
  for (const item of project.requirementConfirmations || []) if (item.status !== '已解决') result.push({ key: item.confirmationKey || item.id, type: '待客户确认', text: clean(`${item.scenario}：${item.question}`,240), date: item.sourceLastAt ? localDate(item.sourceLastAt) : '' });
  for (const item of project.requirements || []) if (item.status!=='已完成') for (const question of item.questions || []) if (!result.some(r=>r.text.includes(question))) result.push({key:item.requirementKey || item.id,type:'需求待确认',text:clean(`${item.title}：${question}`,240),date:item.sourceLastAt?localDate(item.sourceLastAt):''});
  const blocker=project.blocker || project.dailyDesk?.overview?.blocker;
  if (blocker) result.unshift({ key: 'project-blocker', type: '项目卡点', text: clean(blocker,240), date: '' });
  return result.slice(0,30);
}
class DailyDesk {
  constructor({ store, reader, getModel, getRules = () => '', commit = fn => Promise.resolve().then(fn), notify = () => {}, now = () => new Date(), request = requestJson }) {
    Object.assign(this,{store,reader,getModel,getRules,commit,notify,now,request});
    this.captures = new Map(); this.runs = new Map(); this.stopped = false;
  }
  project(id) { return this.store.getState().projects.find(p => p.id === id); }
  file(id,date) { if (!validDate(date)) throw new Error('日期无效'); return path.join(this.store.projectFolder(id),'每日收录',`${date}.json`); }
  raw(id,date) { try { return JSON.parse(fs.readFileSync(this.file(id,date),'utf8')); } catch (e) { if (e.code === 'ENOENT') return { date, turns: [] }; throw new Error('本地每日收录损坏，请保留档案后恢复'); } }
  capture(id) {
    if (this.stopped) return Promise.resolve();
    if (this.captures.has(id)) { this.captures.get(id).dirty = true; return this.captures.get(id).promise; }
    const job = {dirty:false};
    job.promise = (async () => { do { job.dirty=false; await this.captureOnce(id); } while(job.dirty && !this.stopped); })().finally(()=>this.captures.delete(id));
    this.captures.set(id,job); return job.promise;
  }
  async captureOnce(id) {
    const project = this.project(id); if (!project || this.stopped) return;
    const date=localDate(this.now()), dates=[yesterday(date),date], threadId=project.codex?.threadId || '';
    for (const day of dates) {
      const read = threadId ? await this.reader.readThread({threadId,cwd:project.devDir,history:true,date:day}) : {turns:[]};
      if (this.stopped || this.project(id)?.codex?.threadId !== threadId) return;
      const prior=this.raw(id,day), same=prior.threadId === threadId;
      const byId=new Map((same?prior.turns:[]).map(t=>[t.id,t]));
      for (const turn of groupCompletedTurns(read.turns).get(day) || []) {
        const user=clean(turn.userText,12000),assistant=clean(turn.assistantText,16000);
        byId.set(turn.id,{id:turn.id,date:day,timestamp:turn.timestamp || '',userText:user,assistantText:assistant,sourceRef:clean(turn.sourceRef,4000),attachments:(turn.attachments || []).slice(0,20), shortened: user.length < String(turn.userText || '').length || assistant.length < String(turn.assistantText || '').length});
      }
      const turns=[...byId.values()].sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
      const raw={date:day,threadId,turns,partial:!!(read.workTruncated ?? read.truncated) || turns.some(t=>t.shortened)};
      const fingerprint=hash(raw), metadata=this.project(id).dailyDesk?.days?.[day];
      const unprocessedCount=turns.filter(t=>metadata?.processed?.[t.id] !== hash(t)).length+(metadata?.pendingFiles || 0);
      if (metadata?.fingerprint !== fingerprint || metadata?.unprocessedCount!==unprocessedCount || (day<date && !metadata?.archivedAt)) await this.commit(()=>{
        if (this.stopped || this.project(id)?.codex?.threadId !== threadId) return;
        if (prior.threadId && !same && prior.turns.length) this.store._atomicWrite(path.join(this.store.projectFolder(id),'每日收录','会话归档',hash(prior.threadId).slice(0,16),`${day}.json`),JSON.stringify(prior,null,2));
        this.store._atomicWrite(this.file(id,day),JSON.stringify(raw,null,2));
        this.store.saveDailyDesk(id,day,{fingerprint,threadId,count:turns.length,unprocessedCount,partial:raw.partial,...(metadata?.status==='running'&&!this.runs.has(id)?{status:'idle',message:'上次整理中断，可点击重试'}:{}),...(day<date?{archivedAt:this.now().toISOString()}:{}),capturedAt:this.now().toISOString()});
        this.notify({dailyCaptured:id,codexUpdated:id});
      });
    }
    const current={...this.project(id),managementDir:this.store.projectFolder(id)};
    const historyToken=hash(['material-tags-v1',threadId,targets(current).map(item=>item.id).sort()]);
    let materialTurns=[],historyReadFailed=false;
    if(threadId&&current.materialTagHistoryToken!==historyToken){
      // One bounded, local-only history read on first link or catalog changes. Never requests a model.
      let history;try{history=await this.reader.readThread({threadId,cwd:current.devDir,history:true});}catch{history={turns:[]};historyReadFailed=true;}
      if(this.stopped||this.project(id)?.codex?.threadId!==threadId)return;
      materialTurns=[...groupCompletedTurns(history.turns).values()].flat();
    }
    const allHints=[...(current.materialReferences||[]),...collectReferences(current,materialTurns),...dates.flatMap(day=>collectReferences(current,this.raw(id,day).threadId===threadId?this.raw(id,day).turns:[]))];
    const uniqueHints=[...new Map(allHints.map(h=>[`${h.targetId}:${h.turnId}:${h.evidence}`,h])).values()].sort((a,b)=>String(a.sourceAt).localeCompare(String(b.sourceAt))).slice(-200);
    await this.commit(()=>{if(!this.stopped&&this.project(id)?.codex?.threadId===threadId){const before=JSON.stringify([current.materialReferences,current.materialAnnotations,current.materialTagHistoryToken]);const saved=this.store.saveMaterialReferences(id,uniqueHints,historyReadFailed?current.materialTagHistoryToken:historyToken);if(before!==JSON.stringify([saved.materialReferences,saved.materialAnnotations,saved.materialTagHistoryToken]))this.notify({materialsUpdated:id});}this.rollover(id,date);});
  }
  rollover(id,date=localDate(this.now())) {
    const p=this.project(id); if (!p) return;
    for (const [day,value] of Object.entries(p.dailyDesk?.days || {})) if (day<date && (!value.closedAt || (value.organizedAt && value.archivedDigestAt!==value.organizedAt))) {
      // Archive locally only. A human-saved report always wins.
      if (!(p.reports || []).some(r=>r.date===day&&!r.autoArchived)) {
        const text=(value.digest || (p.records || []).some(r=>r.date===day)) && this.store.generateReport(id,day).text;
        if (text) this.store.saveReport(id,day,text,{automatic:true});
      }
      const archive={...value,closedAt:this.now().toISOString()};
      this.store._atomicWrite(path.join(this.store.projectFolder(id),'每日归档',`${day}.json`),JSON.stringify(archive,null,2));
      this.store.saveDailyDesk(id,day,{closedAt:archive.closedAt,archivedAt:value.archivedAt || archive.closedAt,archivedDigestAt:value.organizedAt || ''});
    }
  }
  async allCapture() { for (const p of this.store.getState().projects) await this.capture(p.id).catch(error=>this.notify({warning:`${p.name}：${error.message}`})); }
  run(id,date=localDate(this.now())) {
    if (!validDate(date)) return Promise.reject(new Error('日期无效'));
    if (this.runs.has(id)) return this.runs.get(id);
    const promise=this.organize(id,date).finally(()=>this.runs.delete(id)); this.runs.set(id,promise); return promise;
  }
  async organize(id,date) {
    await this.capture(id);
    let p=this.project(id); if (!p) throw new Error('项目不存在');
    const {config,apiKey}=this.getModel();
    if (!config.enabled || (requiresApiKey(config) && !apiKey)) throw new Error('请先配置并启用整理模型');
    const threadId=p.codex?.threadId || '',raw=this.raw(id,date),day=p.dailyDesk?.days?.[date] || {},processed=day.evidenceVersion===3?day.processed || {}:{},fileCheckpoints=p.dailyDesk?.fileCheckpoints || {};
    const sources=[],pending=[],nextProcessed={...processed},nextFiles={...fileCheckpoints},nextParts={...(day.evidenceVersion===3?day.sourceCheckpoints || {}:{})}; let budget=18000,shortened=false;
    const append=(source,fingerprint)=>{
      const checkpoint=hash([fingerprint,source.text]);
      if(nextParts[source.id]===checkpoint)return true;
      if(source.text.length>budget)return false;
      budget-=source.text.length;sources.push(source);nextParts[source.id]=checkpoint;return true;
    };
    // Explicit customer question sheets take priority over large background
    // directories. Their numbered questions remain independently traceable.
    const files=sourceFiles(p).sort((a,b)=>Number(confirmationPoints(b).length>0)-Number(confirmationPoints(a).length>0));
    const appendFile=file=>{
      const points=confirmationPoints(file),fingerprint=hash([file.path,file.mtime,file.textPreview,file.description,...(points.length?['questions-v3']:[])]);
      if(fileCheckpoints[file.id]===fingerprint)return;
      const chunks=fileEvidence(file,raw.turns),complete=chunks.map(source=>append(source,fingerprint)).every(Boolean);
      if(complete)nextFiles[file.id]=fingerprint;else{delete nextFiles[file.id];pending.push(`file:${file.id}`);}
    };
    for(const file of files.filter(file=>confirmationPoints(file).length))appendFile(file);
    // A large morning discussion must not starve the latest completion or
    // customer decision. Deferred evidence still has its own next-batch cursor.
    for (const turn of raw.threadId===threadId?[...raw.turns].reverse():[]) {
      const fingerprint=hash(turn); if (processed[turn.id]===fingerprint) continue;
      const text=`用户：${conversationText(turn.userText)}\nCodex：${turn.assistantText}`;
      const complete=parts(text).map((text,index)=>append({id:index?`turn:${turn.id}:part:${index+1}`:`turn:${turn.id}`,turnId:turn.id,timestamp:turn.timestamp,text,sourceRef:turn.sourceRef,attachments:turn.attachments},fingerprint)).every(Boolean);
      if(complete)nextProcessed[turn.id]=fingerprint;else pending.push(turn.id);
    }
    for(const file of files.filter(file=>!confirmationPoints(file).length))appendFile(file);
    shortened=pending.length>0;
    if (!sources.length) return {skipped:true,pending:pending.length,message:'没有新增内容，未调用模型'};
    const previous=p.dailyDesk?.overview || {};
    const previousItems=((p.codex?.dailySummaries || []).find(s=>s.date===date)?.items || []).filter(item=>!materialOnly(item));
    const materialReferences=[];let tagBudget=2400;
    for(const hint of [...p.materialReferences||[]].reverse()){
      if(hint.labels.length||!sources.some(source=>source.id===`turn:${hint.turnId}`))continue;
      const compact={targetId:hint.targetId,turnId:hint.turnId,evidence:clean(hint.evidence,500),labels:hint.labels,sourceAt:hint.sourceAt,sourceRef:clean(hint.sourceRef,400)};
      const size=JSON.stringify(compact).length;if(size>tagBudget)continue;tagBudget-=size;materialReferences.push(compact);if(materialReferences.length>=10)break;
    }
    const input={date,project:p.name,sources,previousOverview:previous,previousItems:previousItems.slice(-20).map(priorContext),
      materialReferences,
      requirements:(p.requirements || []).slice(-60).map(i=>({requirementKey:i.requirementKey,title:i.title,description:clean(i.description,120),relatedRequirementKeys:i.relatedRequirementKeys||[]})),
      confirmations:(p.requirementConfirmations || []).slice(-40).map(i=>({confirmationKey:i.confirmationKey,scenario:clean(i.scenario,120),question:clean(i.question,100),workaround:clean(i.workaround,100),status:i.status,relatedConfirmationKeys:i.relatedConfirmationKeys||[]})),carryover:carryover(p,date)};
    const schema='输出 JSON：{overview:{scene:"业务场景",requirements:"主要要求",progress:"已实现/正在处理",nextAction:"下一步",blocker:"阻塞"},items:[{issueKey,title,cause,action,result,status:"已完成|进行中|未解决|待验证",sourceIds:["本次来源编号"],relatedIssueKeys:[]}],requirements:[{requirementKey,title,description,status:"已明确|待确认",sourceIds:[],relatedRequirementKeys:[]}],confirmations:[{confirmationKey,scenario,question,workaround,status:"待确认|已解决",resolution,sourceIds:[],relatedConfirmationKeys:[],requirementKeys:[]}],materialTags:[{targetId,turnId,evidence:"与 materialReferences 完全相同的用户介绍",labels:["标签"]}],reportText:"简短 Markdown 日报",reportIssueKeys:["日报涵盖的全部当日工作编号"]}。materialTags可为空，仅引用materialReferences的目标与用户原话，标签须原话出现或引用已验证分类，不能根据Codex答复、正文、文件名推断；不要把工作任务名当成资料用途。items、requirements和confirmations只返回本次新增或更新事项；未涉及的旧事项由程序原样保留，不要重复输出。同一编号只输出一次，relatedIssueKeys、relatedRequirementKeys、relatedConfirmationKeys不能包含本项自身编号；同一业务多轮修改合成一项，已有编号或别名沿用，不按每轮问答拆条。延续旧工作时沿用issueKey或relatedIssueKeys，概括关联处理和最新结果，旧真实来源与附件由程序合回。每个新增或更新事项至少逐字引用sources中一个本次来源id，不使用文件名、路径、数字序号或自造编号代替。previousItems的来源只代表已整理上下文，不能单独证明新的变化。contextOnly=true的文件仅用于理解业务与需求，不能当作当天已分析、已开发或已交付的工作；items必须有当天对话证据。reportText只概括当天对话和previousItems的真实工作，不复述资料里的历史业务，不把修改时间当工作日期；reportIssueKeys列出日报涵盖的全部工作编号，包括previousItems；只新增资料时保持已有日报，当天没有工作留空。';
    await this.commit(()=>{this.store.saveDailyDesk(id,date,{status:'running',message:'正在整理当前日期的新增内容'});this.notify({dailyUpdated:id});});
    try {
      const output=await this.request(config,apiKey,[{role:'system',content:clean(this.getRules(),12000)+'\n以下为本次 FDE 简洁输出的优先约束：\n'+fs.readFileSync(path.join(__dirname,'daily-desk-rules.md'),'utf8')+presetPrompt(this.store.getState().settings.summaryPreset)+'\n'+schema},{role:'user',content:JSON.stringify(input)}],undefined,{maxTokens:sources.some(s=>s.confirmationPoint)?9000:4500});
      if(this.stopped || this.project(id)?.codex?.threadId!==threadId || this.project(id)?.sourceDir!==p.sourceDir || this.project(id)?.devDir!==p.devDir) throw new Error('项目关联已改变，已忽略旧整理结果');
      const result=validate(output,sources,previousItems,{requirements:p.requirements,confirmations:p.requirementConfirmations});
      const materialTags=validateModelTags(output.materialTags,input.materialReferences);
      await this.commit(()=>{
        if(this.stopped || this.project(id)?.codex?.threadId!==threadId) throw new Error('会话已变化');
        this.store.applyDailyDesk(id,{date,threadId,items:result.items,requirements:result.requirements,confirmations:result.confirmations,materialTags,digest:{overview:result.overview,reportText:organizedReport(p.name,result,output,{hasTurns:sources.some(s=>s.id.startsWith('turn:')),previousDigest:day.digest}),workEvidenceVersion:2},processed:nextProcessed,fileCheckpoints:nextFiles,sourceCheckpoints:nextParts,evidenceVersion:3,pendingFiles:pending.filter(id=>id.startsWith('file:')).length,pending:pending.length,partial:!!(raw.partial||shortened),fingerprint:hash(sources)});
        this.rollover(id);
        this.notify({dailyUpdated:id});
      });
      return {updated:true,pending:pending.length,partial:!!(raw.partial||shortened)};
    } catch(error) {
      const message=clean(error.message,240).replaceAll(apiKey || '\u0000','[密钥省略]');
      await this.commit(()=>{this.store.saveDailyDesk(id,date,{status:'error',message});this.notify({dailyUpdated:id});});throw new Error(message);
    }
  }
  async runAll(date=localDate(this.now())) {
    const results=[];
    for(const p of this.store.getState().projects) {try{results.push({id:p.id,name:p.name,...await this.run(p.id,date)});}catch(error){results.push({id:p.id,name:p.name,error:error.message});}}
    return {date,results};
  }
  stop(){this.stopped=true;}
}
function validate(output,sources,previousItems=[],existing={}) {
  if(!output || typeof output!=='object' || !output.overview || typeof output.overview!=='object' || typeof output.reportText!=='string' || output.reportText.length>5000) throw new Error('整理结果格式无效，原记录保留');
  const allowed=new Map(sources.map(s=>[s.id,s]));
  const list=(key,max=40)=>{if(!Array.isArray(output[key]) || output[key].length>max)throw new Error('整理清单格式无效');return output[key];};
  const field=(value,max,required=false)=>{if(typeof value!=='string' || value.length>max || (required&&!value.trim()))throw new Error('整理字段格式无效');return clean(value,max);};
  const keys=values=>{if(values===undefined)return [];if(!Array.isArray(values)||values.length>40||values.some(k=>typeof k!=='string'||!k||k.length>100))throw new Error('关联编号无效');return [...new Set(values)];};
  const evidence=(item,prior=[])=>{
    const oldIds=new Set(prior.flatMap(i=>priorContext(i).sourceIds));
    if(!Array.isArray(item.sourceIds)||!item.sourceIds.length||item.sourceIds.some(id=>typeof id!=='string'||(!allowed.has(id)&&!oldIds.has(id)))||!item.sourceIds.some(id=>allowed.has(id)))throw new Error('整理来源无效：模型未引用本次有效来源，原记录保留；可手动重试');
    const matched=[...new Set(item.sourceIds)].filter(id=>allowed.has(id)).map(id=>allowed.get(id)),times=[...matched.map(s=>s.timestamp),...prior.flatMap(i=>[i.sourceFirstAt,i.sourceLastAt])].filter(t=>t&&Number.isFinite(Date.parse(t))).sort();
    return {sourceIds:[...new Set([...item.sourceIds,...oldIds])],sourceRef:[...new Set([...prior.map(s=>s.sourceRef),...matched.map(s=>s.sourceRef)].filter(Boolean).flatMap(s=>s.split('\n')))].join('\n').slice(0,4000),attachments:[...new Map([...prior.flatMap(s=>s.attachments || []),...matched.flatMap(s=>s.attachments || [])].map(a=>[JSON.stringify(a),a])).values()].slice(0,30),sourceFirstAt:times[0] || '',sourceLastAt:times.at(-1) || ''};
  };
  const items=list('items').map(i=>{
    const issueKey=field(i.issueKey,100,true),relatedIssueKeys=keys(i.relatedIssueKeys),identities=new Set([issueKey,...relatedIssueKeys]);
    const prior=previousItems.filter(p=>[p.issueKey,...(p.relatedIssueKeys || [])].some(key=>identities.has(key)));
    const exact=prior.find(p=>p.issueKey===issueKey),context=exact&&priorContext(exact);
    // Some providers echo unchanged context despite the delta protocol. Restore the
    // validated original, including unshortened text, rather than rewriting it.
    if(context&&['title','action','result','status'].every(key=>i[key]===context[key])&&(i.cause===undefined||i.cause===context.cause)&&JSON.stringify(relatedIssueKeys)===JSON.stringify(context.relatedIssueKeys)&&(!i.sourceIds || Array.isArray(i.sourceIds)&&i.sourceIds.every(id=>context.sourceIds.includes(id))) )return exact;
    const origin=evidence(i,prior);
    if(!i.sourceIds.some(id=>allowed.has(id)&&!allowed.get(id).contextOnly))return null;
    return {...origin,issueKey,title:field(i.title,160,true),cause:field(i.cause || '',400),action:field(i.action || '',800),result:field(i.result || '',600),status:['已完成','进行中','未解决','待验证'].includes(i.status)?i.status:'进行中',relatedIssueKeys,turnIds:[...new Set(origin.sourceIds.filter(id=>id.startsWith('turn:')).map(id=>allowed.get(id)?.turnId || id.slice(5).replace(/:part:\d+$/,'')))]};
  }).filter(Boolean);
  const identities=new Set(items.flatMap(i=>[i.issueKey,...(i.relatedIssueKeys||[])]));
  for(const prior of previousItems)if(![prior.issueKey,...(prior.relatedIssueKeys || [])].some(key=>identities.has(key)))items.push(prior);
  const requirements=list('requirements').map(i=>({...evidence(i),requirementKey:field(i.requirementKey,100,true),title:field(i.title,160,true),description:field(i.description || '',1000),status:i.status==='待确认'?'待确认':'已明确',questions:[],relatedRequirementKeys:keys(i.relatedRequirementKeys)}));
  const confirmations=list('confirmations').map(i=>({...evidence(i),confirmationKey:field(i.confirmationKey,100,true),scenario:field(i.scenario,400,true),question:field(i.question,600,true),workaround:field(i.workaround || '',600),status:i.status==='已解决'?'已解决':'待确认',resolution:field(i.resolution || '',600),relatedConfirmationKeys:keys(i.relatedConfirmationKeys),requirementKeys:keys(i.requirementKeys)}));
  if(confirmations.some(i=>i.status==='已解决'&&!i.resolution))throw new Error('确认结果缺少结论');
  const points=new Map();for(const source of sources)if(source.confirmationPoint){const ids=points.get(source.confirmationPoint)||[];ids.push(source.id);points.set(source.confirmationPoint,ids);}
  for(const ids of points.values())if(!confirmations.some(item=>ids.some(id=>item.sourceIds.includes(id))))throw new Error('确认单存在未提炼的问题，原记录保留；请重试整理');
  const mergedConfirmations=mergeLinked(confirmations,'confirmationKey','relatedConfirmationKeys',existing.confirmations);
  for(const item of mergedConfirmations)if([...points.values()].filter(ids=>ids.some(id=>item.sourceIds.includes(id))).length>1)throw new Error('确认单不同编号问题被过度合并，原记录保留；请分别整理');
  return {items:mergeLinked(items,'issueKey','relatedIssueKeys',previousItems),requirements:mergeLinked(requirements,'requirementKey','relatedRequirementKeys',existing.requirements),confirmations:mergedConfirmations,overview:Object.fromEntries(['scene','requirements','progress','nextAction','blocker'].map(key=>[key,field(output.overview[key] || '',600)])),reportText:field(output.reportText,5000)};
}
module.exports={DailyDesk,localDate,yesterday,carryover,validate};
