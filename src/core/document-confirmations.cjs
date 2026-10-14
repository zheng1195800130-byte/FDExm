'use strict';
const {createHash}=require('node:crypto');
const normalize=text=>String(text||'').replace(/\s+/g,' ').trim();
function parseConfirmation(text){
 const lines=String(text||'').split('\n'),heading=normalize(lines.shift()?.replace(/^\d{2}\s+/,''));
 const fields={};let active='';
 for(const line of lines){const match=/^(当前处理|临时处理|需确认|需要确认|客户确认|客户回复)\s*[:：]\s*(.*)$/.exec(line.trim());if(match){active=match[1];fields[active]=match[2];}else if(active)fields[active]+='\n'+line;}
 if(!heading||fields['客户确认']===undefined&&fields['客户回复']===undefined)return null;
 const question=normalize(fields['需确认']||fields['需要确认']||heading),workaround=normalize(fields['当前处理']||fields['临时处理']||''),resolution=normalize((fields['客户确认']||fields['客户回复']||'').replace(/[_＿]{2,}/g,' '));
 if(heading.length>400||question.length>600||workaround.length>600||resolution.length>600)return null;
 const answered=!!resolution&&!/待确认|待回复|待补充|待提供|待填写|未填写|未回复|尚未确认/.test(resolution);
 return {anchor:createHash('sha256').update(JSON.stringify([heading,question])).digest('hex'),scenario:heading,question,workaround,status:answered?'已解决':'待确认',resolution:resolution||''};
}
function documentConfirmations(sources,knownSources=[],existing=[]){
 const groups=new Map();for(const source of sources){const fact=source.structuredConfirmation;if(!fact)continue;const group=groups.get(fact.anchor)||[];group.push(source);groups.set(fact.anchor,group);}
 return [...groups].map(([anchor,group])=>{
  const knownIds=new Set([...knownSources,...sources].filter(source=>source.structuredConfirmation?.anchor===anchor).map(source=>source.id));
  const knownAnchors=new Map([...knownSources,...sources].filter(source=>source.structuredConfirmation).map(source=>[source.id,source.structuredConfirmation.anchor]));
  const prior=existing.filter(item=>(item.sourceIds||[]).some(id=>knownIds.has(id))&&(item.sourceIds||[]).every(id=>!knownAnchors.has(id)||knownAnchors.get(id)===anchor));
  const answered=group.filter(source=>source.structuredConfirmation.status==='已解决').sort((a,b)=>(Date.parse(a.documentModifiedAt)||0)-(Date.parse(b.documentModifiedAt)||0)).at(-1);
  const fact=(answered||group.at(-1)).structuredConfirmation,solved=prior.find(item=>item.status==='已解决'&&item.resolution);
  return {confirmationKey:prior[0]?.confirmationKey||'document-'+anchor,...fact,sourceIds:group.map(source=>source.id),relatedConfirmationKeys:[...new Set(prior.flatMap(item=>[item.confirmationKey,...item.relatedConfirmationKeys||[]]))].filter(key=>key!==prior[0]?.confirmationKey),requirementKeys:[...new Set(prior.flatMap(item=>item.requirementKeys||[]))],...(!fact.resolution&&solved?{status:'已解决',resolution:solved.resolution}:{})};
 });
}
module.exports={parseConfirmation,documentConfirmations};
