'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const dayOf=value=>value&&Number.isFinite(Date.parse(value))?new Date(Date.parse(value)+8*3600000).toISOString().slice(0,10):'';
const latest=(project,date)=>project.dailyHistory?.[date]?.at(-1);
function snapshot(project,date,{requirements,confirmations}={}){
  return clone({records:project.records.filter(row=>row.date===date),report:project.reports.find(row=>row.date===date)||null,
    requirements:requirements??project.requirements,confirmations:confirmations??project.requirementConfirmations??[],digest:project.dailyDesk?.days?.[date]?.digest||null});
}
function folder(store,project){return path.join(store.dataDir,'projects',project.id,'历史版本');}
function append(store,project,date,{reason='保存',value,legacy=false}={}){
  if(!validDate(date))throw new Error('历史日期无效');
  project.dailyHistory||={};const prior=latest(project,date),lastDay=Object.keys(project.dailyHistory).sort().at(-1);
  const data=value||snapshot(project,date,date<lastDay&&prior?{requirements:prior.requirements,confirmations:prior.confirmations}:{}),fingerprint=hash(data);
  if(prior?.fingerprint===fingerprint)return prior;
  const revision={id:crypto.randomUUID(),number:(prior?.number||0)+1,savedAt:new Date().toISOString(),reason,legacy,fingerprint,...data};
  const file=path.join(folder(store,project),date,revision.id+'.json');
  const envelope={version:1,projectId:project.id,date,revision};
  store._atomicWrite(file,JSON.stringify(envelope,null,2));
  const read=JSON.parse(fs.readFileSync(file,'utf8'));
  if(JSON.stringify(read)!==JSON.stringify(envelope))throw new Error('历史版本回读不一致，未确认保存成功。');
  (project.dailyHistory[date]||=[]).push(revision);return revision;
}
function validRevision(value){
  const {id,number,savedAt,reason,legacy,fingerprint,...data}=value||{};
  return typeof id==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(id)&&Number.isSafeInteger(number)&&number>0&&Number.isFinite(Date.parse(savedAt))
    &&Array.isArray(data.records)&&Array.isArray(data.requirements)&&Array.isArray(data.confirmations)&&hash(data)===fingerprint;
}
function reconcile(store,project){
  const base=folder(store,project);if(!fs.existsSync(base))return false;
  let changed=false;project.dailyHistory||={};
  for(const date of fs.readdirSync(base).filter(validDate)){
    const revisions=new Map((project.dailyHistory[date]||[]).map(row=>[row.id,row]));let added=false;
    for(const file of fs.readdirSync(path.join(base,date)).filter(file=>/^[a-zA-Z0-9-]+\.json$/.test(file))){
      if(revisions.has(file.slice(0,-5)))continue;
      const data=JSON.parse(fs.readFileSync(path.join(base,date,file),'utf8'));
      if(data.version!==1||data.projectId!==project.id||data.date!==date||file!==data.revision?.id+'.json'||!validRevision(data.revision))throw new Error('历史版本校验失败，请保留档案后恢复备份。');
      if(!revisions.has(data.revision.id)){revisions.set(data.revision.id,data.revision);added=true;}
    }
    if(!added)continue;
    project.dailyHistory[date]=[...revisions.values()].sort((a,b)=>a.number-b.number||a.savedAt.localeCompare(b.savedAt)||a.id.localeCompare(b.id));
    const saved=latest(project,date);
    project.records=[...project.records.filter(row=>row.date!==date),...clone(saved.records)];
    project.reports=[...project.reports.filter(row=>row.date!==date),...(saved.report?[clone(saved.report)]:[])];
    project.dailyDesk||={days:{}};project.dailyDesk.days||={};
    if(saved.digest)project.dailyDesk.days[date]={...project.dailyDesk.days[date],digest:clone(saved.digest)};
    changed=true;
  }
  if(changed){
    const day=Object.keys(project.dailyHistory).sort().at(-1),saved=latest(project,day);
    // A newer manual edit in the master archive must not be rolled back.
    for(const [field,rows] of [['requirements',saved.requirements],['requirementConfirmations',saved.confirmations]]){
      const byId=new Map((project[field]||[]).map(row=>[row.id,row]));
      for(const row of rows){const old=byId.get(row.id);if(!old||String(old.updatedAt||'')<=String(row.updatedAt||''))byId.set(row.id,clone(row));}
      project[field]=[...byId.values()];
    }
  }
  return changed;
}
function importLegacy(store,project){
  const base=path.join(store.dataDir,'projects',project.id);let changed=false;
  const work=path.join(base,'工作记录');
  if(fs.existsSync(work))for(const file of fs.readdirSync(work).filter(name=>/^\d{4}-\d{2}-\d{2}\.md$/.test(name))){
    const date=file.slice(0,10);if(!validDate(date)||project.records.some(row=>row.date===date)||project.codex?.summaryDismissals?.some(row=>row.date===date))continue;
    const full=path.join(work,file),text=fs.readFileSync(full,'utf8'),time=fs.statSync(full).mtime.toISOString();
    for(const section of text.split(/^## /m).slice(1)){
      const title=section.split(/\r?\n/)[0].trim(),fields={};
      for(const match of section.matchAll(/^- ([^：\r\n]+)：([\s\S]*?)(?=^- [^：\r\n]+：|$(?![\s\S]))/gm))fields[match[1]]=match[2].trim();
      const id=fields['编号'];if(!id||!title)continue;
      project.records.push({id,date,title,issueKey:'',cause:fields['原因']||'',action:fields['处理']||'',result:fields['结果']||'',status:['进行中','已完成','待验证','未解决'].includes(fields['状态'])?fields['状态']:'待验证',confirmed:fields['确认']==='已确认',
        sourceRef:fields['来源']||'',attachments:fields['附件']?fields['附件'].split('；'):[],cycleId:project.activeCycleId,manual:!id.startsWith('auto-'),autoGenerated:id.startsWith('auto-'),...(id.startsWith('auto-')?{managedBy:'codex-auto'}:{}),createdAt:time,updatedAt:time,recoveredFrom:'工作记录/'+file});changed=true;
    }
  }
  const reports=path.join(base,'日报');
  if(fs.existsSync(reports))for(const file of fs.readdirSync(reports).filter(name=>/^\d{4}-\d{2}-\d{2}\.md$/.test(name))){
    const date=file.slice(0,10);if(!validDate(date)||project.reports.some(row=>row.date===date))continue;
    const full=path.join(reports,file),text=fs.readFileSync(full,'utf8');if(!text.trim())continue;
    project.reports.push({id:crypto.randomUUID(),date,text,autoArchived:true,updatedAt:fs.statSync(full).mtime.toISOString(),path:full,recoveredFrom:'日报/'+file});changed=true;
  }
  return changed;
}
function migrate(store,project){
  importLegacy(store,project);
  const dates=[...new Set([...project.records.map(row=>row.date),...project.reports.map(row=>row.date),...Object.keys(project.dailyDesk?.days||{}).filter(date=>project.dailyDesk.days[date].organizedAt)])].filter(validDate).sort();
  for(const date of dates)if(!latest(project,date)){
    // Old archives do not contain past versions of an updated requirement.
    // Preserve only versions with a known date; never invent an earlier state.
    const asOf=rows=>(rows||[]).filter(row=>{const known=dayOf(row.sourceLastAt)||row.organizedDate||dayOf(row.createdAt);return !known||known<=date;});
    append(store,project,date,{reason:'旧档案保留',legacy:true,value:snapshot(project,date,{requirements:asOf(project.requirements),confirmations:asOf(project.requirementConfirmations)})});
  }
}
module.exports={append,reconcile,migrate,latest,snapshot,validRevision};
