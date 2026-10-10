import { Marked, Renderer } from '../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const renderer = new Renderer();
// Conversation content is text. Raw HTML never becomes application UI.
renderer.html = token => escapeHtml(token.text);
renderer.image = token => `<span class="markdown-image-placeholder">[图片：${escapeHtml(token.text || '原会话图片')}]${token.href && !/^data:/i.test(token.href) ? `（${escapeHtml(token.href.slice(0, 1000))}）` : ''}</span>`;
const parser = new Marked({ gfm: true, breaks: false, async: false, renderer });

function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 8000 || /[\u0000-\u0020\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function renderMarkdown(value) {
  const text = typeof value === 'string' ? value : '';
  const fragment = DOMPurify.sanitize(parser.parse(text.slice(0, 200000)), {
    ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','del','blockquote','ul','ol','li','pre','code','table','thead','tbody','tr','th','td','hr','a','span'],
    ALLOWED_ATTR: ['href','title','class','align'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const anchor of fragment.querySelectorAll('a')) {
    const href = externalUrl(anchor.getAttribute('href'));
    if (href) { anchor.setAttribute('href', href); anchor.setAttribute('rel', 'noopener noreferrer'); }
    else anchor.removeAttribute('href');
  }
  const container = document.createElement('div');
  container.append(fragment);
  if (text.length > 200000) {
    const note = document.createElement('p');
    note.textContent = '内容较长，预览仅显示前 200000 字符；完整内容可在原文中查看。';
    container.append(note);
  }
  return container.innerHTML;
}
