'use strict';
function externalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8000 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('仅支持打开有效的 HTTP(S) 网页链接');
  let url;
  try { url = new URL(value); } catch { throw new Error('网页链接无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持打开 HTTP(S) 网页链接');
  return url.href;
}
module.exports = { externalUrl };
