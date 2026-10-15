'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const ORIGIN='http://127.0.0.1:35639',ISSUER='https://api-enterprise-oidc.easyclaw.com';
const identityHash=uid=>crypto.createHash('sha256').update(ISSUER+'\0'+String(uid)).digest('hex');
const error=(message,status=403)=>Object.assign(new Error(message),{status});
function accountId(value){
  const uid=value?.uid_str??value?.uid??value?.sub;
  if(typeof uid==='string'&&uid.trim())return uid.trim();
  if(typeof uid==='number'&&Number.isSafeInteger(uid))return String(uid);
  throw error('无法确认当前账号，已停止访问个人数据。',401);
}
async function verifyUser(authorization,fetcher=fetch){
  if(typeof authorization!=='string'||!/^Bearer [^\s]+$/.test(authorization)||authorization.length>16000)throw error('请先使用 EasyClaw 账号登录。',401);
  let response;
  try{response=await fetcher(ISSUER+'/api/v1/oidc/standard/userinfo',{headers:{Authorization:authorization},signal:AbortSignal.timeout(12000),redirect:'error'});}
  catch{throw error('账号验证服务暂不可用，个人数据保持锁定。',503);}
  if(!response.ok)throw error('登录已失效，请重新验证账号。',401);
  let info;try{info=await response.json();}catch{throw error('账号验证结果无效，已停止访问。',401);}
  return identityHash(accountId(info));
}
class EasyClawAccess{
  constructor({dataDir,verify=verifyUser,now=Date.now,onRevoke=()=>{}}){
    const owner=JSON.parse(fs.readFileSync(path.join(dataDir,'easyclaw-owner.json'),'utf8'));
    if(owner.version!==1||!/^\w{64}$/.test(owner.accountHash))throw error('尚未为当前账号授权个人档案。');
    Object.assign(this,{owner:owner.accountHash,verify,now,onRevoke,authorizedUntil:0,cache:null,generation:0});
  }
  allowed(){return this.authorizedUntil>this.now();}
  revoke(){const active=this.authorizedUntil>0;this.authorizedUntil=0;this.cache=null;if(active){this.generation++;this.onRevoke();}}
  async authorize(header){
    if(this.authorizedUntil>0&&!this.allowed())this.revoke();
    const key=crypto.createHash('sha256').update(String(header||'')).digest('hex');let account;
    try{
      account=this.cache?.key===key&&this.cache.expires>this.now()?this.cache.account:await this.verify(header);
      if(account!==this.owner)throw error('当前账号没有此个人档案的访问权限。');
    }catch(e){this.revoke();throw e;}
    this.cache={key,account,expires:this.now()+5000};this.authorizedUntil=this.now()+20000;return true;
  }
}
function startLocalBridge({access,dispatch,events,version,onAuthorized=()=>{},port=35639}){
  // Host requests have a 30 s timeout and 2 MiB response ceiling. Each job and
  // chunk is independently authorized; revocation invalidates pending results.
  const jobs=new Map(),chunkSize=120000;
  const prune=()=>{for(const [id,job] of jobs)if(job.generation!==access.generation||job.expires<Date.now())jobs.delete(id);};
  async function handle(action,payload){
    prune();
    if(action==='bridge:start'){
      if(typeof payload.action!=='string'||payload.action.startsWith('bridge:')||payload.action.length>100)throw error('无效操作。',400);
      if(jobs.size>=32)throw error('当前处理任务较多，请稍后重试。',429);
      const id=crypto.randomUUID(),job={generation:access.generation,expires:Date.now()+600000,status:'pending'};jobs.set(id,job);
      Promise.resolve().then(()=>dispatch(payload.action,payload.payload||{})).then(value=>{
        if(job.generation!==access.generation||!access.allowed()){jobs.delete(id);return;}
        job.text=JSON.stringify({ok:true,value});job.status='ready';
      },e=>{job.text=JSON.stringify({ok:false,error:e.message||'操作未完成，请重试。',status:e.status||400});job.status='ready';});
      return {id};
    }
    if(action==='bridge:result'){
      const job=jobs.get(payload.id);if(!job)throw error('本次读取已失效，请重试。',409);
      if(job.status==='pending')return {pending:true};
      const offset=payload.offset??0;if(!Number.isSafeInteger(offset)||offset<0||offset>job.text.length)throw error('无效读取位置。',400);
      const chunk=job.text.slice(offset,offset+chunkSize),next=offset+chunk.length,done=next===job.text.length;
      if(done)jobs.delete(payload.id);
      return {chunk,next,done};
    }
    return action==='bridge:events'?events():dispatch(action,payload);
  }
  const server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    if(req.method==='GET'&&req.url==='/health'){send(200,{application:'fde-desk-easyclaw',version});return;}
    if(req.method!=='POST'||req.url!=='/api'){send(404,{ok:false,error:'请求不存在'});return;}
    try{
      await access.authorize(req.headers.authorization);onAuthorized();
      let body='',bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4*1024*1024)throw error('本次内容过大。',413);body+=chunk;}
      const input=JSON.parse(body);if(typeof input.action!=='string'||input.action.length>100)throw error('无效操作。',400);
      const value=await handle(input.action,input.payload||{});
      // An account switch/expired lease during a long operation cannot return data.
      if(!access.allowed())throw error('账号验证已失效，请重新验证。',401);
      send(200,{ok:true,value});
    }catch(e){send(e.status||400,{ok:false,error:e instanceof SyntaxError?'请求内容无效。':e.message||'操作未完成，请重试。'});}
  });
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server));});
}
module.exports={ORIGIN,ISSUER,identityHash,accountId,verifyUser,EasyClawAccess,startLocalBridge};
