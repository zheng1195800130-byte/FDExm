'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, ClipboardItem, nativeImage, Tray, Menu, screen, globalShortcut, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Store } = require('../src/core/store.cjs');
const workRecordExport = require('../src/core/work-record-export.cjs');
const materialTags=require('../src/core/material-tags.cjs');
const { displayProject, displaySettings, DEFAULT_IGNORE_RULES } = require('../src/core/file-display.cjs');
const codex = require('../src/core/codex.cjs');
const summarizer = require('../src/core/summarizer.cjs');
const { SummaryService } = require('../src/core/summary-service.cjs');
const { SummaryRules } = require('../src/core/summary-rules.cjs');
const { normalizePreset, LIMITS: PRESET_LIMITS } = require('../src/core/summary-preset.cjs');
const { externalUrl } = require('../src/core/external-links.cjs');
const { ModelSettings } = require('./model-settings.cjs');
const { createModelSecretStorage } = require('./model-secret-storage.cjs');
const { prepareDataDirectory } = require('./data-migration.cjs');
const { MemoStore } = require('../src/core/memos.cjs');
const { createMemoActions } = require('./memo-actions.cjs');
const { createProjectThreadActions } = require('./project-thread-actions.cjs');
const { RequirementService } = require('../src/core/requirement-service.cjs');
const { DailyDesk, localDate, carryover } = require('../src/core/daily-desk.cjs');
const requirementSummarizer = require('../src/core/requirement-summarizer.cjs');
const {EasyClawAccess,startLocalBridge}=require('./easyclaw-access.cjs');
const {readProfile,profileDirectory}=require('./easyclaw-profile.cjs');
const EASYCLAW=process.argv.includes('--easyclaw-host')||(app.isPackaged&&fs.existsSync(path.join(process.resourcesPath,'fde-easyclaw.json')));
const EASYCLAW_PROFILE=readProfile(EASYCLAW&&app.isPackaged?process.resourcesPath:null);
const ROOT = path.resolve(__dirname, '..');
const TRUSTED_PAGES = new Map(['index.html', 'float.html', 'ball.html', 'memo.html'].map(name => [name, pathToFileURL(path.join(ROOT, 'src/ui', name)).href]));
const DATA = EASYCLAW_PROFILE.applicationId&&!(process.env.FDE_TEST==='1'&&process.env.FDE_DATA_DIR)
  ?profileDirectory(EASYCLAW_PROFILE.applicationId):prepareDataDirectory({ root: ROOT, isPackaged: app.isPackaged, execPath: process.execPath });
