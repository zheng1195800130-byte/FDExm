'use strict';
// Installation-only binding. Runtime authorization always verifies the host's
// bearer at the official userinfo service; this file is never an auth fallback.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {provisionOwner}=require('../desktop/easyclaw-owner.cjs');
const {profileDirectory,readProfile}=require('../desktop/easyclaw-profile.cjs');
const arg=name=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:'';
const stateRoot=arg('--state-root')||path.join(os.homedir(),'.easyclaw'),appRoot=arg('--app-root');
const profile=appRoot?readProfile(path.join(fs.realpathSync(appRoot),'native/resources')):{};
const isolated=!!profile.applicationId;
if(appRoot&&(!isolated||JSON.parse(fs.readFileSync(path.join(appRoot,'app.json'),'utf8')).id!==profile.applicationId))throw Error('未确认独立账号档案，未修改授权。');
const dataDir=isolated?profileDirectory(profile.applicationId):path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'FDE Desk','data');
console.log(JSON.stringify(provisionOwner({identityFile:path.join(stateRoot,'identity/easyclaw-userinfo.json'),dataDir,allowEmpty:isolated})));
