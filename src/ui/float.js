import {esc,currentProject,icon,fileMatches,visibleFiles,fileCategory,compareFiles,fileSearchMarkup,notify,request,materialScanStatus} from './shared.js';
import {materialBrowser,materialTagsMarkup,folderMarkup} from './material-browser.js';
import {createMemoController} from './memo.js';
let state={projects:[],settings:{}},query='',group='',pinned=true,loadVersion=0;
const scans=new Map(),folders=new Map();let tag='',loadedProjectId='';
const $=id=>document.getElementById(id);
const memo=createMemoController();
$('pin').innerHTML=icon('pin',16);$('collapse').innerHTML=icon('ball',17);$('search-icon').innerHTML=icon('search',16);
async function load(){const version=++loadVersion,next=await request('state');if(version!==loadVersion)return;state=next;const p=currentProject(state);if(loadedProjectId&&loadedProjectId!==p?.id){query='';group='';tag='';$('float-search').value='';$('float-group').value='';}loadedProjectId=p?.id||'';$('float-project').innerHTML=state.projects?.length?state.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''):'<option value="">尚未关联项目</option>';if(p)$('float-project').value=p.id;renderFiles();renderScanStatus();await memo.setProject(p,state.dataDir||'');}
function renderScanStatus(){
  const p=currentProject(state),scan=scans.get(p?.id)||{},busy=!!scan.running,button=$('float-refresh');
  button.disabled=!p||busy;button.setAttribute('aria-busy',String(busy));button.innerHTML=icon('refresh',14)+(busy?'刷新中…':'刷新');
  const status=materialScanStatus(p,scan),label=$('float-scan-status');label.textContent=status.text;label.hidden=!status.warning;label.classList.toggle('warning',status.warning);button.title=status.text+'\n重新读取当前项目目录';
}
async function refreshMaterials(){
  const p=currentProject(state);if(!p||scans.get(p.id)?.running)return;
  scans.set(p.id,{running:true});renderScanStatus();
  try{const result=await request('project:scan',{id:p.id,force:true});await load();scans.delete(p.id);notify(result.scanWarning?'部分资料未更新，请检查关联目录':'资料已刷新',!!result.scanWarning);}
  catch(error){scans.set(p.id,{error:error.message||String(error)});throw error;}
  finally{renderScanStatus();}
}
function renderFiles(){const p=currentProject(state);if(!p){$('float-files').innerHTML=`<div class="float-empty">${icon('files',27)}先打开工作台，关联原始资料<br>和项目开发目录。</div>`;return;}
const browser=materialBrowser(p,folders.get(p.id),query,group,tag);folders.set(p.id,browser.key);$('float-location').innerHTML=browser.breadcrumbs+materialTagsMarkup(browser.currentFolder||{});$('float-tag').innerHTML='<option value="">全部标签</option>'+browser.tagLabels.map(t=>`<option ${t===tag?'selected':''}>${esc(t)}</option>`).join('');const matched=browser.files,files=matched.slice(0,browser.searching?80:18);$('float-files').setAttribute('aria-label',browser.searching?`检索结果 ${files.length} / ${matched.length} 份`:`当前目录 ${browser.folders.length+matched.length} 项`);
$('float-files').innerHTML=files.length?files.map(f=>`<article class="float-file"><div class="float-file-head"><span class="float-file-icon">${icon('file',17)}</span><div class="float-file-main"><button class="float-file-name" data-action="open" data-file="${esc(f.id)}" title="${esc(f.path)}">${esc(f.name)}</button><div class="float-file-desc" title="${esc(f.description||'')}">${esc(f.description||'尚未添加用途介绍')}</div>${materialTagsMarkup(f)}${fileSearchMarkup(f,query)}${f.missing?'<span class="float-file-missing">源文件不存在</span>':''}</div></div><div class="float-file-actions"><button class="btn small" data-action="copy-path" data-file="${esc(f.id)}">${icon('copy',11)}路径</button><button class="btn small" data-action="copy" data-file="${esc(f.id)}">复制文件</button><button class="btn small" data-action="reveal" data-file="${esc(f.id)}" aria-label="打开 ${esc(f.name)} 所在目录" title="在文件资源管理器中定位 ${esc(f.name)}">${icon('files',11)}打开目录</button><span class="float-kind">${esc(f.kind||'资料')}</span></div></article>`).join(''):`<div class="float-empty">${icon('search',25)}${query?'没有匹配资料，可用空格分开关键词或切换文件类别。':'暂无可展示资料，可刷新资料或在工作台调整展示设置。'}</div>`;if(browser.folders.length)$('float-files').innerHTML=browser.folders.map(folder=>folderMarkup(folder,true)).join('')+(files.length?$('float-files').innerHTML:'');}