fs.mkdirSync(path.join(DATA, 'runtime'), { recursive: true });
const RUNTIME=path.join(DATA,EASYCLAW?'runtime-easyclaw':'runtime');
app.setPath('userData', RUNTIME);
app.setPath('sessionData', path.join(RUNTIME, 'browser'));
app.setAppUserModelId('local.fde.desk');
app.setName('FDE Desk');
let store, main, ball, panel, tray, modelSettings, summaryRules, summaryService, requirementService, memoActions, quitting = false;
let queue = Promise.resolve();
const materialScans = new Map();
let ballSaveTimer;
let dailyDesk, dayTimer, lastLocalDay;
let easyclawAccess,bridgeServer,leaseTimer,nativeUnlocked=false,bridgeRevision=0;
const accessAllowed=()=>!EASYCLAW||easyclawAccess?.allowed();
const exec = promisify(execFile);
const memoWindows = new Map();
const windows = () => [main, ball, panel, ...memoWindows.values()].filter(w => w && !w.isDestroyed());
const broadcast = (extra = {}) => {bridgeRevision++;windows().forEach(w => w.webContents.send('fde:changed', extra));};
const syncLocalState = () => { if (store?.refreshFromDisk()) broadcast({ localDataUpdated: true }); };
const refreshWorkbench = () => { try { syncLocalState(); broadcast({ localDataUpdated: true }); } catch (error) { broadcast({ warning: error.message }); } };
const commit = fn => { const execute = () => { syncLocalState(); return fn(); }; const task = queue.then(execute, execute); queue = task.catch(() => {}); return task; };
function scanMaterials(id) {
  if (project(id).archivedAt) return Promise.reject(new Error('项目已归档，请先恢复项目'));
  if (materialScans.has(id)) return materialScans.get(id);
  // Both windows can request refresh together. Share one queued, fresh scan;
  // the ordinary local background index keeps its inexpensive metadata cache.
  const scan = commit(() => project(id).archivedAt ? project(id) : store.scanProject(id, { force: true }));
  materialScans.set(id, scan);
  const clear = () => { if (materialScans.get(id) === scan) materialScans.delete(id); };
  scan.then(clear, clear);
  return scan;
}
const project = id => {
  const found = store.getState().projects.find(p => p.id === id);
  if (!found) throw new Error('项目不存在，请重新选择');
  return found;
};
const fileOf = (id, fileId) => {
  const file = project(id).files.find(f => f.id === fileId);
  if (!file) throw new Error('资料不存在，请刷新索引');
  if (!fs.existsSync(file.path)) throw new Error('文件已移动或删除，请刷新索引');
  return file;
};
function managedPath(id) {
  project(id);
  return store.projectFolder ? store.projectFolder(id) : path.join(DATA, 'projects', id);
}
async function openPath(p) {
  const error = await shell.openPath(p);
  if (error) throw new Error(`无法打开：${error}`);
  return true;
}
function icon() { return nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png')); }
function options(extra = {}) {
  return { icon: icon(), backgroundColor: '#f7f8fa', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }, ...extra };
}
function protect(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}
function saveBounds() {
  if (main && !main.isDestroyed() && !main.isMaximized() && !main.isMinimized()) {
    try { syncLocalState(); store.setSettings({ mainBounds: main.getBounds() }); }
    catch (error) { broadcast({ warning: error.message }); }
  }
}
function createWindows() {
  const settings = store.getState().settings;
  let bounds = settings.mainBounds || { width: 1360, height: 900 };
  if (bounds.x !== undefined) {
    const visible = screen.getAllDisplays().some(d => bounds.x < d.workArea.x + d.workArea.width && bounds.x + bounds.width > d.workArea.x && bounds.y < d.workArea.y + d.workArea.height && bounds.y + bounds.height > d.workArea.y);
    if (!visible) bounds = { width: 1360, height: 900 };
  }
  main = new BrowserWindow(options({ ...bounds, minWidth: 980, minHeight: 660, title: 'FDE Desk · 个人工作台' }));
  protect(main);
  main.loadFile(path.join(ROOT, 'src/ui/index.html'));
  main.once('ready-to-show', () => { if (process.env.FDE_TEST !== '1'&&!EASYCLAW) main.show(); });
  main.on('close', event => { if (!quitting) { event.preventDefault(); compact(); } });
  main.on('focus', refreshWorkbench);
  let boundsTimer;
  for (const event of ['resize', 'move']) main.on(event, () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 400); });
  const area = screen.getPrimaryDisplay().workArea;
  const pos = settings.ballPosition || { x: area.x + area.width - 110, y: area.y + area.height - 180 };
  ball = new BrowserWindow(options({ ...pos, width: 76, height: 76, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, title: 'FDE 悬浮球' }));
  clampBall(); protect(ball);
  ball.loadFile(path.join(ROOT, 'src/ui/ball.html'));
  ball.on('close', event => { if (!quitting) { event.preventDefault(); ball.hide(); showWorkbench(); } });
  ball.webContents.on('context-menu', () => Menu.buildFromTemplate([
    { label: '打开工作台', click: showWorkbench }, { label: '查找资料', click: showPanel },
    { type: 'separator' }, { label: '退出 FDE Desk', click: () => { quitting = true; app.quit(); } }
  ]).popup({ window: ball }));
  panel = new BrowserWindow(options({ width: 430, height: 620, minWidth: 430, minHeight: 620, frame: false, resizable: true, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, title: 'FDE · 快速资料' }));
  protect(panel);
  panel.loadFile(path.join(ROOT, 'src/ui/float.html'));
  panel.on('close', event => { if (!quitting) { event.preventDefault(); panel.hide(); ball.showInactive(); } });
  tray = new Tray(icon());
  tray.setToolTip('FDE Desk · Ctrl+Shift+Space 查找资料');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: showWorkbench }, { label: '查找资料', click: showPanel },
    { label: '显示悬浮球', click: compact }, { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', showWorkbench);
  const registered = globalShortcut.register('CommandOrControl+Shift+Space', () => panel.isVisible() ? (panel.hide(), ball.showInactive()) : showPanel());
  if (!registered) broadcast({ warning: '快捷键 Ctrl+Shift+Space 已被占用，可点击悬浮球查找资料' });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '工作台', submenu: [ { label: '查找资料', accelerator: 'CommandOrControl+Shift+F', click: showPanel }, { label: '收起为悬浮球', accelerator: 'CommandOrControl+Shift+B', click: compact }, { type: 'separator' }, { label: '退出', click: () => { quitting = true; app.quit(); } } ] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }] }
  ]));
}
function clampBall() {
  const b = ball.getBounds();
  const a = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  ball.setPosition(Math.max(a.x, Math.min(b.x, a.x + a.width - b.width)), Math.max(a.y, Math.min(b.y, a.y + a.height - b.height)));
}
function compact() { if(!accessAllowed())return;main.hide(); panel.hide(); clampBall(); ball.showInactive(); }
function showWorkbench() { if(!accessAllowed())return;refreshWorkbench(); panel.hide(); ball.hide(); if (main.isMinimized()) main.restore(); main.show(); main.focus(); }
function showPanel() {
  if(!accessAllowed())return;
  const b = ball.getBounds();
  const a = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const p = panel.getBounds();
  panel.setPosition(Math.max(a.x, Math.min(b.x + b.width - p.width, a.x + a.width - p.width)), Math.max(a.y, Math.min(b.y - p.height + b.height, a.y + a.height - p.height)));
  ball.hide(); panel.show(); panel.focus(); broadcast();
}
function openMemo(id, view) {
  const selected = project(id);
  let win = memoWindows.get(id);
  if (win && !win.isDestroyed()) {
    panel.hide(); ball.hide(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); return true;
  }
  const bounds = main.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  win = new BrowserWindow(options({ width, height, minWidth: Math.min(640, area.width), minHeight: Math.min(480, area.height), title: `备忘录 · ${selected.name}` }));
  win.memoInitialView = view === 'preview' ? 'preview' : 'edit';
  memoWindows.set(id, win); protect(win); win.setMenuBarVisibility(false);
  win.setPosition(area.x + Math.round((area.width - width) / 2), area.y + Math.round((area.height - height) / 2));
  win.once('ready-to-show', () => { panel.hide(); ball.hide(); win.show(); win.focus(); });
  // Flush the per-project save queue before the renderer confirms close.
  win.on('close', event => { if (!quitting && !win.memoCloseConfirmed) { event.preventDefault(); win.webContents.send('fde:changed', { memoCloseRequested: true }); } });
  win.on('closed', () => { if (memoWindows.get(id) === win) memoWindows.delete(id); });
  win.loadFile(path.join(ROOT, 'src/ui/memo.html'));
  return true;
}
async function copyFile(filePath) {
  if (process.platform !== 'win32') throw new Error('文件复制目前支持 Windows，可使用复制路径');
  // .NET supplies the standard Windows FileDropList/CF_HDROP implementation.
  const script = 'Add-Type -AssemblyName System.Windows.Forms; $fdeItems = New-Object System.Collections.Specialized.StringCollection; [void]$fdeItems.Add($env:FDE_COPY_PATH); [System.Windows.Forms.Clipboard]::SetFileDropList($fdeItems)';
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true, timeout: 10000, env: { ...process.env, FDE_COPY_PATH: filePath } });
  return true;
}
async function pasteSupplement(payload) {
  project(payload.id);
  let text = payload.text;
  let buffer, name;
  if (!text) {
    if (typeof clipboard.readImage === 'function') {
      const image = clipboard.readImage();
      if (!image.isEmpty()) buffer = image.toPNG();
    } else {
      const items = await clipboard.read();
      for (const item of items) {
        if (item.types.includes('image/png')) { buffer = Buffer.from(await (await item.getType('image/png')).arrayBuffer()); break; }
      }
    }
    if (!buffer) text = await clipboard.readText();
  }
  if (!buffer && !String(text || '').trim()) throw new Error('剪贴板中没有文字或图片');
  if (buffer && buffer.length > 30 * 1024 * 1024) throw new Error('图片超过 30 MB，请通过文件导入');
  if (String(text || '').length > 2 * 1024 * 1024) throw new Error('文字过长，请保存为文件后导入');
  const timeParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const localTime = `${timeParts.month}-${timeParts.day}_${timeParts.hour}-${timeParts.minute}-${timeParts.second}`;
  name = `${buffer ? '截图' : '补充文字'}_${localTime}_${randomUUID().slice(0, 4)}.${buffer ? 'png' : 'md'}`;
  const tempDir = path.join(DATA, 'clipboard-temp');
  await fsp.mkdir(tempDir, { recursive: true });
  const temp = path.join(tempDir, name);
  await fsp.writeFile(temp, buffer || String(text));
  try {
    const result = await store.addFiles(payload.id, [temp], '补充资料');
    if (payload.description) {
      const file = result.files.find(f => f.name === name);
      if (file) return store.updateFile(payload.id, file.id, { description: payload.description });
    }
    return result;
  } finally { await fsp.unlink(temp).catch(() => {}); }
}
async function dispatch(action, p, sender) {
  if (action.startsWith('memo:')) return memoActions(action, p, sender);
  if (action.startsWith('window:')) {
    switch (action.slice(7)) {
      case 'memo-open': return openMemo(p.id, p.view);
      case 'memo-context': {
        const entry = [...memoWindows].find(([, win]) => win.webContents === sender);
        if (!entry) throw new Error('备忘录窗口不存在');
        const selected = project(entry[0]);
        return { project: { id: selected.id, name: selected.name }, dataDir: DATA, view: entry[1].memoInitialView };
      }
      case 'memo-close': {
        const entry = [...memoWindows].find(([, win]) => win.webContents === sender);
        if (!entry) throw new Error('备忘录窗口不存在');
        if (store.getState().projects.some(item => item.id === entry[0] && !item.archivedAt)) store.setSettings({ activeProjectId: entry[0] });
        showPanel(); panel.webContents.send('fde:changed', { memoTabRequested: true });
        entry[1].memoCloseConfirmed = true;
        setTimeout(() => { if (!entry[1].isDestroyed()) entry[1].close(); }, 50);
        return true;
      }
      case 'compact': compact(); break;
      case 'workbench': showWorkbench(); break;
      case 'panel': showPanel(); break;
      case 'ball': panel.hide(); ball.showInactive(); break;
      case 'quit': quitting = true; app.quit(); break;
      case 'pin': panel.setAlwaysOnTop(p.pinned !== false); break;
      case 'move': {
        const b = ball.getBounds();
        // renderer sends pointer movement deltas, never arbitrary screen capture.
        ball.setPosition(Math.round(b.x + Math.max(-200, Math.min(200, Number(p.dx ?? p.x) || 0))), Math.round(b.y + Math.max(-200, Math.min(200, Number(p.dy ?? p.y) || 0))));
        clampBall();
        clearTimeout(ballSaveTimer);
        ballSaveTimer = setTimeout(() => store.setSettings({ ballPosition: { x: ball.getPosition()[0], y: ball.getPosition()[1] } }), 400);
        break;
      }
      default: throw new Error('不支持的窗口操作');
    }
    return true;
  }
  switch (action) {
    case 'state': { const state = store.getState(); return { ...state, projects: state.projects.filter(p=>!p.archivedAt).map(p => ({ ...displayProject({...p,managementDir:managedPath(p.id)},state.settings.materialDisplay), managementDir: managedPath(p.id), carryover: carryover(p,localDate(new Date())) })), archivedProjects: state.projects.filter(p=>p.archivedAt).map(({id,name,stage,archivedAt})=>({id,name,stage,archivedAt})), dataDir: DATA, modelSettings: modelSettings.public() }; }
    case 'material:tags-save': {const value=store.setMaterialTags(p.id,p.targetId,p.labels);broadcast();return value;}
    case 'material:folder-open': case 'material:folder-copy-path': {
      const target=materialTags.targets({...project(p.id),managementDir:managedPath(p.id)}).find(item=>item.id===p.targetId&&item.type==='folder');if(!target)throw new Error('资料目录不存在，请刷新');
      const stat=await fsp.lstat(target.path);if(!stat.isDirectory()||stat.isSymbolicLink()||materialTags.canonical(await fsp.realpath(target.path))!==materialTags.canonical(target.path))throw new Error('资料目录不存在或已变更');
      if(action==='material:folder-copy-path'){await clipboard.writeText(target.path);return true;}return openPath(target.path);
    }
    case 'material:settings': return {...displaySettings(store.getState().settings.materialDisplay),defaults:DEFAULT_IGNORE_RULES};
    case 'material:settings-save': {const value=displaySettings(p);store.setSettings({materialDisplay:value});broadcast();return value;}
    case 'material:ignore-import': {
      const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(sender),{title:'导入资料展示忽略规则',properties:['openFile'],filters:[{name:'忽略规则',extensions:['gitignore','txt','ignore']},{name:'所有文件',extensions:['*']}]});
      if(result.canceled||!result.filePaths.length)return null;
      const file=result.filePaths[0],stat=await fsp.stat(file);if(!stat.isFile()||stat.size>32768)throw new Error('规则文件最多 32 KB');
      const text=(await fsp.readFile(file,'utf8')).replace(/^\uFEFF/,'');return {name:path.basename(file),...displaySettings({ignoreRules:text})};
    }
    case 'model:settings': return modelSettings.public();
    case 'data:info': return { path: DATA, backupPath: path.join(path.dirname(DATA),'backups') };
    case 'data:open': return openPath(DATA);
    case 'data:copy-path': await clipboard.writeText(DATA); return true;
    case 'link:open': await shell.openExternal(externalUrl(p.url)); return true;
    case 'summary:rules': return summaryRules.public();
    case 'summary:preset': return { ...normalizePreset(store.getState().settings.summaryPreset), limits: PRESET_LIMITS, baseText: summaryRules.read()+'\n\n'+fs.readFileSync(path.join(ROOT,'src/core/daily-desk-rules.md'),'utf8') };
    case 'summary:preset-save': {const preset=normalizePreset(p);store.setSettings({summaryPreset:preset});broadcast();return preset;}
    case 'summary:rules-save': {
      const value = summaryRules.save(p.text);
      summaryService.invalidate();
      for (const proj of store.getState().projects) if (proj.codex.summaryStatus?.state === 'running') {
        store.setSummaryStatus(proj.id, { state: proj.codex.dailySummaries.length ? 'ready' : 'idle', message: '规则已保存，用于后续新增成果；历史可手动重整' });
      }
      return { ...value, reprocessRequired: true };
    }
    case 'model:save': {
      const value = modelSettings.save(p);
      summaryService.invalidate();
      // Saving configuration never triggers a billable request.
      requirementService.invalidate();
      return value;
    }
    case 'model:test': case 'model:list': {
      const config = p.config ? summarizer.validateConfig(p.config) : modelSettings.config();
      const apiKey = p.apiKey || modelSettings.key(config);
      if (typeof apiKey !== 'string' || (summarizer.requiresApiKey(config) && !apiKey.trim()) || apiKey.length > 4000 || /[\r\n]/.test(apiKey)) throw new Error('请先填写有效的 API Key');
      if (action === 'model:list') return summarizer.listModels({ config, apiKey });
      await summarizer.testConnection({ config: { ...config, enabled: true }, apiKey });
      return { ok: true, message: '连接成功，请点击“保存设置”后再整理' };
    }
    case 'summary:run': {
      return dailyDesk.run(p.id,p.date || localDate(new Date()));
    }
    case 'daily:run': return dailyDesk.run(p.id,p.date || localDate(new Date()),p.mode||'append');
    case 'daily:all': return dailyDesk.runAll(p.date || localDate(new Date()));
    case 'daily:raw': return dailyDesk.raw(p.id,p.date || localDate(new Date()));
    case 'daily:report-all': return store.combinedReport(p.date || localDate(new Date()),p.drafts || []);
    case 'project:create': { const made = store.createProject(p); store.setSettings({ activeProjectId: made.id }); return store.scanProject(made.id); }
    case 'project:update': {
      const updated = store.updateProject(p.id, p.patch);
      if (p.patch?.sourceDir || p.patch?.devDir || Object.hasOwn(p.patch || {}, 'artifactDir') || Object.hasOwn(p.patch || {}, 'indexArtifacts')) return store.scanProject(p.id);
      return updated;
    }
    case 'project:select': project(p.id); return store.setSettings({ activeProjectId: p.id });
    case 'project:archive': return store.setProjectArchived(p.id, true);
    case 'project:restore': return store.setProjectArchived(p.id, false);
    case 'project:scan': return scanMaterials(p.id);
    case 'dialog:directory': {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(sender), { title: '选择项目目录', properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    }
    case 'file:add': {
      let paths = p.paths;
      if (!paths) {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(sender), { title: '收录补充资料', properties: ['openFile', 'multiSelections'] });
        if (result.canceled) return project(p.id);
        paths = result.filePaths;
      }
      if (!Array.isArray(paths) || paths.length > 100) throw new Error('每次最多收录 100 个文件');
      return store.addFiles(p.id, paths, p.kind || '补充资料');
    }
    case 'file:paste': return pasteSupplement(p);
    case 'file:update': return store.updateFile(p.id, p.fileId, p.patch);
    case 'file:preview': {
      const result = await store.previewFile(p.id, p.fileId);
      if (result.type === 'image' && result.imagePath) {
        const s = await fsp.stat(result.imagePath);
        if (s.size > 30 * 1024 * 1024) return { ...result, type: 'unsupported', message: '图片较大，请打开原文件查看' };
        const image = nativeImage.createFromPath(result.imagePath);
        if (image.isEmpty()) return { ...result, type: 'unsupported', message: '此图片格式请使用默认程序打开' };
        return { ...result, type: 'image', dataUrl: image.resize({ width: Math.min(image.getSize().width, 1800) }).toDataURL(), message: result.note || result.error };
      }
      return { ...result, type: result.text ? 'text' : 'unsupported', message: result.error || result.note || '此格式可复制路径或打开原文件查看' };
    }
    case 'file:open': return openPath(fileOf(p.id, p.fileId).path);
    case 'file:reveal': shell.showItemInFolder(fileOf(p.id, p.fileId).path); return true;
    case 'file:copy-path': await clipboard.writeText(fileOf(p.id, p.fileId).path); return true;
    case 'file:copy': return copyFile(fileOf(p.id, p.fileId).path);
    case 'path:copy': case 'path:open': {
      const proj = project(p.id);
      const target = p.kind === 'source' ? proj.sourceDir : p.kind === 'dev' ? proj.devDir : managedPath(p.id);
      if (action === 'path:copy') { await clipboard.writeText(target); return true; }
      return openPath(target);
    }
    case 'requirement:analyze': {
      return dailyDesk.run(p.id,p.date || localDate(new Date()));
    }
    case 'requirement:save': return store.upsertRequirement(p.id, p.input);
    case 'requirement:remove': return store.removeRequirement(p.id, p.requirementId);
    case 'requirement:confirmation-save': return store.upsertRequirementConfirmation(p.id, p.input);
    case 'requirement:filter': return store.setRequirementFilter(p.id, p.after, p.mode);
    case 'record:save': return store.upsertRecord(p.id, p.input);
    case 'record:remove': return store.removeRecord(p.id, p.recordId);
    case 'record:export': {
      const proj=project(p.id),records=workRecordExport.selectRecords(proj,p),bytes=workRecordExport.createWorkbook(records);
      const result=await dialog.showSaveDialog(BrowserWindow.fromWebContents(sender),{title:'导出工作记录',defaultPath:workRecordExport.exportName(proj,p),filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});
      if(result.canceled||!result.filePath)return null;
      if(!accessAllowed())throw Error('账号验证已失效，请重新验证。');
      await fsp.writeFile(result.filePath,bytes);return result.filePath;
    }
    case 'report:generate': return store.generateReport(p.id, p.date);
    case 'report:save': return store.saveReport(p.id, p.date, p.text);
    case 'report:export': {
      const proj = project(p.id);
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(sender), { title: '导出日报', defaultPath: `${proj.name}_${p.date}_日报.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (result.canceled || !result.filePath) return null;
      if (typeof p.text !== 'string' || p.text.length > 1000000) throw new Error('日报内容不正确');
      await fsp.writeFile(result.filePath, p.text, 'utf8'); return result.filePath;
    }
    case 'cycle:start': return store.startCycle(p.id, p.name);
    case 'delivery:add': return store.addDelivery(p.id, p.input);
    case 'codex:list': return createProjectThreadActions({ store }).list(p.id);
    case 'codex:bind': {
      const previous = project(p.id).devDir;
      const linked = await createProjectThreadActions({ store }).bind(p.id, p);
      if (linked.devDir !== previous) await store.scanProject(p.id);
      return linked;
    }
    case 'codex:read': {
      const proj = project(p.id);
      if (!proj.codex.threadId) throw new Error('请先关联本项目的 Codex 会话');
      const raw = dailyDesk.raw(p.id,p.date || localDate(new Date()));
      const value = raw.cwd ? materialTags.canonical(raw.cwd) === materialTags.canonical(proj.devDir) ? raw : {turns:[],date:p.date || localDate(new Date())} : raw.threadId === proj.codex.threadId ? raw : {turns:[],date:p.date || localDate(new Date())};
      return { ...value, cached:true, truncated:!!value.partial, drafts: codex.extractDrafts(value.turns) };
    }
    case 'clipboard:text': {
      if (typeof p.text !== 'string' || p.text.length > 2 * 1024 * 1024) throw new Error('复制内容过长');
      await clipboard.writeText(p.text); return true;
    }
    default: throw new Error('不支持的操作，请更新应用');
  }
}
function isTrustedRequest(event) {
  try {
    const frame = event.senderFrame;
    const owner = windows().find(win => win.webContents === event.sender);
    if (!frame || !owner || frame !== event.sender.mainFrame) return false;
    const url = new URL(frame.url);
    // A same-document anchor changes the URL, not the identity of the local page.
    url.hash = '';
    const page = owner === main ? 'index.html' : owner === panel ? 'float.html' : owner === ball ? 'ball.html' : 'memo.html';
    return TRUSTED_PAGES.get(page) === url.href;
  } catch { return false; }
}
async function executeRequest(input,sender){
  if(!accessAllowed())throw new Error('请先在 EasyClaw 中验证授权账号。');
  const execute = () => { if(!accessAllowed())throw new Error('请先在 EasyClaw 中验证授权账号。');syncLocalState(); return dispatch(input.action, input.payload || {}, sender); };
  const direct = ['state', 'project:scan', 'model:settings', 'model:test', 'model:list', 'summary:run', 'requirement:analyze', 'summary:rules', 'link:open'].includes(input.action) || input.action.startsWith('daily:') || input.action.startsWith('window:') || input.action.startsWith('clipboard:');
  const promise = direct ? execute() : queue.then(execute, execute);
  if (!direct) queue = promise.catch(() => {});
  const value = await promise;
  if(!accessAllowed())throw new Error('账号验证已失效，请重新验证。');
  if (/^(project:|file:(add|paste|update)|requirement:|record:(save|remove)|report:save|cycle:|delivery:|codex:bind|model:save|summary:rules-save)/.test(input.action)) broadcast();
  if (/^memo:(save|paste|add-image|add-images|remove-image)$/.test(input.action)) broadcast({ memoUpdated: input.payload?.id });
  return value;
}
function setupIPC() {
  ipcMain.handle('fde:request', async (event, input) => {
    if (!isTrustedRequest(event)) return { ok: false, error: '不允许的页面来源' };
    if (!input || typeof input.action !== 'string') return { ok: false, error: '无效请求' };
    try {
      const value = await executeRequest(input,event.sender);
      return { ok: true, value };
    } catch (error) { return { ok: false, error: error.message || '操作失败' }; }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => main && showWorkbench());
  app.whenReady().then(async () => {
    if(EASYCLAW)easyclawAccess=new EasyClawAccess({dataDir:DATA,onRevoke:()=>{nativeUnlocked=false;for(const win of windows()){win.hide();win.webContents.reload();}}});
    store = new Store(DATA);
    memoActions = createMemoActions({ memos: new MemoStore({ projectFolder: managedPath }), clipboard, ClipboardItem, nativeImage, dialog, shell, windowForSender: sender => BrowserWindow.fromWebContents(sender) });
    modelSettings = new ModelSettings({ dataDir: DATA, store, safeStorage: createModelSecretStorage({ dataDir: DATA, safeStorage }) });
    summaryRules = new SummaryRules({ dataDir: DATA });
    summaryService = new SummaryService({ store, reader: codex, summarizer, getModel: () => ({ config: modelSettings.config(), apiKey: modelSettings.key() }), getRules: () => summaryRules.read(), commit, notify: broadcast, delay: process.env.FDE_TEST === '1' ? 100 : 5000 });
    requirementService = new RequirementService({ store, reader: codex, summarizer: requirementSummarizer, getModel: () => ({ config: modelSettings.config(), apiKey: modelSettings.key() }), commit, notify: broadcast, delay: process.env.FDE_TEST === '1' ? 100 : 5000 });
    dailyDesk = new DailyDesk({store,reader:codex,getModel:()=>({config:modelSettings.config(),apiKey:modelSettings.key()}),getRules:()=>summaryRules.read(),commit,notify:broadcast,prepare:id=>{
      if(!project(id).codex.threadId)throw new Error('请先确认本项目的 Codex 会话入口');
      return scanMaterials(id);
    }});
    setupIPC(); createWindows();
    // Manual synchronization only. Startup/midnight archive existing local
    // results without scanning materials or reading Codex conversation files.
    lastLocalDay = localDate(new Date());
    const archiveLocal = day => commit(()=>{for(const proj of store.getState().projects.filter(proj=>!proj.archivedAt))dailyDesk.rollover(proj.id,day);});
    archiveLocal(lastLocalDay).then(refreshWorkbench,error=>broadcast({warning:error.message}));
    const checkDay = () => { const day=localDate(new Date()); if(day!==lastLocalDay){lastLocalDay=day;archiveLocal(day).then(()=>broadcast({dayChanged:day}),error=>broadcast({warning:error.message}));} };
    dayTimer=setInterval(checkDay,1000);dayTimer.unref();
    require('electron').powerMonitor.on('resume',()=>{checkDay();refreshWorkbench();});
    if(EASYCLAW){
      bridgeServer=await startLocalBridge({access:easyclawAccess,version:app.getVersion(),applicationId:EASYCLAW_PROFILE.applicationId,port:process.env.FDE_TEST==='1'&&process.env.FDE_EASYCLAW_PORT!==undefined?Number(process.env.FDE_EASYCLAW_PORT):EASYCLAW_PROFILE.port,events:()=>({revision:bridgeRevision,day:lastLocalDay}),onAuthorized:()=>{if(!nativeUnlocked){nativeUnlocked=true;broadcast({accessRestored:true});}},dispatch:(action,payload)=>{
        if(action==='window:compact'){showPanel();return true;}
        return executeRequest({action,payload},main.webContents);
      }});
      if(process.env.FDE_TEST==='1')globalThis.__fdeEasyClawTest={port:bridgeServer.address().port};
      leaseTimer=setInterval(()=>{if(!easyclawAccess.allowed())easyclawAccess.revoke();},1000);leaseTimer.unref();
    }
  }).catch(error => { dialog.showErrorBox('FDE Desk 启动失败', error.message); quitting = true; app.quit(); });
  app.on('activate', () => main && showWorkbench());
  app.on('before-quit', () => {
    quitting = true;
    summaryService?.stop();
    requirementService?.stop();
    dailyDesk?.stop(); clearInterval(dayTimer);
    clearInterval(leaseTimer);bridgeServer?.close();
    if (store) {
      saveBounds();
      try { syncLocalState(); if (ball && !ball.isDestroyed()) store.setSettings({ ballPosition: { x: ball.getPosition()[0], y: ball.getPosition()[1] } }); }
      catch (error) { console.error(error.message); }
    }
    clearTimeout(ballSaveTimer); globalShortcut.unregisterAll();
  });
  app.on('window-all-closed', () => app.quit());
}
