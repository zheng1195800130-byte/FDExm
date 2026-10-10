'use strict';
const path=require('node:path'),{createHash}=require('node:crypto');
const canonical=value=>path.resolve(value).replace(/\\/g,'/').toLowerCase().replace(/\/$/,'');
const identity=(kind,value)=>'material-'+createHash('sha256').update(kind+':'+canonical(value)).digest('hex').slice(0,24);
function targets(project){
  const entries=[],seen=new Set(),add=item=>{const id=identity(item.kind,item.path);if(!seen.has(id)){seen.add(id);entries.push({...item,id});}};
  for(const file of project.files||[])if(!file.missing&&!file.hidden)add({...file,type:'file',fileId:file.id});
  for(const folder of project.folders||[]){const root=folder.kind==='原始资料'?project.sourceDir:folder.kind==='开发成果'?(project.indexArtifacts===false?'':project.artifactDir||project.devDir):project.managementDir&&path.join(project.managementDir,'supplements');if(!folder.missing&&root&&(canonical(folder.path)===canonical(root)||canonical(folder.path).startsWith(canonical(root)+'/')))add({...folder,type:'folder'});}
  for(const [kind,root]of [['原始资料',project.sourceDir],['开发成果',project.indexArtifacts===false?'':project.artifactDir||project.devDir],['补充资料',project.managementDir&&path.join(project.managementDir,'supplements')]])if(root)add({kind,path:root,name:path.basename(root),type:'folder',root:true});
  // Old indexes gain a folder hierarchy without a rescan; empty folders come from scan metadata.
  for(const file of [...entries].filter(item=>item.type==='file')){
    const root=file.kind==='原始资料'?project.sourceDir:file.kind==='开发成果'?project.artifactDir||project.devDir:project.managementDir&&path.join(project.managementDir,'supplements');
    if(!root)continue;let dir=path.dirname(file.path);let count=0;
    while(canonical(dir).startsWith(canonical(root)+'/')&&count++<32){add({kind:file.kind,path:dir,name:path.basename(dir),type:'folder'});dir=path.dirname(dir);}
  }
  return entries;
}
const vocabulary=[['需求资料',/需求资料|业务需求|需求文档|需求说明/],['会议纪要',/会议纪要|会议记录|会议文字|会议转录/],['导入模板',/导入.{0,12}模板|模板.{0,12}导入/],['数据样例',/样例|示例数据|样本|测试数据/],['业务规则',/业务规则|配载规则|判定规则|规则说明/],['测试反馈',/测试反馈|测试结果|问题反馈/],['交付说明',/交付说明|使用说明|操作手册/],['接口资料',/接口文档|接口说明|API\s*文档/i],['客户资料',/(客户|用户).{0,8}提供/]];
function resolveReference(catalog,text){
  const normalized=text.replace(/\\/g,'/').toLowerCase();
  let exact=catalog.filter(item=>[item.path,item.originalPath].filter(Boolean).some(p=>normalized.includes(p.replace(/\\/g,'/').toLowerCase())&&normalized.split(p.replace(/\\/g,'/').toLowerCase()).slice(1).some(t=>!t||!/^[/\w.\u3400-\u9fff（(]/.test(t))));
  exact=exact.filter(a=>!exact.some(b=>a!==b&&canonical(b.path).startsWith(canonical(a.path)+'/')));
  if(exact.length)return exact.length===1?exact[0]:null;
  // Only a unique full filename or folder name is accepted; repeated names are ambiguous.
  const named=catalog.filter(item=>item.name&&text.toLowerCase().includes(item.name.toLowerCase())&&(item.type==='file'||/目录|文件夹/.test(text)));
  return named.length===1?named[0]:null;
}
function collectReferences(project,turns){
  const catalog=targets(project),hints=[];
  for(const turn of turns){
    for(const paragraph of String(turn.userText||'').split(/\n\s*\n/)){
      if(paragraph.length>2200||/[？?]|是否|是不是|是什么|不是|并非|不属于/.test(paragraph)||!/这是|这些是|是|用于|用来|作为|里面|里是|存放|提供的|保存|属于|标记|改为/.test(paragraph))continue;
      let target=resolveReference(catalog,paragraph);
      if(!target&&String(turn.userText||'').split(/\n\s*\n/).length===1){const attached=(turn.attachments||[]).map(a=>a?.path).filter(Boolean);if(attached.length===1)target=resolveReference(catalog,attached[0]);}
      if(!target)continue;
      // Strip names and paths before classification: a filename alone is not evidence of its purpose.
      let context=paragraph.replace(/\\/g,'/');for(const value of [target.path,target.originalPath,target.name].filter(Boolean)){const needle=value.replace(/\\/g,'/').toLowerCase();let index=context.toLowerCase().indexOf(needle);while(index>=0){context=context.slice(0,index)+context.slice(index+needle.length);index=context.toLowerCase().indexOf(needle);}}
      const labels=vocabulary.filter(([,pattern])=>pattern.test(context)).map(([label])=>label);
      hints.push({targetId:target.id,path:target.path,kind:target.kind,type:target.type,labels,evidence:paragraph.trim().slice(0,2200),sourceRef:turn.sourceRef||'',sourceAt:turn.timestamp||'',turnId:turn.id});
    }
  }
  return hints.sort((a,b)=>String(a.sourceAt).localeCompare(String(b.sourceAt))).slice(-200);
}
function mergeAnnotations(project,updates,origin='user'){
  const catalog=new Map(targets(project).map(item=>[item.id,item]));project.materialAnnotations||={};let changed=false;
  for(const update of updates){const target=catalog.get(update.targetId);if(!target)continue;const key=canonical(target.path),prior=project.materialAnnotations[key];if(prior?.manual&&origin!=='manual')continue;
    if(origin!=='manual'&&prior?.sourceAt&&(!update.sourceAt||update.sourceAt<prior.sourceAt))continue;
    if(origin==='model'&&prior?.origin==='user')continue;
    const tags=[...new Set((update.labels||[]).filter(label=>typeof label==='string'&&label.trim()&&label.trim().length<=24).map(label=>label.trim()))].slice(0,8);
    if(!tags.length&&origin!=='manual')continue;
    const value={tags,manual:origin==='manual',origin,evidence:String(update.evidence||'').slice(0,2200),sourceRef:String(update.sourceRef||'').slice(0,4000),sourceAt:update.sourceAt||''};
    if(JSON.stringify(value)!==JSON.stringify(prior)){project.materialAnnotations[key]=value;changed=true;}
  }return changed;
}
function annotated(project,item){
  const own=project.materialAnnotations?.[canonical(item.path)],parents=Object.entries(project.materialAnnotations||{}).filter(([key])=>canonical(item.path).startsWith(key+'/')).sort((a,b)=>b[0].length-a[0].length);
  const entries=[...(own?[{...own,inherited:false}]:[]),...parents.map(([key,value])=>({...value,inherited:true,fromPath:key}))],tags=[];
  for(const entry of entries)for(const label of entry.tags||[])if(!tags.some(tag=>tag.label===label))tags.push({label,origin:entry.origin,inherited:entry.inherited,sourceRef:entry.sourceRef,sourceAt:entry.sourceAt,evidence:entry.evidence,fromPath:entry.fromPath||''});
  return {...item,tags:tags.slice(0,12),ownTags:own?.tags||[],tagsManual:!!own?.manual};
}
function validateModelTags(output,hints){
  if(!Array.isArray(output))return [];
  const result=[];
  for(const item of output.slice(0,30)){
    if(!item||typeof item.targetId!=='string'||typeof item.evidence!=='string'||!Array.isArray(item.labels))continue;
    const hint=hints.find(h=>h.targetId===item.targetId&&h.evidence===item.evidence&&h.turnId===item.turnId);if(!hint)continue;
    // Model labels must literally occur in the user's introduction or be a verified local category.
    const labels=item.labels.filter(label=>typeof label==='string'&&label.trim().length>=2&&label.trim().length<=24&&!['文件','目录','资料','这是','用于','项目','工作','处理','Codex','用户'].includes(label.trim())&&(hint.evidence.includes(label.trim())||hint.labels.includes(label.trim())));
    if(labels.length)result.push({...hint,labels});
  }return result;
}
module.exports={targets,identity,canonical,collectReferences,mergeAnnotations,annotated,validateModelTags};
