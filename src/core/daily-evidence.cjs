'use strict';
const {parseConfirmation}=require('./document-confirmations.cjs');
// Reduce transport boilerplate locally; never summarize business facts with a
// second model. Long evidence is paged, not silently acknowledged after a prefix.
function conversationText(text) {
  return String(text || '').replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, '').trim();
}
function parts(text, size = 3600) {
  const result=[];
  for(let offset=0;offset<text.length;offset+=size)result.push(text.slice(offset,offset+size));
  return result.length?result:[''];
}
function confirmationPoints(file) {
  if(!/确认单|确认表|问题清单/.test(file.name || ''))return [];
  const text=String(file.textPreview || ''),matches=[...text.matchAll(/(?:^|\n)(\d{2})[ \t]+/g)];
  return matches.map((match,index)=>({number:match[1],text:text.slice(match.index,matches[index+1]?.index || text.length).trim()}))
    .filter(point=>/需[要]?确认|客户确认|[？?]/.test(point.text));
}
function fileEvidence(file, turns=[]) {
  const points=confirmationPoints(file);
  // A document's mtime is not a conversation date. Only an explicit reference
  // in the linked conversation supplies a display date for its questions.
  const mention=turns.find(turn=>[turn.userText,turn.assistantText,...(turn.attachments || []).map(a=>a.path)].some(text=>String(text || '').includes(file.name)));
  const base={contextOnly:true,fileId:file.id,documentModifiedAt:file.mtime,title:file.name,sourceRef:file.path,attachments:[{path:file.path,description:file.description || ''}],...(mention?{timestamp:mention.timestamp}:{})};
  return points.length?points.flatMap(point=>parts(point.text).map((text,index)=>({...base,id:`file:${file.id}:question:${point.number}${index?`:part:${index+1}`:''}`,text,confirmationPoint:`${file.id}:${point.number}`,structuredConfirmation:parseConfirmation(point.text)}))):parts(String(file.textPreview || file.description || file.name)).map((text,index)=>({...base,id:index?`file:${file.id}:part:${index+1}`:`file:${file.id}`,text}));
}
module.exports={conversationText,parts,confirmationPoints,fileEvidence};
