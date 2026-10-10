'use strict';
// Inspect the Git index, not just working-tree .gitignore rules. This catches
// accidentally forced/staged data; output only filenames, never secret values.
const {execFileSync}=require('node:child_process');
const blocked=/(^|\/)(data|release|test-output|runtime|node_modules|backups|\.fde-build|\.tmp|\.test-tmp|\.npm-cache|\.electron-cache|\.pack-tmp)(\/|$)|(^|\/)(\.env(?:\..*)?|model-key\.encrypted.*|store(?:\.backup)?\.json(?:\..*)?)$|\.(pem|key|exe|dll|asar|zip|log)$/i;
const git=args=>execFileSync('git',args,{encoding:'utf8',maxBuffer:20*1024*1024});
const files=git(['ls-files','-z']).split('\u0000').filter(Boolean),findings=[];
for(const file of files){
 if(blocked.test(file)){findings.push({file,reason:'本地数据/凭据/生成文件'});continue;}
 const bytes=execFileSync('git',['show',':'+file],{maxBuffer:20*1024*1024});
 if(bytes.length>2*1024*1024){findings.push({file,reason:'超过源码大小限制'});continue;}
 if(/\.(?:png|ico)$/i.test(file))continue;
 const text=bytes.toString('utf8');
 if(/\bsk-[A-Za-z0-9_-]{24,}\b/.test(text)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))findings.push({file,reason:'疑似密钥'});

}
if(!files.length)throw new Error('没有待发布源码，请先明确添加源码文件');
if(findings.length){console.error(JSON.stringify({checked:files.length,findings},null,2));process.exitCode=1;}
else console.log(JSON.stringify({checked:files.length,blockedFiles:0,secretPatterns:0}));
