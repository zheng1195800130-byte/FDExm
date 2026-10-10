'use strict';
const path = require('node:path');
const ignore = require('ignore');
const {isOfficeTemporaryFile}=require('./files.cjs');
const {workProject}=require('./daily-report.cjs');
const {targets,annotated}=require('./material-tags.cjs');
const DEFAULT_IGNORE_RULES = '# 常见代码与构建文件（只隐藏展示，不删除原件）\n*.java\n*.js\n*.jsx\n*.ts\n*.tsx\n*.mjs\n*.cjs\n*.py\n*.pyc\n*.cs\n*.c\n*.cpp\n*.h\n*.hpp\n*.go\n*.rs\n*.php\n*.class\n*.map\n*.lock\n*.log\nnode_modules/\n.git/\n__pycache__/\n';
function displaySettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('资料展示设置无效');
  const rules = input.ignoreRules === undefined ? DEFAULT_IGNORE_RULES : input.ignoreRules;
  if (typeof rules !== 'string' || Buffer.byteLength(rules,'utf8') > 32768 || rules.includes('\0') || rules.split(/\r?\n/).length > 500) throw new Error('忽略规则最多 32 KB、500 行，不能包含空字符');
  return { ignoreRules: rules.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n') };
}
function relativeMaterialPath(project, file) {
  const roots = file.kind === '原始资料' ? [project.sourceDir] : file.kind === '开发成果' ? [project.artifactDir || project.devDir] : [project.managementDir && path.join(project.managementDir,'supplements')];
  for (const root of roots.filter(Boolean)) {
    const relative = path.relative(root, file.path || '');
    if (relative && !relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  }
  return path.basename(file.path || file.name || 'unknown');
}
function displayProject(project, settings) {
  const matcher=ignore({ignorecase:true}).add(displaySettings(settings).ignoreRules);
  const apply=item=>{const relativePath=relativeMaterialPath(project,item);return {...annotated(project,item),relativePath,displayIgnored:(item.type!=='folder'&&isOfficeTemporaryFile(item.path||item.name||''))||matcher.ignores(relativePath+(item.type==='folder'?'/':''))};};
  const catalog=targets(project),folders=catalog.filter(item=>item.type==='folder').map(item=>({...apply(item),relativePath:item.root?'':relativeMaterialPath(project,item)}));
  const byFileId=new Map(catalog.filter(item=>item.type==='file').map(item=>[item.fileId,item]));
  return {...workProject(project),files:(project.files||[]).map(file=>apply({...file,targetId:byFileId.get(file.id)?.id,type:'file'})),folders:folders.map(folder=>({...folder,targetId:folder.id}))};
}
module.exports={DEFAULT_IGNORE_RULES,displaySettings,relativeMaterialPath,displayProject};
