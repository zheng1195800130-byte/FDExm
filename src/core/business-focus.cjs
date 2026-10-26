'use strict';
const TOOL=/(?:git\s*lab|easy\s*claw|宿主)/i;
const HANDOFF=/同步|推送|提交|部署|发布|安装|更新|上架|投放|拉取|重开|重启|启动|生效|验证|验收|检查|哈希|流水线|版本/;
const ACTION=/(?:已|尚未|暂未|仍未|未|没有|待|等待|需要|需|本地|本轮|仅|完成)*\s*(?:同步|推送|提交|部署|发布|安装|更新|上架|投放|拉取|重开|重启|启动)/;
const VERSION=/^版本(?:号)?\s*v?\d+(?:\.\d+)+(?:未改动|未变化|不变|保持不变|已更新|已发布)?$/i;
const RULES='业务范围：项目概览、需求清单、工作记录和日报聚焦项目本身的业务目标、业务规则、功能效果、真实业务验证及客户待确认事项。GitLab 代码提交或未推送、EasyClaw 应用同步、安装、发布、重开、宿主验证及其失败等内部工具交付状态，不记为项目工作、需求、客户确认、下一步或卡点，不从旧摘要继承，也不因这些状态未完成而把业务工作继续列为未完成。混合叙述只去掉工具交付部分，保留业务处理、尚未重跑真实账单、待客户测试等事实；自测不能改写成客户验收。若工具名称属于项目实际业务功能（如客户数据导入、账号权限、业务需求对接），仍按真实功能事实整理，不按名称整段删除。';
function businessFeature(text){return /(?:客户需求|工单|业务数据|客户数据|审批数据|订单数据|需求数据|工作记录|报表数据|备忘录)/.test(text)&&/(?:支持|实现|新增|导入|导出|从|同步.*(?:到|至))/.test(text)||/(?:登录|账号隔离|访问权限|身份验证)/.test(text)&&!/(?:推送|提交|部署|安装|上架)/.test(text)||/(?:客户|用户).{0,6}(?:测试|验收)|真实(?:账单|订单).*(?:核对|验证|测试)/.test(text);}
function fragment(text,toolContext){
  const value=text.trim();if(!value)return '';
  if(VERSION.test(value))return '';
  if(toolContext&&/^(?:已|尚未|暂未|仍未|未|待|已完成)*(?:提交|推送|同步|部署|发布)(?:成功|失败|完成)?$/.test(value))return '';
  const tool=value.match(TOOL);if(!tool||!HANDOFF.test(value)||businessFeature(value))return value;
  const action=value.match(ACTION);
  // Preserve the business prefix in mixed text such as “金额已修复并同步…”.
  if(action&&action.index<tool.index){
    const prefix=value.slice(0,action.index).replace(/(?:并且|并|且|之后|后再|后|已)\s*$/,'').trim();
    return /^(?:请|是否|确认|需要|需|本地|本轮|仅|完成|已经|已|未|可以|等待|待|允许|授权|能否|先|修复|处理|解决|本机|当前|将|工具|项目|程序|应用|代码|文件|目录|更改|修改|内容|结果|最新|新版)*$/.test(prefix)?'':prefix;
  }
  return '';
}
function cleanText(input){
  if(typeof input!=='string'||!input)return input||'';
  if(!TOOL.test(input)&&!input.split(/[，,；;。\n]/).some(value=>VERSION.test(value.trim())))return input;
  const parentheses=input.replace(/[（(]([^（）()]*)[）)]/g,(whole,inside)=>{if(!TOOL.test(inside))return whole;const value=cleanText(inside);return value===inside?whole:value?whole[0]+value+whole.at(-1):'';});
  return parentheses.split('\n').map(line=>{
    const prefix=line.match(/^\s*(?:[-*+]\s+|\d+[.)、]\s+)/)?.[0]||'',body=line.slice(prefix.length);
    const parts=body.split(/([，,；;。！？!?])/),kept=[];let changed=false;
    for(let i=0;i<parts.length;i+=2){
      const part=parts[i],context=TOOL.test(part);
      const sections=part.split(/(?:并且|并|且|之后|后再|后)(?=(?:已|未|尚未|暂未|仍未|同步|推送|提交|发布|部署|安装|修复|完成|支持|增加|新增|\d+项(?:测试|检查)))|(?:但是|但|不过|然而)(?=\S)/);
      const cleaned=sections.map(value=>fragment(value,context));
      const value=cleaned.every((text,index)=>text===sections[index].trim())?part:cleaned.filter(Boolean).join('，');
      if(!value.trim()){if(part.trim())changed=true;continue;}
      if(value!==part)changed=true;kept.push({text:value,separator:parts[i+1]||''});
    }
    if(!changed)return line;
    if(!kept.length)return '';
    const ending=body.match(/[。！？!?]\s*$/)?.[0].trim()||'';
    let value=kept.map((part,index)=>part.text+(index===kept.length-1?'':part.separator||'，')).join('').replace(/[，,；;：:\s]+$/,'');
    if(ending&&!/[。！？!?]$/.test(value))value+=ending;
    return prefix+value;
  }).join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
function fields(row,names){return {...row,...Object.fromEntries(names.filter(name=>typeof row[name]==='string').map(name=>[name,cleanText(row[name])]))};}
function rows(values,names,required){return (values||[]).map(row=>{
  if(row.manual===true)return row;
  const value=fields(row,names);if(Array.isArray(row.questions))value.questions=row.questions.map(cleanText).filter(Boolean);
  return typeof row[required]==='string'&&row[required].trim()&&!value[required]?.trim()?null:value;
}).filter(Boolean);}
const records=values=>rows(values,['title','cause','action','result'],'title');
const requirements=values=>rows(values,['title','description'],'title');
const confirmations=values=>rows(values,['scenario','question','workaround','resolution'],'question');
const overview=value=>value?fields(value,['scene','requirements','progress','nextAction','blocker']):value;
const report=value=>value&&value.autoArchived===true?{...value,text:cleanText(value.text)}:value;
const digest=value=>value?{...value,overview:overview(value.overview),...(typeof value.reportText==='string'?{reportText:cleanText(value.reportText)}:{})}:value;
function result(value){return {...value,items:records(value.items),requirements:requirements(value.requirements),confirmations:confirmations(value.confirmations),overview:overview(value.overview),reportText:cleanText(value.reportText)};}
function project(value){
  const output={...value};
  if(value.records)output.records=records(value.records);
  if(value.requirements)output.requirements=requirements(value.requirements);
  if(value.requirementConfirmations)output.requirementConfirmations=confirmations(value.requirementConfirmations);
  if(value.reports)output.reports=value.reports.map(report);
  if(value.dailyDesk)output.dailyDesk={...value.dailyDesk,overview:overview(value.dailyDesk.overview),days:Object.fromEntries(Object.entries(value.dailyDesk.days||{}).map(([date,day])=>[date,{...day,digest:digest(day.digest)}]))};
  if(value.dailyHistory)output.dailyHistory=Object.fromEntries(Object.entries(value.dailyHistory).map(([date,versions])=>[date,versions.map(version=>({...version,records:records(version.records),requirements:requirements(version.requirements),confirmations:confirmations(version.confirmations),report:report(version.report),digest:digest(version.digest)}))]));
  if(value.codex)output.codex={...value.codex,...(value.codex.dailySummaries?{dailySummaries:value.codex.dailySummaries.map(summary=>({...summary,items:records(summary.items)}))}:{})};
  return output;
}
module.exports={RULES,cleanText,records,requirements,confirmations,overview,result,project};
