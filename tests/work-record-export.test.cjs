'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Zip=require('adm-zip'),{XMLParser}=require('fast-xml-parser');
const {selectRecords,createWorkbook,exportName}=require(process.env.FDE_RECORD_EXPORT_MODULE||'../src/core/work-record-export.cjs');
const rows=[{id:'a',date:'2026-10-21',title:'21 日最新版',cause:'原因',result:'已自测，待客户测试',action:'处理'},{id:'b',date:'2026-10-22',title:'22 日记录'},{id:'c',date:'2026-10-23',title:'23 日记录'}];
const project={name:'样例项目',records:rows,dailyHistory:{'2026-10-21':[{id:'old',records:[{...rows[0],title:'21 日旧版'}]},{id:'latest',records:[rows[0]]}]}};
test('范围查询包含两端，允许单端和全部日期，并按日期倒序',()=>{
  assert.deepEqual(selectRecords(project,{startDate:'2026-10-21',endDate:'2026-10-22'}).map(r=>r.id),['b','a']);
  assert.deepEqual(selectRecords(project,{startDate:'2026-10-22'}).map(r=>r.id),['c','b']);
  assert.deepEqual(selectRecords(project,{endDate:'2026-10-21'}).map(r=>r.id),['a']);
  assert.equal(selectRecords(project).length,3);assert.equal(selectRecords(project,{startDate:'2026-10-24'}).length,0);
});
test('按所选历史版本导出，不混入其他版本或修改原档案',()=>{
  const before=JSON.stringify(project);
  assert.equal(selectRecords(project,{startDate:'2026-10-21',endDate:'2026-10-21',versionId:'old'})[0].title,'21 日旧版');
  assert.equal(selectRecords(project,{startDate:'2026-10-21',endDate:'2026-10-21',versionId:'latest'})[0].title,'21 日最新版');
  createWorkbook(selectRecords(project));assert.equal(JSON.stringify(project),before);
});
test('拒绝无效日期、倒置范围和不存在的版本',()=>{
  for(const query of [{startDate:'2026-02-30'},{startDate:'2026-10-23',endDate:'2026-10-21'},{startDate:'2026-10-21',endDate:'2026-10-22',versionId:'old'},{startDate:'2026-10-21',endDate:'2026-10-21',versionId:'missing'}])assert.throws(()=>selectRecords(project,query));
});
test('Excel 仅四列，保留中文、换行、空白及公式样式文本',()=>{
  const zip=new Zip(createWorkbook([{title:'=1+1 <检查> & "核对"',cause:'第一行\n第二行',result:'_x000D_',action:''}]));
  const xml=zip.readAsText('xl/worksheets/sheet1.xml'),sheet=new XMLParser({ignoreAttributes:false,parseTagValue:false}).parse(xml).worksheet;
  assert.deepEqual(sheet.sheetData.row[0].c.map(c=>c.is.t['#text']||c.is.t),['标题','原因','结果','处理']);
  assert.equal(sheet.sheetData.row[1].c.length,4);assert.equal(sheet.sheetData.row[1].c[0]['@_t'],'inlineStr');assert.ok(!xml.includes('<f>'));
  assert.ok(xml.includes('第一行\n第二行'));assert.ok(xml.includes('_x005F_x000D_'));assert.equal(sheet.autoFilter['@_ref'],'A1:D2');assert.equal(sheet.sheetViews.sheetView.pane['@_state'],'frozen');
});
test('空结果与超长字段明确报错，文件名包含筛选范围且没有非法字符',()=>{
  assert.throws(()=>createWorkbook([]),/暂无工作记录/);assert.throws(()=>createWorkbook([{title:'长文本',cause:'字'.repeat(32768)}]),/原因.*字数限制/);
  assert.equal(exportName({name:'项目/A'},{startDate:'2026-10-21',endDate:'2026-10-23'}),'项目_A_2026-10-21至2026-10-23_工作记录.xlsx');
});