async function run(fn,button){if(button)button.disabled=true;try{await fn();}catch(e){notify(e.message||String(e),true);}finally{if(button?.isConnected)button.disabled=false;}}
$('float-project').addEventListener('change',e=>{const id=e.target.value;run(async()=>{await memo.flushCurrent();await request('project:select',{id});query='';group='';tag='';$('float-group').value='';$('float-search').value='';await load();},e.currentTarget);});
function selectTab(name){memo.captureSelection();if(name==='files')void memo.flushCurrent();for(const tab of ['files','memo']){const selected=tab===name;$('float-tab-'+tab).setAttribute('aria-selected',String(selected));$('float-tab-'+tab).tabIndex=selected?0:-1;$('float-'+tab+'-panel').hidden=!selected;}}
for(const name of ['files','memo']){$('float-tab-'+name).addEventListener('click',()=>selectTab(name));$('float-tab-'+name).addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'files':event.key==='End'?'memo':name==='files'?'memo':'files';selectTab(next);$('float-tab-'+next).focus();}});}
$('float-tag').addEventListener('change',e=>{tag=e.target.value;renderFiles();});
document.addEventListener('click',e=>{const folder=e.target.closest('[data-material-folder]'),label=e.target.closest('[data-material-tag]'),action=e.target.closest('[data-target][data-action]');if(folder){folders.set(currentProject(state)?.id,folder.dataset.materialFolder);query='';group='';tag='';$('float-search').value='';$('float-group').value='';renderFiles();}else if(label){tag=label.dataset.materialTag;renderFiles();}else if(action){run(async()=>{await request(action.dataset.action==='material-folder-copy'?'material:folder-copy-path':'material:folder-open',{id:currentProject(state)?.id,targetId:action.dataset.target});},action);}});
$('float-group').addEventListener('change',e=>{group=e.target.value;renderFiles();});
$('float-search').addEventListener('input',e=>{query=e.target.value;renderFiles();});
$('pin').addEventListener('click',e=>run(async()=>{await request('window:pin',{pinned:!pinned});pinned=!pinned;$('pin').setAttribute('aria-pressed',String(pinned));},e.currentTarget));
$('collapse').addEventListener('click',e=>run(async()=>{await memo.flushCurrent();await request('window:ball');},e.currentTarget));
$('float-workbench').addEventListener('click',e=>run(async()=>{await memo.flushCurrent();await request('window:workbench');},e.currentTarget));
$('float-refresh').addEventListener('click',()=>run(refreshMaterials));
$('float-material').addEventListener('click',e=>run(async()=>{const p=currentProject(state);if(!p){await request('window:workbench');return;}const result=await request('file:add',{id:p.id,kind:'补充资料'});if(result){await load();notify('补充资料已收录');}},e.currentTarget));
document.addEventListener('click',e=>{const button=e.target.closest('[data-action][data-file]');if(!button||button.disabled)return;run(async()=>{const p=currentProject(state);const action=button.dataset.action;await request('file:'+action,{id:p.id,fileId:button.dataset.file});const messages={'copy':'文件已复制','copy-path':'路径已复制','reveal':'已打开文件所在目录'};if(messages[action])notify(messages[action]);},button);});
let timer;window.fde?.onChange(event=>{if(event?.memoUpdated){memo.changed(event.memoUpdated);return;}clearTimeout(timer);timer=setTimeout(()=>run(load),150);});
document.addEventListener('keydown',e=>{if(e.key==='Escape')run(async()=>{await memo.flushCurrent();await request('window:ball');});});
await run(load);
