'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),asar=require('@electron/asar');

const DEFAULT_IGNORE=`.git
node_modules/
.easyclaw-runtime/
__pycache__/
*.pyc
*.pyo
.DS_Store
Thumbs.db
.vite/
.cache/
.turbo/
.parcel-cache/
.next/cache/
coverage/
.nyc_output/
playwright-report/
test-results/
*.log
.eslintcache
.stylelintcache
*.tsbuildinfo
`;
const PUBLISH_RULES=`# FDE Desk: include shipped runtime dependencies; exclude personal archives.
!/client/node_modules/
!/client/node_modules/**
!/native/resources/app/node_modules/
!/native/resources/app/node_modules/**
/native/resources/app.asar
/native/resources/app.asar.unpacked/
/data/
/accounts/
/backups/
.test-tmp/
.env
.env.*
*.encrypted
easyclaw-owner.json
store.json
store.backup.json
store.json.tmp-*
store.backup.json.tmp-*
`;
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function updatePublishIgnore(appRoot){
  const file=path.join(appRoot,'.easyclawignore');
  const content=fs.existsSync(file)?fs.readFileSync(file,'utf8'):DEFAULT_IGNORE;
  if(!content.includes(PUBLISH_RULES))fs.writeFileSync(file,content.replace(/\s*$/,'')+'\n\n'+PUBLISH_RULES);
}

// Electron's ASAR-aware fs cannot read the archive itself as an ordinary file.
// The platform publisher uses that fs, so ship Electron's supported app/ layout.
function unpackNativeApp({archive,resources,backupDirectory}){
  resources=path.resolve(resources);
  if(path.basename(resources)!=='resources'||path.basename(path.dirname(resources))!=='native')throw Error('必须指定应用的 native/resources 目录');
  const publishRoot=path.dirname(path.dirname(resources));
  const appDir=path.join(resources,'app'),oldArchive=path.join(resources,'app.asar');
  const sourceDigest=digest(archive);
  const manifest=JSON.parse(asar.extractFile(archive,'package.json').toString('utf8'));
  if(manifest.name!=='fde-desk'||manifest.main!=='desktop/main.cjs')throw Error('运行包不是 FDE Desk，未替换');
  if(fs.existsSync(appDir)){
    if(fs.lstatSync(appDir).isSymbolicLink()||JSON.parse(fs.readFileSync(path.join(appDir,'package.json'),'utf8')).name!=='fde-desk')throw Error('现有 app 目录不是 FDE Desk，未替换');
  }
  if(fs.existsSync(oldArchive)){
    if(!backupDirectory)throw Error('替换旧运行包前必须指定应用目录外的备份位置');
    const backupRoot=path.resolve(backupDirectory);
    if(backupRoot===publishRoot||backupRoot.startsWith(publishRoot+path.sep))throw Error('旧运行包备份必须位于发布目录外');
    fs.mkdirSync(backupRoot,{recursive:true});
    const backup=path.join(backupRoot,digest(oldArchive)+'.asar');
    if(!fs.existsSync(backup))fs.copyFileSync(oldArchive,backup);
    if(digest(backup)!==digest(oldArchive))throw Error('旧运行包备份校验失败，未替换');
  }
  fs.mkdirSync(resources,{recursive:true});
  const temporary=fs.mkdtempSync(path.join(resources,'app-unpack-')),previous=temporary+'-previous';
  let retainedArchive=false;
  try{
    asar.extractAll(archive,temporary);
    for(const file of asar.listPackage(archive)){
      const relative=file.slice(1),entry=asar.statFile(archive,relative);
      if(entry.link)throw Error('运行包包含链接，未替换');
      if(!entry.files&&!fs.readFileSync(path.join(temporary,relative)).equals(asar.extractFile(archive,relative)))throw Error('解包校验失败：'+relative);
    }
    if(fs.existsSync(appDir))fs.renameSync(appDir,previous);
    try{fs.renameSync(temporary,appDir);}catch(error){if(fs.existsSync(previous))fs.renameSync(previous,appDir);throw error;}
    // Remove only the verified generated archive after its backup and replacement exist.
    if(fs.existsSync(oldArchive)){
      try{fs.unlinkSync(oldArchive);}catch(error){
        // The running publisher may hold the old archive open on Windows.
        // Keeping an identical local copy is safe; publishing always omits it.
        if(!['EBUSY','EPERM'].includes(error.code)||digest(oldArchive)!==sourceDigest)throw Error('旧运行包被占用，需退出 EasyClaw 后重新同步；未使用不同版本替代原程序',{cause:error});
        retainedArchive=true;
      }
    }
  }finally{
    for(const directory of [temporary,previous])if(fs.existsSync(directory))fs.rmSync(directory,{recursive:true});
  }
  return {layout:'resources/app',version:manifest.version,retainedArchive};
}

module.exports={unpackNativeApp,updatePublishIgnore,PUBLISH_RULES};
