import {esc,icon,visibleFiles,fileMatches,fileCategory,compareFiles} from './shared.js';
export const materialKey = item => `${item.kind||'原始资料'}/${item.relativePath||''}`.replace(/\/$/,'');
export const materialTagsMarkup = item => (item.tags||[]).length?`<div class="material-tags">${item.tags.map(tag=>`<button class="material-tag ${tag.inherited?'inherited':''}" data-material-tag="${esc(tag.label)}" title="${esc((tag.inherited?'来自目录 · ':'')+(tag.origin==='manual'?'人工标签':tag.origin==='user'?'用户明确介绍':'模型整理')+(tag.sourceAt?' · '+tag.sourceAt:'')+(tag.evidence?'\n'+tag.evidence:'')+(tag.sourceRef?'\n'+tag.sourceRef:''))}">${esc(tag.label)}${tag.inherited?'<span aria-label="来自目录">↳</span>':''}</button>`).join('')}</div>`:'';
export function materialBrowser(project,current,query='',group='',tag=''){
  const all=visibleFiles(project),folders=(project.folders||[]).filter(item=>!item.missing&&!item.displayIgnored),folderMap=new Map(folders.map(item=>[materialKey(item),item]));
  const defaultKey=folderMap.has('原始资料')?'原始资料':'';
  const key=current===undefined?defaultKey:current&&folderMap.has(current)?current:current===''?'':defaultKey;
  const searching=!!query.trim()||!!group||!!tag;
  const matches=item=>fileMatches(item,query)&&(!tag||(item.tags||[]).some(t=>t.label===tag));
  const matched=all.filter(item=>matches(item)&&(!group||fileCategory(item)===group)).sort((a,b)=>compareFiles(a,b,query));
  const direct=item=>{const parts=materialKey(item).split('/');parts.pop();return parts.join('/')===key;};
  const files=searching?matched:matched.filter(direct);
  const children=folders.filter(item=>searching?(!group&&matches(item)&&(!query.trim()||fileMatches(item,query))):direct(item)).sort((a,b)=>String(a.name).localeCompare(String(b.name),'zh-CN'));
  const tagLabels=[...new Set([...all,...folders].flatMap(item=>(item.tags||[]).map(t=>t.label)))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  const crumbs=[['','全部资料'],...key.split('/').filter(Boolean).map((name,i,parts)=>[parts.slice(0,i+1).join('/'),name])];
  const breadcrumbs=`<nav class="material-breadcrumbs" aria-label="资料目录">${crumbs.map(([value,label])=>`<button class="link-btn" data-material-folder="${esc(value)}">${esc(label)}</button>`).join('<span>/</span>')}${searching?'<span class="material-search-scope">· 当前项目全部资料</span>':''}</nav>`;
  return {key,all,files,folders:children,tagLabels,breadcrumbs,currentFolder:folderMap.get(key),searching};
}
export function folderMarkup(folder,compact=false){return `<article class="material-folder ${compact?'compact':''}" data-folder-target="${esc(folder.targetId)}"><div class="material-folder-main">${icon('files',compact?18:23)}<div><button class="file-name" data-material-folder="${esc(materialKey(folder))}">${esc(folder.root?folder.kind:folder.name)}</button>${materialTagsMarkup(folder)}${!compact?`<div class="small-text muted">${esc(folder.relativePath||folder.path||'')}</div>`:''}</div></div><div class="actions"><button class="btn small" data-action="material-folder-copy" data-target="${esc(folder.targetId)}">路径</button><button class="btn small" data-action="material-folder-open" data-target="${esc(folder.targetId)}">打开目录</button>${!compact?`<button class="btn small" data-action="material-edit-tags" data-target="${esc(folder.targetId)}">标签</button>`:''}</div></article>`;}
