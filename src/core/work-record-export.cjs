'use strict';
const Zip=require('adm-zip');
const focus=require('./business-focus.cjs');
const COLUMNS=[['date','工作日期'],['title','标题'],['cause','原因'],['result','结果'],['action','处理']];
function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
function selectRecords(project,{startDate='',endDate='',versionId=''}={}){
  for(const date of [startDate,endDate])if(date&&!validDate(date))throw Error('工作日期无效');
  if(startDate&&endDate&&startDate>endDate)throw Error('开始日期不能晚于结束日期');
  let records=project.records||[];
  if(versionId){
    if(!startDate||startDate!==endDate)throw Error('历史版本仅支持单日导出');
    const version=project.dailyHistory?.[startDate]?.find(row=>row.id===versionId);
    if(!version)throw Error('所选版本不存在，请重新查看后导出');
    records=version.records;
  }
  return focus.records([...records].filter(row=>(!startDate||row.date>=startDate)&&(!endDate||row.date<=endDate))).sort((a,b)=>String(b.date).localeCompare(String(a.date))||String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt)));
}
function xml(value){return String(value??'').replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,'').replace(/_x[0-9a-f]{4}_/gi,match=>'_x005F_'+match.slice(1)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;').replace(/\r/g,'&#13;');}
function createWorkbook(records){
  if(!records.length)throw Error('所选时间范围暂无工作记录');
  if(records.length>1048575)throw Error('工作记录超过 Excel 行数限制，请缩小时间范围');
  const rows=[COLUMNS.map(([,label])=>label),...records.map((record,index)=>COLUMNS.map(([key,label])=>{const value=String(record[key]??'');if(value.length>32767)throw Error(`第 ${index+1} 项记录的“${label}”超过 Excel 单元格字数限制，请缩小该项内容后导出`);return value;}))];
  const sheetRows=rows.map((row,index)=>`<row r="${index+1}"${index?'':' ht="28" customHeight="1"'}>${row.map((value,column)=>`<c r="${String.fromCharCode(65+column)}${index+1}" t="inlineStr" s="${index?1:2}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`).join('');
  const zip=new Zip(),add=(name,text)=>zip.addFile(name,Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+text));
  add('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
  add('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  add('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工作记录" sheetId="1" r:id="rId1"/></sheets></workbook>');
  add('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  add('xl/styles.xml','<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF196F63"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  add('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:E${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="1" width="15" customWidth="1"/><col min="2" max="2" width="40" customWidth="1"/><col min="3" max="3" width="55" customWidth="1"/><col min="4" max="5" width="65" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:E${rows.length}"/></worksheet>`);
  return zip.toBuffer();
}
function exportName(project,{startDate='',endDate=''}={}){const span=startDate&&startDate===endDate?startDate:startDate||endDate?`${startDate||'最早'}至${endDate||'最新'}`:'全部日期';return `${String(project.name||'项目').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,80)}_${span}_工作记录.xlsx`;}
module.exports={selectRecords,createWorkbook,exportName};
