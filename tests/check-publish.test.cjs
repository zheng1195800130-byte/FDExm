'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {auditText,auditIndex,readPolicy}=require('../scripts/check-publish.cjs');
test('发布检查区分测试占位值与真实格式凭据，诊断不返回匹配内容',()=>{
 for(const token of ['sk-'+ 'q'.repeat(32),'ghp_'+ 'x'.repeat(36),'github_pat_'+ 'p'.repeat(70),'AKIA'+ 'A'.repeat(16)]){const reasons=auditText(token);assert.ok(reasons.length);assert.ok(!JSON.stringify(reasons).includes(token));}
 assert.deepEqual(auditText("apiKey:'fde-migration-test-key-only' https://name:password@example.com"),[]);
 assert.ok(auditText("apiKey:'"+'r'.repeat(32)+"'").includes('疑似硬编码凭据'));
 assert.ok(auditText(['https://','someone:credential','@api.invalid'].join('')).includes('链接包含凭据'));
 assert.ok(auditText(['C:','Users','real-owner','Documents'].join(String.fromCharCode(92))).includes('真实用户目录'));
 assert.deepEqual(auditText(String.raw`C:\Users\example\Documents`),[]);
 assert.deepEqual(auditText('客户代号 PRIVATE-CUSTOMER', ['private-customer']),['本机保密标识']);
});
test('发布检查读取暂存内容并拒绝强制添加的本机策略和数据，不泄漏策略字符串',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fde-publish-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});git(['init','-q']);
 fs.writeFileSync(path.join(root,'.gitignore'),'.publish-audit.local.json\nstore.json\n');fs.writeFileSync(path.join(root,'.publish-audit.local.json'),JSON.stringify({privateStrings:['PRIVATE-CUSTOMER']}));
 fs.writeFileSync(path.join(root,'README.md'),'PRIVATE-CUSTOMER');git(['add','.gitignore','README.md']);fs.writeFileSync(path.join(root,'README.md'),'公开示例');
 let report=auditIndex(root);assert.ok(report.findings.some(item=>item.reason==='本机保密标识'));assert.ok(!JSON.stringify(report).includes('PRIVATE-CUSTOMER'));
 git(['add','README.md']);assert.deepEqual(auditIndex(root).findings,[]);
 fs.writeFileSync(path.join(root,'.publish-audit.local.json'),JSON.stringify({privateStrings:['甲乙']}));assert.deepEqual(readPolicy(root),['甲乙']);assert.deepEqual(auditText('甲乙客户',['甲乙']),['本机保密标识']);
 fs.writeFileSync(path.join(root,'store.json'),'{}');git(['add','-f','.publish-audit.local.json','store.json']);report=auditIndex(root);assert.equal(report.findings.filter(item=>item.reason==='本地数据/凭据/生成文件').length,2);
});
