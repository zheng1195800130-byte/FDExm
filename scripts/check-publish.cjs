'use strict';
// Check indexed bytes, including forced/staged data, without printing matches.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const LOCAL_POLICY='.publish-audit.local.json';
const blocked=/(^|\/)(data|release|test-output|runtime|node_modules|backups|\.fde-build|\.tmp|\.test-tmp|\.npm-cache|\.electron-cache|\.pack-tmp)(\/|$)|(^|\/)(\.env(?:\..*)?|\.publish-audit\.local\.json|model-key\.encrypted.*|store(?:\.backup)?\.json(?:\..*)?|auth\.json|Local State|Cookies)$|\.(pem|key|exe|dll|asar|zip|log|encrypted)$/i;
const secretPatterns=[
 /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/,
 /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|hf_[A-Za-z0-9]{25,})\b/,
 /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
];
function auditText(text,privateStrings=[]){
 const reasons=[];
 if(secretPatterns.some(rx=>rx.test(text)))reasons.push('疑似真实密钥');
 const literal=/\b(?:api[_-]?key|password|access[_-]?token|client[_-]?secret)\s*[:=]\s*(['"])([A-Za-z0-9_+\/=.-]{24,})\1/ig;
 for(const match of text.matchAll(literal))if(!/(?:test|fake|mock|fixture|sample|example|not-real|never-save)/i.test(match[2])){reasons.push('疑似硬编码凭据');break;}
 for(const match of text.matchAll(/https?:\/\/[^\s'"`/:]+:[^\s'"`/@]+@([a-z0-9.-]+)/ig))if(!/^(?:localhost|127\.0\.0\.1|(?:[^.]+\.)*example\.(?:com|org|net))$/i.test(match[1])){reasons.push('链接包含凭据');break;}
 for(const match of text.matchAll(/[A-Z]:[\\/](?:Users|用户)[\\/]([A-Za-z0-9_.-]+)[\\/]/ig))if(!/^(?:user|username|name|alice|bob|demo|sample|example|test|mock|fixture|customer)(?:[-_\d].*)?$/i.test(match[1])){reasons.push('真实用户目录');break;}
 if(privateStrings.some(value=>text.toLocaleLowerCase().includes(value.toLocaleLowerCase())))reasons.push('本机保密标识');
 return [...new Set(reasons)];
}
function readPolicy(root){
 const file=path.join(root,LOCAL_POLICY);if(!fs.existsSync(file))return [];
 if(fs.lstatSync(file).isSymbolicLink())throw new Error('本机发布策略不能是链接');
 let policy;try{policy=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error('本机发布策略格式无效');}
 if(!Array.isArray(policy.privateStrings)||policy.privateStrings.some(value=>typeof value!=='string'||value.trim().length<2||value.length>500))throw new Error('本机发布策略必须提供有效 privateStrings');
 return policy.privateStrings;
}
function auditIndex(root=process.cwd()){
 const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024});
 const privateStrings=readPolicy(root),files=git(['ls-files','-z']).split('\0').filter(Boolean),findings=[];
 for(const file of files){
  if(blocked.test(file)){findings.push({file,reason:'本地数据/凭据/生成文件'});continue;}
  const bytes=execFileSync('git',['show',':'+file],{cwd:root,maxBuffer:20*1024*1024});
  if(bytes.length>2*1024*1024){findings.push({file,reason:'超过源码大小限制'});continue;}
  if(/\.(?:png|ico)$/i.test(file))continue;
  for(const reason of auditText(bytes.toString('utf8'),privateStrings))findings.push({file,reason});
 }
 if(!files.length)throw new Error('没有待发布源码，请先明确添加源码文件');
 return {checked:files.length,privatePolicy:privateStrings.length>0,findings};
}
if(require.main===module){try{
 const report=auditIndex();
 if(report.findings.length){console.error(JSON.stringify(report,null,2));process.exitCode=1;}
 else console.log(JSON.stringify({checked:report.checked,privatePolicy:report.privatePolicy,blockedFiles:0,secretPatterns:0}));
}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={auditText,auditIndex,readPolicy,blocked};
