import {createEasyClawRuntime,installHostPolicy} from './easyclaw-runtime.js';
import {SERVICE_ORIGIN} from './deployment.js';
installHostPolicy(document);
const gate=document.querySelector('#easyclaw-gate'),shell=document.querySelector('.app-shell'),message=document.querySelector('#access-message'),button=document.querySelector('#access-connect');
let started=false;
function locked(text){shell.hidden=true;gate.hidden=false;message.textContent=text;button.disabled=false;}
const runtime=createEasyClawRuntime(window,{onLocked:locked,serviceOrigin:SERVICE_ORIGIN});
window.fde=runtime;
async function open(login=false){
  button.disabled=true;message.textContent='正在验证账号并打开本地档案…';
  try{
    await runtime.connect({login});gate.hidden=true;shell.hidden=false;
    if(!started){await import('../client/src/ui/app.js');started=true;
      const compact=document.querySelector('#compact-button');compact.textContent='打开悬浮框';compact.title='打开独立悬浮窗口，EasyClaw 页面保留';
      document.querySelector('.shortcut-note').textContent='悬浮窗口受当前账号授权保护';
    }else window.dispatchEvent(new Event('fde-access-restored'));
  }catch(error){locked(error.message);}
}
button.addEventListener('click',()=>open(true));
if(window.easyclawAuth)void open();else locked('请从 EasyClaw 本地应用打开。普通浏览器不读取个人档案。');
window.addEventListener('pagehide',()=>runtime.dispose(),{once:true});
