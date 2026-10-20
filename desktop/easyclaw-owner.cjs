'use strict';
const fs=require('node:fs'),path=require('node:path');
const {identityHash,accountId}=require('./easyclaw-access.cjs');
function provisionOwner({identityFile,dataDir,allowEmpty=false}){
  let profile;try{profile=JSON.parse(fs.readFileSync(identityFile,'utf8').replace(/("(?:uid|uid_str)"\s*:\s*)(\d+)/g,'$1"$2"'));}catch{throw Error('无法读取本机当前账号的安装授权信息。');}
  const accountHash=identityHash(accountId(profile)),file=path.join(dataDir,'easyclaw-owner.json');
  if(!allowEmpty&&!fs.existsSync(path.join(dataDir,'store.json')))throw Error('未找到已有个人档案，未创建或替换数据。');
  if(fs.existsSync(file)){
    const prior=JSON.parse(fs.readFileSync(file,'utf8'));
    if(prior.accountHash!==accountHash)throw Error('个人档案已属于另一个账号，未修改授权。');
  }else{
    if(allowEmpty&&['store.json','store.backup.json','projects'].some(name=>fs.existsSync(path.join(dataDir,name))))throw Error('独立档案已有数据但缺少授权，已停止，未自动认领。');
    fs.mkdirSync(dataDir,{recursive:true});
    fs.writeFileSync(file,JSON.stringify({version:1,accountHash},null,2),{flag:'wx',mode:0o600});
  }
  return {ok:true,existingDataPreserved:true,ownerBindingOutsideApplication:true};
}
module.exports={provisionOwner};
