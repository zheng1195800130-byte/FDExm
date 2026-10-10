'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizePreset,presetPrompt}=require('../src/core/summary-preset.cjs');
const {Store}=require('../src/core/store.cjs');

test('空预设保持原提示词，自定义风格明确不充当项目证据',()=>{
  assert.equal(presetPrompt(), '');
  assert.equal(presetPrompt({instructions:'  ',reportExample:''}), '');
  const prompt=presetPrompt({instructions:'少术语，相关功能合并',reportExample:'客户账单：卡航已交付，海运待反馈。'});
  assert.match(prompt,/少术语/);assert.match(prompt,/客户账单/);assert.match(prompt,/不是本次事实/);assert.match(prompt,/JSON 结构/);
  assert.deepEqual(normalizePreset({instructions:'\uFEFF简短\r\n清楚',reportExample:'  示例  '}),{instructions:'简短\n清楚',reportExample:'示例'});
});

test('预设保存重启保留，非法提交不破坏已有设置和记录',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fde-preset-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),preset={instructions:'简短、合并相关修改',reportExample:'项目甲：完成订单导入，提单来源待确认。'};
  store.setSettings({summaryPreset:preset});const before=JSON.stringify(store.getState());
  for(const invalid of [null,[],{instructions:'字'.repeat(2001)},{reportExample:'a'.repeat(3001)},{reportExample:12},{instructions:'a\u0000b'}])assert.throws(()=>store.setSettings({summaryPreset:invalid}),/预设|整理要求|日报样例/);
  assert.ok(JSON.stringify(store.getState())===before,'无效提交不得变更现有数据');
  assert.deepEqual(new Store(dir).getState().settings.summaryPreset,preset);
  store.setSettings({summaryPreset:{}});assert.deepEqual(new Store(dir).getState().settings.summaryPreset,{instructions:'',reportExample:''});
});
