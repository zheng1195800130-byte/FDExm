import {esc,notify,request} from './shared.js';
import {renderMarkdown} from './markdown.js';

const MAX_TEXT=200000,MAX_IMAGE=20*1024*1024,MAX_IMAGES=50;
const $=id=>document.getElementById(id);
const message=error=>error?.message||String(error);

// Each project has its own save queue and crash-recovery draft. Background
// updates change metadata without replacing text being edited in this window.
export function createMemoController(){
  const entries=new Map();let activeKey='',imageSignature='',previewRunning=0,view='edit',markdownSignature='';
  const previewQueue=[];
  const active=()=>entries.get(activeKey);
  const isActive=entry=>!!entry&&entry.key===activeKey;
  const enqueue=(entry,fn)=>{const task=entry.queue.then(fn,fn);entry.queue=task.catch(()=>{});return task;};
  const draftKey=entry=>`fde:memo-draft:v1:${entry.dataDir}:${entry.id}`;
  function rememberDraft(entry){
    try{localStorage.setItem(draftKey(entry),JSON.stringify({text:entry.text,baseRevision:entry.memo.revision,conflict:!!entry.conflict,updatedAt:new Date().toISOString()}));entry.draftWarning='';}
    catch{entry.draftWarning='临时草稿未保存，请留意自动保存状态';}
  }
  function clearDraft(entry){try{localStorage.removeItem(draftKey(entry));entry.draftWarning='';}catch{}}
  function createEntry(id,dataDir){
    const entry={id,dataDir,key:JSON.stringify([dataDir,id]),text:'',memo:{text:'',revision:0,images:[]},loaded:false,loading:false,dirty:false,saving:false,error:'',draftWarning:'',queue:Promise.resolve(),flushTask:null,timer:null,editVersion:0,operationCount:0,previews:new Map(),selectionStart:0,selectionEnd:0};
    try{const draft=JSON.parse(localStorage.getItem(draftKey(entry))||'null');if(typeof draft?.text==='string'&&draft.text.length<=MAX_TEXT){entry.text=draft.text;entry.dirty=true;entry.restoredDraft=draft;}}
    catch{}
    entries.set(entry.key,entry);return entry;
  }
  function captureSelection(entry=active()){
    if(!entry||!isActive(entry))return;
    entry.selectionStart=$('memo-text').selectionStart;entry.selectionEnd=$('memo-text').selectionEnd;
  }
  function acceptMemo(entry,memo){
    if(!memo||typeof memo.text!=='string'||!Array.isArray(memo.images))throw new Error('备忘录数据读取失败，请重试');
    entry.memo=memo;entry.loaded=true;if(!entry.dirty)entry.text=memo.text;
    const ids=new Set(memo.images.map(image=>image.id));for(const id of entry.previews.keys())if(!ids.has(id))entry.previews.delete(id);
  }
  function renderStatus(entry=active()){
    if(!isActive(entry))return;
    const status=$('memo-save-status');
    let text=entry.saving?'正在保存…':entry.error?`保存失败：${entry.error}`:entry.loading?'正在读取备忘录…':entry.operationCount?'正在处理图片…':entry.dirty?'待保存':entry.loaded?`已保存${entry.memo.updatedAt?' '+new Date(entry.memo.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):''}`:'正在读取备忘录…';
    if(entry.draftWarning&&!entry.error)text+=' · '+entry.draftWarning;
    if(entry.memo.warning&&!entry.error)text+=' · '+entry.memo.warning;
    status.textContent=text;status.classList.toggle('error',!!entry.error);status.setAttribute('aria-live',entry.error?'assertive':'polite');
    $('memo-text').disabled=!entry.loaded;$('memo-text').setAttribute('aria-invalid',String(!!entry.error));
    $('memo-count').textContent=entry.text.length.toLocaleString('en-US')+' / 200,000';
    $('memo-retry').hidden=!entry.error;$('memo-retry').disabled=entry.saving||entry.loading;
    const busy=!entry.loaded||!!entry.operationCount;
    $('memo-paste').disabled=busy;$('memo-add-images').disabled=busy||entry.memo.images.length>=MAX_IMAGES;$('memo-copy-text').disabled=!entry.loaded||!entry.text;
    if($('memo-expand'))$('memo-expand').disabled=!entry.loaded;
  }
  function render(entry=active(),replaceText=false){
    if(!isActive(entry))return;
    const editor=$('memo-text');
    if(replaceText||(!entry.dirty&&editor.value!==entry.text)){
      const start=replaceText?entry.selectionStart:editor.selectionStart,end=replaceText?entry.selectionEnd:editor.selectionEnd;
      editor.value=entry.text;editor.setSelectionRange(Math.min(start,entry.text.length),Math.min(end,entry.text.length));
    }
    renderStatus(entry);renderImages(entry);renderPreview(entry);
  }
  function renderPreview(entry=active()){
    if(view!=='preview'||!isActive(entry))return;
    const signature=JSON.stringify([entry.key,entry.text]);if(signature===markdownSignature)return;markdownSignature=signature;
    $('memo-preview').innerHTML=entry.text.trim()?renderMarkdown(entry.text):'<p class="memo-preview-empty">暂无内容，点击“编辑”开始记录。</p>';
  }
  function setView(next){
    captureSelection();view=next==='preview'?'preview':'edit';
    $('memo-text').hidden=view==='preview';$('memo-preview').hidden=view!=='preview';
    for(const name of ['edit','preview']){$('memo-mode-'+name).setAttribute('aria-pressed',String(view===name));}
    renderPreview();
  }
  async function readEntry(entry){
    entry.loading=true;renderStatus(entry);
    try{
      const memo=await request('memo:get',{id:entry.id});
      if(entry.loaded&&entry.dirty&&memo.revision!==entry.memo.revision&&memo.text!==entry.memo.text&&memo.text!==entry.text){entry.conflict=true;entry.error='备忘录已在其他窗口更新；当前草稿已保留，请核对后重试保存';}
      acceptMemo(entry,memo);
      if(entry.restoredDraft){
        const draft=entry.restoredDraft;delete entry.restoredDraft;
        if(entry.text===memo.text){entry.dirty=false;clearDraft(entry);}
        else if(draft.conflict||draft.baseRevision!==memo.revision){entry.conflict=true;entry.error='已恢复未保存草稿；备忘录有更新，请核对后重试保存';}
        else scheduleSave(entry);
      }
      if(entry.conflict&&entry.dirty)rememberDraft(entry);
    }catch(error){entry.error=message(error);}
    finally{entry.loading=false;render(entry);}
  }
  async function saveOnce(entry){
    if(!entry.loaded){await readEntry(entry);if(!entry.loaded)return false;}
    if(!entry.dirty){entry.error='';renderStatus(entry);return true;}
    if(entry.conflict){renderStatus(entry);return false;}
    // Avoid writing an unchanged draft, including a recovered crash draft.
    if(entry.text===entry.memo.text){entry.dirty=false;entry.error='';clearDraft(entry);renderStatus(entry);return true;}
    const text=entry.text,version=entry.editVersion;entry.saving=true;entry.error='';renderStatus(entry);
    try{
      const memo=await request('memo:save',{id:entry.id,text,expectedRevision:entry.memo.revision});acceptMemo(entry,memo);
      if(entry.editVersion===version&&entry.text===text){entry.dirty=false;entry.text=memo.text;clearDraft(entry);}else rememberDraft(entry);
      return true;
    }catch(error){
      entry.error=message(error);
      if(/备忘录.*更新/.test(entry.error)){entry.conflict=true;try{acceptMemo(entry,await request('memo:get',{id:entry.id}));}catch{}}
      rememberDraft(entry);return false;
    }finally{entry.saving=false;render(entry);}
  }
  function flushEntry(entry){
    if(!entry)return Promise.resolve(true);clearTimeout(entry.timer);
    if(entry.flushTask)return entry.flushTask;
    entry.flushTask=(async()=>{do{if(!await enqueue(entry,()=>saveOnce(entry)))return false;}while(entry.dirty);return true;})().catch(error=>{entry.error=message(error);renderStatus(entry);return false;}).finally(()=>{entry.flushTask=null;});
    return entry.flushTask;
  }
  function scheduleSave(entry){clearTimeout(entry.timer);entry.timer=setTimeout(()=>{void flushEntry(entry);},700);}
  function updateText(entry,text,start,end){
    entry.text=text;entry.editVersion++;entry.dirty=true;if(!entry.conflict)entry.error='';entry.selectionStart=start;entry.selectionEnd=end;rememberDraft(entry);
    if(isActive(entry)){$('memo-text').value=text;$('memo-text').setSelectionRange(start,end);renderStatus(entry);}
    renderPreview(entry);
    scheduleSave(entry);
  }
  function insertText(entry,text,selection){
    if(!text)return;
    const start=Math.min(selection?.start??entry.selectionStart,entry.text.length),end=Math.min(selection?.end??entry.selectionEnd,entry.text.length);
    const next=entry.text.slice(0,start)+text+entry.text.slice(end);
    if(next.length>MAX_TEXT)throw new Error('备忘录最多保存 200,000 个字符，请缩短粘贴内容');
    updateText(entry,next,start+text.length,start+text.length);
  }
  async function imageOperation(entry,operation){
    if(!entry||!entry.loaded)return;
    if(!await flushEntry(entry)){if(isActive(entry))notify('文字尚未保存，请先重试保存',true);return;}
    entry.operationCount++;render(entry);
    try{return await enqueue(entry,async()=>{const value=await operation();const memo=value?.memo||(typeof value?.text==='string'&&Array.isArray(value?.images)?value:null);if(memo)acceptMemo(entry,memo);entry.error='';render(entry);return value;});}
    catch(error){entry.error=message(error);renderStatus(entry);if(isActive(entry))notify(entry.error,true);return;}
    finally{entry.operationCount--;render(entry);}
  }
  async function addFiles(entry,files){
    const images=files.filter(file=>file?.type?.startsWith('image/'));
    if(!images.length)return;
    if(images.some(file=>file.size>MAX_IMAGE)){notify('每张图片不能超过 20 MiB',true);return;}
    if(entry.memo.images.length+images.length>MAX_IMAGES){notify('每个项目最多保存 50 张图片',true);return;}
    for(const file of images)await imageOperation(entry,async()=>request('memo:add-image',{id:entry.id,bytes:new Uint8Array(await file.arrayBuffer()),name:file.name||'截图.png'}));
  }
  const observer=new IntersectionObserver(items=>{for(const item of items)if(item.isIntersecting){observer.unobserve(item.target);const entry=entries.get(item.target.dataset.memoKey);if(entry)queuePreview(entry,item.target.dataset.image);}}, {root:$('memo-images'),rootMargin:'40px'});
  function queuePreview(entry,imageId){
    if(entry.previews.has(imageId))return;entry.previews.set(imageId,{status:'loading'});previewQueue.push({entry,imageId});pumpPreviews();
  }
  function pumpPreviews(){
    while(previewRunning<2&&previewQueue.length){
      const {entry,imageId}=previewQueue.shift();previewRunning++;
      request('memo:preview',{id:entry.id,imageId}).then(value=>{
        if(!/^data:image\/(?:png|jpeg|webp|gif|bmp);base64,/i.test(value?.dataUrl||''))throw new Error('图片预览格式不支持');
        if(entry.memo.images.some(image=>image.id===imageId))entry.previews.set(imageId,{status:'ready',dataUrl:value.dataUrl});
      }).catch(()=>{if(entry.memo.images.some(image=>image.id===imageId))entry.previews.set(imageId,{status:'error'});}).finally(()=>{previewRunning--;renderImages(entry);pumpPreviews();});
    }
  }
  function renderImages(entry){
    if(!isActive(entry))return;
    const signature=JSON.stringify([activeKey,entry.operationCount,entry.memo.images.map(image=>[image.id,image.name,entry.previews.get(image.id)?.status])]);
    if(signature===imageSignature)return;imageSignature=signature;observer.disconnect();
    $('memo-images').innerHTML=entry.memo.images.length?entry.memo.images.map(image=>{
      const preview=entry.previews.get(image.id),disabled=entry.operationCount?' disabled':'';
      return `<article class="memo-image-card" data-image="${esc(image.id)}" data-memo-key="${esc(entry.key)}"><div class="memo-image-name" title="${esc(image.name)}">${esc(image.name)}</div>${preview?.status==='ready'?`<img class="memo-image-preview" src="${esc(preview.dataUrl)}" alt="${esc(image.name)}" loading="lazy">`:`<div class="memo-image-placeholder">${preview?.status==='error'?'预览暂不可用':'正在读取图片…'}</div>`}<div class="memo-image-actions"><button class="btn small" data-memo-action="copy-image" data-image="${esc(image.id)}"${disabled}>复制图片</button><button class="btn small" data-memo-action="reveal-image" data-image="${esc(image.id)}"${disabled}>打开目录</button><button class="link-btn" data-memo-action="remove-image" data-image="${esc(image.id)}"${disabled}>移除</button></div></article>`;
    }).join(''):'<div class="memo-image-empty">截图和图片会保存在这里</div>';
    for(const card of $('memo-images').querySelectorAll('.memo-image-card'))if(!entry.previews.has(card.dataset.image))observer.observe(card);
  }
  $('memo-text').addEventListener('input',()=>{const entry=active();if(!entry?.loaded)return;const editor=$('memo-text');entry.text=editor.value;entry.editVersion++;entry.dirty=true;if(!entry.conflict)entry.error='';captureSelection(entry);rememberDraft(entry);renderStatus(entry);scheduleSave(entry);});
  for(const type of ['select','keyup','click','blur'])$('memo-text').addEventListener(type,()=>captureSelection());
  $('memo-text').addEventListener('paste',event=>{
    const entry=active();if(!entry?.loaded)return;
    const files=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean),text=event.clipboardData?.getData('text/plain')||'';
    if(!text&&!files.length)return;event.preventDefault();captureSelection(entry);
    try{insertText(entry,text);}catch(error){notify(message(error),true);}
    void addFiles(entry,files);
  });
  $('memo-paste').addEventListener('mousedown',()=>captureSelection());
  $('memo-paste').addEventListener('click',async()=>{
    const entry=active();if(!entry)return;const selection={start:entry.selectionStart,end:entry.selectionEnd};
    const value=await imageOperation(entry,()=>request('memo:paste',{id:entry.id}));
    if(value?.text)try{insertText(entry,value.text,selection);}catch(error){notify(message(error),true);}
    if(isActive(entry))$('memo-text').focus();
  });
  $('memo-add-images').addEventListener('click',()=>{const entry=active();if(entry)void imageOperation(entry,()=>request('memo:add-images',{id:entry.id}));});
  $('memo-copy-text').addEventListener('click',async()=>{const entry=active();if(!entry)return;try{await request('memo:copy-text',{id:entry.id,text:entry.text});if(isActive(entry))notify('文字已复制');}catch(error){notify(message(error),true);}});
  $('memo-retry').addEventListener('click',()=>{const entry=active();if(entry){entry.conflict=false;void flushEntry(entry);}});
  for(const name of ['edit','preview'])$('memo-mode-'+name).addEventListener('click',()=>{setView(name);if(name==='edit')$('memo-text').focus();});
  async function openMarkdownLink(event){
    const link=event.target.closest('a');if(!link)return;event.preventDefault();
    if(event.type==='auxclick'&&event.button!==1)return;
    const url=link.getAttribute('href');if(url)try{await request('link:open',{url});}catch(error){notify(message(error),true);}
  }
  $('memo-preview').addEventListener('click',openMarkdownLink);$('memo-preview').addEventListener('auxclick',openMarkdownLink);
  $('memo-images').addEventListener('click',async event=>{
    const button=event.target.closest('[data-memo-action][data-image]'),entry=active();if(!button||button.disabled||!entry)return;
    const imageId=button.dataset.image,action=button.dataset.memoAction;
    if(action==='remove-image'){await imageOperation(entry,()=>request('memo:remove-image',{id:entry.id,imageId}));return;}
    button.disabled=true;
    try{await request('memo:'+action,{id:entry.id,imageId});if(isActive(entry))notify(action==='copy-image'?'图片已复制':'已打开图片所在目录');}
    catch(error){notify(message(error),true);}finally{if(button.isConnected)button.disabled=false;}
  });
  $('float-memo-panel').addEventListener('dragover',event=>{if([...event.dataTransfer?.types||[]].includes('Files')){event.preventDefault();$('float-memo-panel').classList.add('memo-dragover');}});
  $('float-memo-panel').addEventListener('dragleave',()=>{$('float-memo-panel').classList.remove('memo-dragover');});
  $('float-memo-panel').addEventListener('drop',event=>{event.preventDefault();$('float-memo-panel').classList.remove('memo-dragover');const entry=active();if(entry?.loaded)void addFiles(entry,[...(event.dataTransfer?.files||[])]);});
  window.addEventListener('blur',()=>{captureSelection();void flushEntry(active());});
  window.addEventListener('beforeunload',()=>{for(const entry of entries.values())if(entry.dirty)rememberDraft(entry);});
  return {
    async setProject(project,dataDir=''){
      const key=project?JSON.stringify([dataDir,project.id]):'';if(key===activeKey)return;
      captureSelection();void flushEntry(active());activeKey=key;imageSignature='';markdownSignature='';$('memo-preview').innerHTML='';
      if(!project){$('memo-text').value='';$('memo-text').disabled=true;$('memo-save-status').textContent='先关联项目，再使用备忘录';$('memo-save-status').classList.remove('error');$('memo-count').textContent='0 / 200,000';$('memo-retry').hidden=true;for(const id of ['memo-paste','memo-add-images','memo-copy-text','memo-expand'])if($(id))$(id).disabled=true;$('memo-images').innerHTML='<div class="memo-image-empty">截图和图片会保存在这里</div>';return;}
      const entry=entries.get(key)||createEntry(project.id,dataDir);render(entry,true);
      if(!entry.loaded&&!entry.loading)await enqueue(entry,()=>readEntry(entry));
    },
    changed(projectId){for(const entry of entries.values())if(entry.id===projectId&&entry.loaded)void enqueue(entry,()=>readEntry(entry));},
    flushCurrent:()=>flushEntry(active()),captureSelection,setView,getView:()=>view,
  };
}
