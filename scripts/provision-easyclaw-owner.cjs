'use strict';
// Installation-only binding. Runtime authorization always verifies the host's
// bearer at the official userinfo service; this file is never an auth fallback.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {identityHash,accountId}=require('../desktop/easyclaw-access.cjs');
const identityFile=path.join(os.homedir(),'.easyclaw','identity','easyclaw-userinfo.json');
let profile;try{profile=JSON.parse(fs.readFileSync(identityFile,'utf8').replace(/("(?:uid|uid_str)"\s*:\s*)(\d+)/g,'$1"$2"'));}catch{throw new Error('无法读取本机当前账号的安装授权信息。');}
const accountHash=identityHash(accountId(profile));
const dataDir=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'FDE Desk','data');
if(!fs.existsSync(path.join(dataDir,'store.json')))throw new Error('未找到已有个人档案，未创建或替换数据。');
const file=path.join(dataDir,'easyclaw-owner.json');
if(fs.existsSync(file)){const prior=JSON.parse(fs.readFileSync(file,'utf8'));if(prior.accountHash!==accountHash)throw new Error('个人档案已属于另一个账号，未修改授权。');}
else fs.writeFileSync(file,JSON.stringify({version:1,accountHash},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({ok:true,existingDataPreserved:true,ownerBindingOutsideApplication:true}));
