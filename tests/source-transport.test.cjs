'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {requestJson}=require('../src/core/model-api.cjs');
test('模型只引用短来源编号，返回后恢复原始来源，未知编号不会被猜测映射',async()=>{
 const sources=[{id:'turn:long-session-id:part:20',turnId:'long-session-id',text:'当天工作'},{id:'file:long-document-id:question:03',contextOnly:true,text:'客户确认'}];
 const messages=[{role:'system',content:'输出 JSON'},{role:'user',content:JSON.stringify({sources,previousItems:[]})}];
 const result=await requestJson({enabled:true,provider:'compatible',baseUrl:'https://example.com/v1',model:'mock'},'mock-only',messages,async(_url,options)=>{const body=JSON.parse(options.body),input=JSON.parse(body.messages.find(message=>message.role==='user').content);assert.equal(input.sources[0].id,'turn:source1');assert.equal(input.sources[1].id,'file:source2');return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{sourceIds:['turn:source1']}],requirements:[{sourceIds:['file:source2','invented']}],confirmations:[]})}}]}),{status:200});},{sourceAliases:true});
 assert.equal(result.items[0].sourceIds[0],sources[0].id);assert.deepEqual(result.requirements[0].sourceIds,[sources[1].id,'invented']);assert.equal(JSON.parse(messages[1].content).sources[0].id,sources[0].id);
});
