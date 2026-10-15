export const SERVICE_ORIGIN='http://127.0.0.1:35639';
function dataOf(response){
  let value=response?.body??response?.data??response;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw new Error('本地服务返回了无效结果。');}}
  if(value?.ok!==true)throw Object.assign(new Error(typeof value?.error==='string'?value.error:value?.error?.message||'操作未完成，请重试。'),{status:response?.status||value?.status});
  return value.value;
}
export function createEasyClawRuntime(scope=window,{onLocked=()=>{}}={}){
  const listeners=new Set();let connected=false,revision=-1,day='',polling=false,timer;
  const notify=event=>{for(const callback of listeners)callback(event);};
  async function send(action,payload={}){
    const auth=scope.easyclawAuth;
    if(!auth?.request)throw new Error('请在 EasyClaw 本地应用中打开工作台。');
    try{return dataOf(await auth.request({url:SERVICE_ORIGIN+'/api',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload}),timeoutMs:30000,mode:'ticket'}));}
    catch(error){
      if(connected&&(!error.status||[401,403,503].includes(error.status))){connected=false;notify({accessDenied:true});onLocked(error.message);}
      throw error;
    }
  }
  async function call(action,payload={}){
    if(action==='bridge:events')return send(action,payload);
    const job=await send('bridge:start',{action,payload});let offset=0,text='';
    for(;;){
      const part=await send('bridge:result',{id:job.id,offset});
      if(part.pending){await new Promise(resolve=>scope.setTimeout(resolve,500));continue;}
      text+=part.chunk;offset=part.next;if(part.done)return dataOf(JSON.parse(text));
    }
  }
  async function connect({login=false}={}){
    const auth=scope.easyclawAuth;
    if(!auth?.getSession)throw new Error('账号和本机文件功能需要在 EasyClaw 中使用。');
    let session=await auth.getSession({mode:'ticket'});
    if(!session?.authenticated&&login)session=await auth.login({mode:'ticket'});
    if(session?.authenticated!==true||!session.profile)throw new Error('请验证当前 EasyClaw 账号。');
    const run=scope.EasyClawPython?.run;
    if(!run)throw new Error('本机运行桥尚未就绪，请重新打开应用。');
    let launch=await run('scripts/launch-companion.py','start',{}, {timeoutMs:30000});
    for(let depth=0;depth<4&&launch?.data&&!launch.ready;depth++)launch=launch.data;
    if(!launch?.ready)throw new Error('本地工作服务未启动，请重新打开应用。');
    const value=await call('bridge:events');revision=value.revision;day=value.day;connected=true;
    if(!timer)timer=scope.setInterval(async()=>{
      if(!connected||polling)return;polling=true;
      try{const value=await call('bridge:events');if(value.revision!==revision||value.day!==day){const changed=value.day!==day;revision=value.revision;day=value.day;notify({localDataUpdated:true,...(changed?{dayChanged:day}:{})});}}
      catch{}finally{polling=false;}
    },4000);
    return session.profile;
  }
  return Object.freeze({connect,request:call,onChange(callback){listeners.add(callback);return()=>listeners.delete(callback);},windowAction:(action,payload)=>call('window:'+action,payload),getPathForFile:()=>'',dispose(){if(timer)scope.clearInterval(timer);timer=null;connected=false;listeners.clear();}});
}
