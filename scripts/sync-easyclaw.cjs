'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {ORIGIN}=require('../desktop/easyclaw-access.cjs');
const ROOT=path.resolve(__dirname,'..'),target=process.argv[process.argv.indexOf('--app-root')+1];
if(!process.argv.includes('--app-root')||!target)throw new Error('必须指定已由宿主正式创建的应用目录');
const dest=fs.realpathSync(target),manifestPath=path.join(dest,'app.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
if(manifest.resourceSource!=='local_dev'||manifest.id!==path.basename(dest))throw new Error('目标不是已确认的本地开发应用');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const protectedFiles=['preload.js','easyclawPythonSdk.js'],before=Object.fromEntries(protectedFiles.map(f=>[f,hash(path.join(dest,f))]));
const stage=path.resolve(ROOT,'../.fde-build/output/FDE Desk-win32-x64');
if(!fs.existsSync(path.join(stage,'resources','app.asar')))throw new Error('请先构建当前版原生运行程序');
const asar=require('@electron/asar'),archive=path.join(stage,'resources','app.asar');
if(JSON.parse(asar.extractFile(archive,'package.json').toString()).version!==require('../package.json').version)throw new Error('原生程序版本不是当前源码版本');
for(const file of ['desktop/main.cjs','desktop/easyclaw-access.cjs','src/ui/app.js'])if(asar.extractFile(archive,file.split('/').join(path.sep)).toString()!==fs.readFileSync(path.join(ROOT,file),'utf8'))throw new Error('原生构建已过期，请重新构建');
const write=(file,text)=>{const f=path.join(dest,file);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text,'utf8');};
const json=(file,value)=>write(file,JSON.stringify(value,null,2)+'\n');
function copyTree(from,to){
  if(fs.statSync(from).isDirectory()){fs.mkdirSync(to,{recursive:true});for(const entry of fs.readdirSync(from))copyTree(path.join(from,entry),path.join(to,entry));}
  else{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}
}
const copy=(from,to)=>copyTree(path.join(ROOT,from),path.join(dest,to));
copy('src/ui','client/src/ui');copy('node_modules/marked','client/node_modules/marked');copy('node_modules/dompurify','client/node_modules/dompurify');
copy('src/core','backend/src/core');copy('desktop','backend/desktop');copy('assets/icon.png','app_icon.png');
copy('easyclaw/host-runtime.mjs','src/easyclaw-runtime.js');copy('easyclaw/host-main.mjs','src/main.js');copy('easyclaw/host.css','src/host.css');copy('easyclaw/launch-companion.py','scripts/launch-companion.py');
write('tests/easyclaw-access.test.cjs',fs.readFileSync(path.join(ROOT,'tests/easyclaw-access.test.cjs'),'utf8').replace("require('../desktop/easyclaw-access.cjs')","require('../backend/desktop/easyclaw-access.cjs')"));
write('tests/easyclaw-host.test.cjs',fs.readFileSync(path.join(ROOT,'tests/easyclaw-host.test.cjs'),'utf8').replace("import('../easyclaw/host-runtime.mjs')","import('../src/easyclaw-runtime.js')"));
for(const entry of fs.readdirSync(stage))if(entry!=='data')copyTree(path.join(stage,entry),path.join(dest,'native',entry));
json('native/resources/fde-easyclaw.json',{edition:'easyclaw',ownerAuthorizationRequired:true});
let html=fs.readFileSync(path.join(ROOT,'src/ui/index.html'),'utf8').replace('href="styles.css"','href="client/src/ui/styles.css"');
html=html.replace('</head>','  <link rel="stylesheet" href="src/host.css">\n</head>');
html=html.replace('<div class="app-shell">','<section id="easyclaw-gate" class="easyclaw-gate"><div class="access-panel"><h1>FDE Desk</h1><p id="access-message" role="status">验证账号后打开个人档案。</p><button id="access-connect" class="btn primary" type="button">使用当前 EasyClaw 账号</button></div></section>\n  <div class="app-shell" hidden>');
html=html.replace('<script type="module" src="app.js"></script>','<script src="easyclawPythonSdk.js"></script>\n  <script type="module" src="src/main.js"></script>');
write('index.html',html);
json('app.json',{...manifest,name:'FDE Desk',version:require('../package.json').version,icon:'app_icon.png',description:'个人 FDE 工作台：资料、需求、工作记录和日报。原档案独立保存，仅授权账号可访问；支持独立悬浮窗口。',enterpriseAuth:{protocol:'easyclaw-enterprise-oidc/v1',modes:['ticket'],defaultMode:'ticket',allowedOrigins:[ORIGIN]}});
json('easyclaw-dev-skill.json',{version:1,kind:'local',browserCompatible:true,runtime:'src/easyclaw-runtime.js'});
json('package.json',{name:'fde-desk-easyclaw',version:require('../package.json').version,private:true,type:'module',scripts:{test:'node --test tests/*.test.cjs'}});
const groups=[['manage_projects','管理项目',['project:create','project:update','project:select','project:archive','project:restore']],['manage_materials','收录与查找资料',['project:scan','file:add','file:preview','file:copy','file:update','material:tags-save']],['manage_requirements','管理需求与客户确认',['requirement:save','requirement:confirmation-save','requirement:filter']],['manage_work_records','管理工作记录',['record:save','record:remove']],['manage_daily_reports','查看、保存与汇总日报',['report:generate','report:save','report:export','daily:report-all']],['organize_project_work','整理项目当日工作',['daily:run','daily:all','codex:bind']],['manage_memos','管理项目备忘录',['memo:get','memo:save','memo:paste']],['configure_summary_model','设置整理模型',['model:settings','model:save','model:test']]];
json('application-capabilities.json',{version:1,capabilities:groups.map(([id,name,actions])=>({id,name,description:name+'，使用当前账号授权的本机 FDE 档案。',userVisible:true,aiEligible:false,exclusionReason:'本版本从本机页面操作，部分功能需要原生文件对话框或剪贴板，尚未提供独立 AI Action 入口。',frontendRefs:['client/src/ui/app.js'],logicRefs:['backend/desktop/main.cjs','backend/src/core/store.cjs','backend/desktop/easyclaw-access.cjs'],runtimeDependencies:['node','filesystem'],auth:{required:true,provider:'enterprise_oidc'},inputSchema:{type:'object',properties:{action:{type:'string',enum:actions},payload:{type:'object'}},required:['action'],additionalProperties:false},outputSchema:{type:'object',properties:{ok:{type:'boolean'},value:{},error:{type:'string'}},required:['ok']},behavior:{operation:id,dataSource:'owner_bound_local_archive',readOnly:false,rules:['后台通过正式 UserInfo 接口验证账号，账号与外部授权记录一致才访问数据','未登录、账号不匹配或身份验证失败时停止访问，不从页面传入账号判断权限','应用目录不存放个人档案、模型密钥或账号授权文件','仅主动整理时读取项目对话与调用已配置模型，页面和日期切换只读本地成果']}}))});
write('.gitignore','.git\n/.easyclaw-runtime/\n/native/\n/client/node_modules/\nnode_modules/\n.test-tmp/\n*.log\n');
write('README.md','# FDE Desk 本地应用\n\n从 EasyClaw 的本地应用列表打开 FDE Desk，使用当前账号验证后读取原有个人档案。资料、需求、日报、备忘录、模型密钥和账号授权保存在 Windows 本地应用数据目录的 FDE Desk/data，应用目录只包含程序。\n\n“打开悬浮框”启动独立原生窗口，EasyClaw 页面保留。原生窗口依赖宿主持续提供账号授权；授权失效或账号切换后锁定内容。普通浏览器仅显示访问提示，不读取本机档案。\n\n原生程序仅支持 Windows。更新应用只替换程序，不覆盖个人数据。native 与 client/node_modules 是生成的运行产物，维护时通过原项目的构建和同步脚本生成；用户运行无需 EasyClawDev (NEXT)。\n');
for(const f of protectedFiles)if(hash(path.join(dest,f))!==before[f])throw new Error('平台运行文件被改动：'+f);
console.log(JSON.stringify({ok:true,id:manifest.id,protectedFilesUnchanged:true,personalDataCopied:false}));
