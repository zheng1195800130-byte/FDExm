'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fileEvidence}=require('../src/core/daily-evidence.cjs'),{parseConfirmation}=require('../src/core/document-confirmations.cjs'),{validate}=require('../src/core/daily-desk.cjs');
const row=reply=>`03  输入字段如何判断\n当前处理：使用当前明确字段。\n需确认：是否需要人工核对输入字段？\n客户确认：${reply}`;
test('确认单按原文字段保存，空白栏保持待确认，明确回复不再丢失',()=>{
 const blank=parseConfirmation(row('__________'));assert.equal(blank.status,'待确认');assert.equal(blank.resolution,'');
 const answered=parseConfirmation(row('____需要；使用人工核对后的值____'));assert.equal(answered.status,'已解决');assert.equal(answered.resolution,'需要；使用人工核对后的值');assert.equal(answered.anchor,blank.anchor);
 assert.equal(parseConfirmation(row('已处理一部分，其余待确认')).status,'待确认');
 assert.equal(parseConfirmation('03  普通文字\n需确认：输入是否有效？'),null);
});
test('同问题的空白和已填写确认单合成原卡，客户回复覆盖空白，来源校验不混淆不同编号',()=>{
 const old=fileEvidence({id:'old',name:'初始确认单.docx',path:'old.docx',textPreview:row('__________')}),next=fileEvidence({id:'next',name:'已填确认单.docx',path:'next.docx',textPreview:row('需要人工核对')});
 const existing=[{confirmationKey:'stable',scenario:'输入字段',question:'需要人工核对吗？',sourceIds:[old[0].id],status:'待确认'}];
 const result=validate({overview:{},items:[],requirements:[],confirmations:[],reportText:''},[...old,...next],[],{confirmations:existing,knownConfirmationSources:[...old,...next],allowPartialConfirmations:true});
 assert.equal(result.confirmations.length,1);assert.equal(result.confirmations[0].confirmationKey,'stable');assert.equal(result.confirmations[0].status,'已解决');assert.equal(result.confirmations[0].resolution,'需要人工核对');assert.equal(result.confirmations[0].sourceIds.length,2);assert.deepEqual(result.pendingConfirmationPoints,[]);
});
test('更新需求和确认事项可引用其真实旧来源，但必须同时引用本次来源',()=>{
 const source={id:'turn:new',timestamp:'2026-10-13T04:00:00Z'},prior={sourceIds:['turn:old'],sourceRef:'codex:old',sourceFirstAt:'2026-10-12T03:00:00Z'};
 const output={overview:{},items:[],requirements:[{requirementKey:'req',title:'更新需求',sourceIds:['turn:old','turn:new']}],confirmations:[{confirmationKey:'confirm',scenario:'输入字段',question:'字段如何确认？',sourceIds:['turn:old','turn:new']}],reportText:''};
 const existing={requirements:[{...prior,requirementKey:'req'}],confirmations:[{...prior,confirmationKey:'confirm'}]};
 assert.equal(validate(output,[source],[],existing).requirements[0].sourceIds.length,2);
 output.confirmations[0].sourceIds=['turn:old'];assert.equal(validate(output,[source],[],existing).confirmations.length,0);
});

test('模型误将原卡编号作为来源时不应用其改写，也不拒绝其他合法成果',()=>{
 const prior={confirmationKey:'known-card',scenario:'原始场景',question:'原始问题',status:'待确认',sourceIds:['file:old']};
 const result=validate({overview:{},items:[],requirements:[{requirementKey:'new',title:'新需求',sourceIds:['file:current']}],confirmations:[{...prior,question:'未经新证据支持的改写',sourceIds:['known-card']}],reportText:''},[{id:'file:current',contextOnly:true}],[],{confirmations:[prior]});
 assert.equal(result.requirements.length,1);assert.equal(result.confirmations.length,0);assert.equal(prior.question,'原始问题');
});
