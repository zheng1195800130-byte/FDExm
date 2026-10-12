export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const dateKey = value => {const date=new Date(value);if(Number.isNaN(date.getTime()))return '';const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
export const today = () => dateKey(new Date());
export const dayLabel = value => { if (!value) return '尚无记录'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',month:'short',day:'numeric'}).format(date); };
export const currentProject = state => (state?.projects || []).find(p => p.id === state?.settings?.activeProjectId) || state?.projects?.[0] || null;
export const icon = (name, size=20) => {
  const paths = {
    overview:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    files:'<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    requirements:'<path d="M9 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><rect x="9" y="2" width="6" height="5" rx="1"/><path d="m8 12 1 1 2-2M14 12h3m-9 5h9"/>',
    records:'<path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9M14 3l7 7h-7Z"/><path d="M7 12h3m-3 4h10"/>',
    reports:'<path d="M6 3h12a2 2 0 0 1 2 2v16H4V5a2 2 0 0 1 2-2Z"/><path d="M8 8h8M8 12h8M8 16h4"/>',
    codex:'<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>',
    search:'<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
    arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
    copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    pin:'<path d="m16 3 5 5-4 1-4 4-1 5-3-3-6 6m6-6-3-3 5-1 4-4Z"/>',
    ball:'<circle cx="12" cy="12" r="8"/><path d="m9 12 3 3 3-3m-3-5v8"/>',
    link:'<path d="m10 13 4-4m-5 8-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 8a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-2 2"/>',
    file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h5"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    refresh:'<path d="M20 7v5h-5M4 17v-5h5M5.5 7a7 7 0 0 1 12-2L20 8M4 16l2.5 3a7 7 0 0 0 12-2"/>',
    edit:'<path d="m16 3 5 5-12 12-6 1 1-6Zm-3 3 5 5"/>',
    flag:'<path d="M5 22V3m0 1c4-3 8 3 14 0v10c-6 3-10-3-14 0"/>',
    shield:'<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
};
export const statusClass = value => ['已完成','已明确','验收完成','客户验收通过','已解决','已结束','已交付'].includes(value) ? 'success' : ['未解决','已变更','阻塞'].includes(value) ? 'danger' : ['待确认','待验证','等待客户','待客户验证'].includes(value) ? 'warning' : 'neutral';
export const badge = value => `<span class="badge ${statusClass(value)}">${esc(value || '未设置')}</span>`;
export const sizeLabel = size => !Number.isFinite(size) ? '' : size < 1024 ? `${size} B` : size < 1048576 ? `${(size/1024).toFixed(1)} KB` : `${(size/1048576).toFixed(1)} MB`;
const searchNormalize = value => String(value || '').normalize('NFKC').toLowerCase();
const searchTerms = query => [...new Set(searchNormalize(query).trim().split(/\s+/).filter(Boolean))];
export const visibleFiles = project => (project?.files || []).filter(file => !file.hidden && !file.missing && !file.displayIgnored);
export const fileCategory = file => {const ext=String(file.ext||file.name?.match(/\.[^.]+$/)?.[0]||'').toLowerCase();return /\.(xlsx?|csv|tsv|ods)$/.test(ext)?'表格':/\.(png|jpe?g|gif|webp|bmp|svg|tiff?|heic)$/.test(ext)?'图片':/\.(zip|7z|rar|gz|tar)$/.test(ext)?'压缩包':/\.(pdf|docx?|pptx?|odt|rtf|txt|md|markdown|html?)$/.test(ext)?'文档':'其他';};
export function fileSearch(file,query){
  const terms=searchTerms(query);if(!terms.length)return {score:0,label:'',snippet:''};
  const fields=[['标签',(file.tags||[]).map(t=>t.label).join(' '),160],['文件名',file.name,100],['用途',file.description,60],['目录',file.relativePath,30],['正文',file.textPreview,10]].map(([label,text,score])=>({label,text:String(text||''),normalized:searchNormalize(text),score}));
  if(!terms.every(term=>fields.some(field=>field.normalized.includes(term))))return null;
  let score=0;const hits=[];
  for(const field of fields){const matched=terms.filter(term=>field.normalized.includes(term));if(!matched.length)continue;score+=field.score*matched.length;hits.push(field);}
  if(fields[0].normalized.includes(searchNormalize(query).trim()))score+=150;
  const hit=hits.find(field=>field.label==='正文')||hits.find(field=>field.label==='用途')||hits[0];
  const first=terms.map(term=>hit.normalized.indexOf(term)).filter(index=>index>=0).sort((a,b)=>a-b)[0]||0;
  const offset=Math.max(0,first-24),raw=hit.text.slice(offset,offset+110).replace(/\s+/g,' ');
  return {score,label:hits.map(field=>field.label).join('、'),snippet:(offset?'…':'')+raw+(offset+110<hit.text.length?'…':'')};
}
export const fileMatches = (file,query) => fileSearch(file,query)!==null;
export const compareFiles = (a,b,query='') => (query.trim()?((fileSearch(b,query)?.score||0)-(fileSearch(a,query)?.score||0)):0)||String(b.importedAt||b.mtime||'').localeCompare(String(a.importedAt||a.mtime||''))||String(a.name||'').localeCompare(String(b.name||''),'zh-CN');
export function fileSearchMarkup(file,query){
  const match=fileSearch(file,query);if(!match?.label)return '';
  const terms=searchTerms(query),text=match.snippet;let output='';
  for(let i=0;i<text.length;){const term=terms.find(term=>searchNormalize(text.slice(i,i+term.length))===term);if(term){output+='<mark>'+esc(text.slice(i,i+term.length))+'</mark>';i+=term.length;}else output+=esc(text[i++]);}
  return `<div class="file-search-match"><span>命中${esc(match.label)}</span> · ${output}</div>`;
}
export function notify(message, error=false) { const el=document.getElementById('toast'); if (!el) return; el.textContent=message; el.className=`toast show${error?' error':''}`; clearTimeout(notify.timer); notify.timer=setTimeout(()=>el.classList.remove('show'),error?6500:2800); }
export async function request(action,payload={}) { if (!window.fde) throw new Error('请通过 FDE Desk 桌面程序打开此页面。'); return window.fde.request(action,payload); }

export function materialScanStatus(project, {running=false,error=''} = {}) {
  if (!project) return {text:'关联项目后可刷新资料', warning:false};
  if (running) return {text:'正在读取当前项目的关联目录…', warning:false};
  if (error) return {text:`刷新失败：${error}`, warning:true};
  if (project.scanWarning) return {text:`部分资料未更新：${project.scanWarning}`, warning:true};
  const date=new Date(project.lastScanAt||'');
  if (!Number.isFinite(date.getTime())) return {text:'目录文件修改后，点击刷新资料同步', warning:false};
  const text=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);
  return {text:`已更新 ${text} · ${visibleFiles(project).length} 份可用资料`, warning:false};
}
