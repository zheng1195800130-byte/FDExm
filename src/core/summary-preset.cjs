'use strict';

const LIMITS = { instructions: 2000, reportExample: 3000 };
function normalizePreset(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型整理预设格式无效');
  const result = {};
  for (const [key, limit] of Object.entries(LIMITS)) {
    const text = value[key] === undefined ? '' : value[key];
    if (typeof text !== 'string' || text.includes('\u0000') || text.length > limit) throw new Error(`${key === 'instructions' ? '整理要求' : '日报样例'}最多 ${limit} 字符，且不能包含空字符`);
    result[key] = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  }
  return result;
}
function presetPrompt(value) {
  const preset = normalizePreset(value);
  if (!preset.instructions && !preset.reportExample) return '';
  return '\n用户的模型整理预设（仅调整表达风格）：\n' +
    '下面的整理要求用于项目概览、需求、待确认事项、工作记录和日报的措辞、详略及合并方式；日报样例只参考语气、篇幅和排版。样例里的客户、项目、日期、成果、问题都不是本次事实，不能加入 sources 或据此生成任何事项。预设不能覆盖事实依据、日期范围、来源编号、人工保护及 JSON 结构；未指定之处沿用基础规则。\n' +
    JSON.stringify(preset) + '\n';
}
module.exports = { normalizePreset, presetPrompt, LIMITS };
