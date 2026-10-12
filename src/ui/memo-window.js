import {notify,request} from './shared.js';
import {createMemoController} from './memo.js';

const memo=createMemoController();
let closing=false,projectId='',initialized=false;
async function load(){
  const context=await request('window:memo-context');
  projectId=context.project.id;
  document.getElementById('memo-project-name').textContent=context.project.name;
  document.title=`备忘录 · ${context.project.name}`;
  await memo.setProject(context.project,context.dataDir);
  if(!initialized){initialized=true;memo.setView(context.view);}
}
async function close(){
  if(closing)return;closing=true;
  const button=document.getElementById('memo-collapse');button.disabled=true;
  try{
    if(!await memo.flushCurrent())throw new Error('备忘录尚未保存，请重试保存后关闭');
    await request('window:memo-close');
  }catch(error){notify(error.message||String(error),true);closing=false;button.disabled=false;}
}
document.getElementById('memo-collapse').addEventListener('click',close);
window.fde.onChange(event=>{
  if(event?.memoCloseRequested){void close();return;}
  if(event?.memoUpdated){if(event.memoUpdated===projectId)memo.changed(projectId);return;}
  void load().catch(error=>notify(error.message||String(error),true));
});
await load().catch(error=>notify(error.message||String(error),true));
