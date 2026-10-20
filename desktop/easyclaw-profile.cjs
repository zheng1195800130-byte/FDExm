'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
function profileDirectory(applicationId,{env=process.env}={}){
  if(typeof applicationId!=='string'||!/^[a-z0-9][a-z0-9-]{1,62}$/.test(applicationId))throw Error('本地应用档案标识无效');
  return path.join(env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'FDE Desk','accounts',applicationId,'data');
}
function readProfile(resourcesPath){
  const file=resourcesPath&&path.join(resourcesPath,'fde-easyclaw.json');
  const value=file&&fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const applicationId=value.applicationId||'',port=value.port??35639;
  if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('本地工作服务端口无效');
  if(applicationId)profileDirectory(applicationId);
  return {applicationId,port,origin:'http://127.0.0.1:'+port};
}
module.exports={profileDirectory,readProfile};
