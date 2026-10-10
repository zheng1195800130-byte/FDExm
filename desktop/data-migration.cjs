'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {resolveDataDirectory,inspectDataDirectory,findPortableExecutable}=require('./data-location.cjs');
const {identity}=require('../src/core/material-tags.cjs');
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const normalized=value=>path.resolve(value).replace(/\\/g,'/').toLowerCase().replace(/\/$/,'');

// Electron safeStorage on Windows also depends on Chromium's Local State.
// Keep this encryption context while excluding disposable browser caches.
const encryptionStates=['runtime/Local State','runtime/browser/Local State'];
function included(relative){
  const flat=relative.split(path.sep).join('/');
  return flat.split('/')[0]!=='runtime'||encryptionStates.some(file=>file===flat||file.startsWith(flat+'/'));
}
// Never follow links into unrelated directories.
function manifest(directory){
  const result={};
  function visit(current){
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink()||normalized(fs.realpathSync(current))!==normalized(current))throw new Error('数据迁移不接受链接目录或文件，请先检查数据目录');
    if(stat.isDirectory())for(const entry of fs.readdirSync(current).sort()){
      const full=path.join(current,entry),rel=path.relative(directory,full);
      if(included(rel))visit(full);
    }else if(stat.isFile())result[path.relative(directory,current)]=hash(fs.readFileSync(current));
    else throw new Error('数据目录包含不支持的文件类型');
  }
  visit(directory);return result;
}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function copyManagement(from,to){fs.cpSync(from,to,{recursive:true,errorOnExist:true,force:false,filter:file=>included(path.relative(from,file))});}
function rebaseManagement(directory,from,to){
  const oldPrefix=normalized(from),pathFields=new Set(['path','originalPath','managementDir','sourceRef','sourceRefs','sourceDir','devDir','artifactDir','dataDir','attachments']);
  const relocate=value=>{
    const flat=value.replace(/\\/g,'/'),lower=flat.toLowerCase();
    return lower===oldPrefix?to:lower.startsWith(oldPrefix+'/')?path.join(to,...flat.slice(oldPrefix.length+1).split('/')):value;
  };
  const ids=new Map();
  const documents=[];
  for(const relative of Object.keys(manifest(directory)).filter(name=>name.endsWith('.json'))){
    try{documents.push({relative,old:JSON.parse(fs.readFileSync(path.join(directory,relative),'utf8'))});}
    catch{const inspected=inspectDataDirectory(directory);if(['store.json','store.backup.json'].includes(relative)&&inspected.status!=='populated'&&inspected.primary!=='empty'&&inspected.backup!=='empty')throw new Error('旧档案损坏，已保留旧数据，请先恢复备份');}
  }
  for(const doc of documents)for(const project of doc.old?.projects||[]){
    for(const item of [...project.files||[],...project.folders||[],{kind:'补充资料',path:path.join(from,'projects',project.id,'supplements')}])if(item.path&&relocate(item.path)!==item.path)ids.set(identity(item.kind,item.path),identity(item.kind,relocate(item.path)));
  }
  const transform=(value,key='')=>{
    if(typeof value==='string')return key==='targetId'?(ids.get(value)||value):pathFields.has(key)?value.split('\n').map(relocate).join('\n'):value;
    if(Array.isArray(value))return value.map(item=>transform(item,key));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[relocate(k),transform(v,k)]));
    return value;
  };
  for(const doc of documents)doc.next=transform(doc.old);
  for(const doc of documents)for(let i=0;i<(doc.old?.projects||[]).length;i++){
    const old=doc.old.projects[i],next=doc.next.projects[i];
    for(let j=0;j<(old.files||[]).length;j++){
      const file=old.files[j],updated=next.files[j],checkpoints=next.dailyDesk?.fileCheckpoints;
      if(checkpoints?.[file.id]===hash([file.path,file.mtime,file.textPreview,file.description]))checkpoints[file.id]=hash([updated.path,updated.mtime,updated.textPreview,updated.description]);
    }
    for(const raw of documents){
      if(!Array.isArray(raw.old?.turns)||!raw.relative.startsWith(path.join('projects',old.id,'每日收录')+path.sep))continue;
      const processed=next.dailyDesk?.days?.[raw.old.date]?.processed;
      if(processed)raw.old.turns.forEach((turn,j)=>{if(processed[turn.id]===hash(turn))processed[turn.id]=hash(raw.next.turns[j]);});
    }
  }
  for(const doc of documents)if(!same(doc.old,doc.next))fs.writeFileSync(path.join(directory,doc.relative),JSON.stringify(doc.next,null,2));
}
function prepareDataDirectory(options={}){
  const env=options.env||process.env,target=resolveDataDirectory(options);
  if(typeof env.FDE_DATA_DIR==='string'&&env.FDE_DATA_DIR.trim())return target;
  // An existing unified archive is authoritative, including an unreadable one:
  // Store handles its recovery. Never replace it with an older installation.
  if(fs.existsSync(target)&&fs.readdirSync(target).some(name=>name!=='runtime'))return target;
  const candidates=[];
  if(options.root){candidates.push(path.join(options.root,'data'));const exe=findPortableExecutable(options);if(exe)candidates.push(path.join(path.dirname(exe),'data'));}
  if(options.isPackaged&&options.execPath)candidates.push(path.join(path.dirname(options.execPath),'data'));
  const seen=new Set(),available=[];
  for(const candidate of candidates){const key=normalized(candidate);if(seen.has(key)||key===normalized(target)||!fs.existsSync(candidate))continue;seen.add(key);const files=manifest(candidate),inspected=inspectDataDirectory(candidate),status=inspected.status==='unknown'&&(inspected.primary==='empty'||inspected.backup==='empty')?'empty':inspected.status;if(Object.keys(files).length)available.push({path:candidate,status,files});}
  const important=available.filter(item=>['populated','unknown'].includes(item.status));
  const choices=important.length?important:available;
  if(choices.length>1)throw new Error('发现多个旧数据目录，未自动合并；请用 FDE_DATA_DIR 指定要使用的目录，旧数据均已保留');
  if(!choices.length)return target;
  const source=choices[0];
  if(source.status==='unknown')throw new Error('旧数据无法确认完整性，未创建空档案；请先恢复旧目录中的 store 备份');
  const parent=path.dirname(target),stamp=Date.now()+'-'+randomUUID().slice(0,8),backup=path.join(parent,'backups','migration-'+stamp),stage=path.join(parent,'.migration-'+stamp);
  fs.mkdirSync(parent,{recursive:true});
  fs.mkdirSync(path.dirname(backup),{recursive:true});copyManagement(source.path,backup);
  if(!same(manifest(backup),source.files))throw new Error('迁移备份校验失败，旧数据未改动');
  copyManagement(source.path,stage);
  if(!same(manifest(stage),source.files)||!same(manifest(source.path),source.files))throw new Error('旧数据正在变化，请关闭其他 FDE 窗口后重试迁移；旧数据和备份均已保留');
  rebaseManagement(stage,source.path,target);
  if(fs.existsSync(target)){
    if(fs.readdirSync(target).length)throw new Error('目标数据目录已被其他程序创建，未覆盖；迁移副本和备份已保留');
    fs.rmdirSync(target);
  }
  fs.renameSync(stage,target);
  fs.writeFileSync(path.join(parent,'migration-'+stamp+'.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),from:source.path,to:target,backup,files:Object.keys(source.files).length,sourceHashes:source.files,targetHashes:manifest(target)},null,2));
  return target;
}
module.exports={prepareDataDirectory,manifest,rebaseManagement};
