'use strict';

// Isolated desktop acceptance. Text/paste events, PNG decoding and managed
// files are real; the OS clipboard, image picker and Explorer are mocked.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { Store } = require('../src/core/store.cjs');

const ROOT = path.resolve(__dirname, '..');
const PORTABLE = !!process.env.FDE_SMOKE_EXECUTABLE;
const EXECUTABLE = process.env.FDE_SMOKE_EXECUTABLE || require('electron');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) {
  try { return hash(await fs.readFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// A small, deterministic RGBA PNG with valid CRCs, without using customer files.
function samplePng() {
  const crc = bytes => {
    let result = 0xffffffff;
    for (const byte of bytes) {
      result ^= byte;
      for (let bit = 0; bit < 8; bit++) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
    }
    return (result ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(Buffer.concat([type, bytes])));
    return Buffer.concat([size, type, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.from([0, 24, 120, 108, 255, 240, 180, 30, 255, 0, 65, 150, 90, 255, 220, 90, 100, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function run() {
  const output = path.join(ROOT, 'test-output'); await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, '隔离备忘录 '));
  const dataDir = path.join(fixture, 'data'), codexHome = path.join(fixture, '空 Codex');
  await fs.mkdir(codexHome, { recursive: true });
  const seed = new Store(dataDir), projects = [], originalFiles = [];
  for (const label of ['A', 'B']) {
    const sourceDir = path.join(fixture, `${label} 原始资料`), devDir = path.join(fixture, `${label} 开发项目`);
    await Promise.all([sourceDir, devDir].map(directory => fs.mkdir(directory, { recursive: true })));
    const source = path.join(sourceDir, '只读业务资料.md'), development = path.join(devDir, '开发说明.md');
    await fs.writeFile(source, `${label} 隔离业务资料。`); await fs.writeFile(development, `${label} 隔离开发成果。`);
    originalFiles.push(source, development);
    const project = seed.createProject({ name: `备忘录验收 ${label}`, sourceDir, devDir });
    await seed.scanProject(project.id); projects.push(project);
  }
  const [a, b] = projects;
  seed.saveSummarizerSettings({ enabled: false, provider: 'compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'disabled-memo-fixture' });
  seed.setSettings({ activeProjectId: a.id });
  const imageBytes = samplePng(), pngBase64 = imageBytes.toString('base64'), pickerImage = path.join(fixture, '隔离图片.png');
  await fs.writeFile(pickerImage, imageBytes);
  const realStore = path.join(ROOT, 'release', 'FDE Desk-win32-x64', 'data', 'store.json');
  const realBefore = await hashFile(realStore), sourceBefore = await Promise.all(originalFiles.map(hashFile));
  const checks = [], errors = [], imageNetworkRequests = [];
  let app, page, panel, screenshot, reportPath;
  const check = (condition, message) => { assert.ok(condition, message); checks.push(message); };
  async function eventually(predicate, message, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await predicate()) return; await pause(60); }
    throw new Error(message);
  }
  const env = { ...process.env, FDE_TEST: '1', FDE_DATA_DIR: dataDir, CODEX_HOME: codexHome }; delete env.ELECTRON_RUN_AS_NODE;
  const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.fde.request(action, payload), { action, payload });
  const memo = id => request('memo:get', { id });
  const control = () => app.evaluate(() => {
    const value = globalThis.__fdeMemoSmoke;
    return { copiedTexts: value.copiedTexts, copiedImages: value.copiedImages, reveals: value.reveals, opens: value.opens, pickerCalls: value.pickerCalls, readCalls: value.readCalls };
  });
  async function launch() {
    app = await electron.launch({ executablePath: EXECUTABLE, args: PORTABLE ? [] : [ROOT], env, timeout: 40000 }); await app.firstWindow();
    await eventually(async () => {
      page = app.windows().find(window => window.url().endsWith('/index.html'));
      panel = app.windows().find(window => window.url().endsWith('/float.html'));
      return !!page && !!panel;
    }, '工作台或悬浮窗没有载入');
    for (const surface of [page, panel]) {
      surface.setDefaultTimeout(12000);
      surface.on('pageerror', error => errors.push(error.message));
      surface.on('request', pending => { if (/^https?:/i.test(pending.url())) imageNetworkRequests.push(pending.url()); });
    }
    await app.evaluate(({ BrowserWindow, clipboard, nativeImage, dialog, shell }, input) => {
      const png = Buffer.from(input.base64, 'base64'), decoded = nativeImage.createFromBuffer(png);
      if (decoded.isEmpty()) throw new Error('隔离 PNG 不能被 Electron 解码');
      const state = globalThis.__fdeMemoSmoke = {
        clipboardText: '', clipboardPng: null, copiedTexts: [], copiedImages: [], reveals: [], opens: [], pickerCalls: 0, readCalls: 0,
      };
      // Electron 44 exposes async ClipboardItem read()/write(). Cover the older
      // method shape as well without ever calling an original system method.
      clipboard.readText = async () => state.clipboardText;
      clipboard.writeText = async text => { state.copiedTexts.push(text); };
      clipboard.read = async () => {
        state.readCalls++;
        return state.clipboardPng ? [{ types: ['image/png'], getType: async type => {
          if (type !== 'image/png') throw new Error('隔离剪贴板类型无效');
          return new Blob([Buffer.from(state.clipboardPng, 'base64')], { type });
        } }] : [];
      };
      clipboard.write = async items => {
        for (const item of items) {
          if (!item.types.includes('image/png')) throw new Error('只应复制 PNG 图片');
          const blob = await item.getType('image/png'), bytes = Buffer.from(await blob.arrayBuffer());
          const image = nativeImage.createFromBuffer(bytes);
          state.copiedImages.push({ type: blob.type, bytes: bytes.length, empty: image.isEmpty(), size: image.getSize(), base64: bytes.toString('base64') });
        }
      };
      if (typeof clipboard.readImage === 'function') clipboard.readImage = () => { state.readCalls++; return state.clipboardPng ? nativeImage.createFromBuffer(Buffer.from(state.clipboardPng, 'base64')) : nativeImage.createEmpty(); };
      if (typeof clipboard.writeImage === 'function') clipboard.writeImage = image => state.copiedImages.push({ type: 'image/png', bytes: image.toPNG().length, empty: image.isEmpty(), size: image.getSize(), base64: image.toPNG().toString('base64') });
      shell.showItemInFolder = file => { state.reveals.push(file); };
      shell.openPath = async file => { state.opens.push(file); return ''; };
      dialog.showOpenDialog = async () => { state.pickerCalls++; return { canceled: false, filePaths: [input.pickerImage] }; };
      for (const window of BrowserWindow.getAllWindows()) {
        const url = window.webContents.getURL();
        if (url.endsWith('/index.html') || url.endsWith('/float.html')) { window.setAlwaysOnTop(false); window.show(); }
      }
    }, { base64: pngBase64, pickerImage });
    await eventually(async () => await panel.locator('#float-project').inputValue() === a.id, '初始项目没有载入');
    await request('window:panel');
  }
  async function showMemo() {
    await request('window:panel');
    await panel.locator('#float-tab-memo').click();
    await eventually(async () => await panel.locator('#memo-text').isVisible() && !(await panel.locator('#memo-text').isDisabled()), '备忘录未就绪');
  }
  async function selectProject(id) {
    await panel.locator('#float-project').selectOption(id);
    await eventually(async () => (await request('state')).settings.activeProjectId === id && await panel.locator('#float-project').inputValue() === id, '项目切换未完成');
    await eventually(async () => !(await panel.locator('#memo-text').isDisabled()), '切换后备忘录尚未就绪');
  }
  async function paste(input) {
    return panel.locator('#memo-text').evaluate((editor, value) => {
      editor.focus();
      const data = new DataTransfer();
      if (value.text !== undefined) data.setData('text/plain', value.text);
      if (value.base64) data.items.add(new File([Uint8Array.from(atob(value.base64), character => character.charCodeAt(0))], value.name || '粘贴截图.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      editor.dispatchEvent(event); return { prevented: event.defaultPrevented };
    }, input);
  }
  async function setClipboard(text, image = null) {
    await app.evaluate((_, input) => { globalThis.__fdeMemoSmoke.clipboardText = input.text; globalThis.__fdeMemoSmoke.clipboardPng = input.image; }, { text, image });
  }
  const card = id => panel.locator(`.memo-image-card[data-image="${id}"]`);
  try {
    await launch();
    check((await request('state')).dataDir === dataDir && !(await request('state')).settings.summarizer.enabled, '应用使用隔离数据、空 Codex 目录和禁用的模型');
    check(await panel.locator('#float-tab-files').getAttribute('aria-selected') === 'true' && await panel.locator('#float-files-panel').isVisible(), '悬浮窗默认显示资料页');
    await showMemo();
    check(await panel.locator('#float-tab-memo').getAttribute('aria-selected') === 'true' && !(await panel.locator('#float-files-panel').isVisible()), '可切换到独立备忘录页');
    check((await memo(a.id)).text === '' && (await memo(a.id)).images.length === 0 && await panel.locator('#memo-text').inputValue() === '', '新项目备忘录初始为空');

    const initialText = '客户测试反馈：目录选择已修复。\n下一步：等待客户复测。';
    await panel.locator('#memo-text').fill(initialText);
    await eventually(async () => (await memo(a.id)).text === initialText, '输入未自动保存');
    await eventually(async () => (await panel.locator('#memo-save-status').innerText()).includes('已保存'), '自动保存结果没有显示');
    check((await panel.locator('#memo-save-status').innerText()).includes('已保存'), '文字输入自动保存且显示保存结果');

    const markdownText='# 项目备忘\n\n**重点**与 `字段`\n\n- 等待客户回复\n- 补充样例\n\n| 问题 | 状态 |\n| --- | --- |\n| 提单 | 待确认 |\n\n```js\nconst value = 1;\n```\n\n<script>globalThis.__fdeMemoAttack=1</script>\n\n[危险链接](javascript:alert(1))\n\n![外部图片](https://example.invalid/private.png)';
    await panel.locator('#memo-text').fill(markdownText);
    await eventually(async()=> (await memo(a.id)).text===markdownText,'Markdown 原文没有保存');
    const markdownBefore=await memo(a.id);
    await panel.locator('#memo-mode-preview').click();
    check(await panel.locator('#memo-preview h1').innerText()==='项目备忘' && await panel.locator('#memo-preview strong').innerText()==='重点' && await panel.locator('#memo-preview li').count()===2 && await panel.locator('#memo-preview table').count()===1 && await panel.locator('#memo-preview pre code').innerText()==='const value = 1;\n','悬浮框 Markdown 预览展示标题、粗体、列表、表格与代码块');
    check(await panel.locator('#memo-preview script,#memo-preview img,#memo-preview a[href^="javascript:"]').count()===0 && await panel.evaluate(()=>globalThis.__fdeMemoAttack)===undefined,'Markdown 预览过滤脚本和危险链接，不自动加载外部图片');
    check(await panel.locator('#memo-text').isHidden() && await panel.locator('#memo-preview').isVisible() && JSON.stringify(await memo(a.id))===JSON.stringify(markdownBefore),'切换预览只改变显示，不修改原文或保存版本');
    await panel.locator('#memo-mode-edit').click();
    check(await panel.locator('#memo-text').inputValue()===markdownText && await panel.locator('#memo-preview').isHidden(),'切回编辑完整保留 Markdown 原文');

    const plainText = `${initialText}\n<script>globalThis.__fdeMemoAttack=1</script><img src=x onerror="globalThis.__fdeMemoAttack=2">`;
    await panel.locator('#memo-text').fill(plainText);
    await eventually(async () => (await memo(a.id)).text === plainText, '纯文本样例没有保存');
    check(await panel.locator('#memo-text').inputValue() === plainText && await panel.evaluate(() => globalThis.__fdeMemoAttack) === undefined && await panel.locator('#float-memo-panel script,#float-memo-panel img:not(.memo-image-preview)').count() === 0, '备忘录中的 HTML 仅作为 textarea 纯文本，不执行脚本或加载图片');
    let svgRejected = false;
    try { await page.evaluate(id => window.fde.request('memo:add-image', { id, name: '不支持.svg', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }), a.id); }
    catch { svgRejected = true; }
    check(svgRejected && (await memo(a.id)).images.length === 0, '不支持的 SVG 图片在主进程被拒绝且未写入图片记录');

    const dirtyText = `${initialText}\n尚在编辑的补充备注。`;
    await panel.locator('#memo-text').fill(dirtyText);
    await panel.locator('#memo-text').evaluate(editor => { editor.focus(); editor.setSelectionRange(4, 10, 'forward'); });
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('fde:changed', { testMemoBroadcast: true }); });
    await pause(320);
    const editing = await panel.locator('#memo-text').evaluate(editor => ({ text: editor.value, start: editor.selectionStart, end: editor.selectionEnd, focused: document.activeElement === editor }));
    check(editing.text === dirtyText && editing.start === 4 && editing.end === 10 && editing.focused, '后台广播保留未保存文字、焦点与选区');
    await eventually(async () => (await memo(a.id)).text === dirtyText, '广播后的输入未保存');

    await panel.locator('#memo-text').evaluate(editor => editor.setSelectionRange(0, 0));
    check((await paste({ text: '粘贴文字：' })).prevented, 'Ctrl+V 文字进入实际 renderer 粘贴处理');
    const textWithPaste = `粘贴文字：${dirtyText}`;
    await eventually(async () => (await memo(a.id)).text === textWithPaste, '粘贴文字没有保存');
    check(await panel.locator('#memo-text').inputValue() === textWithPaste, '文字粘贴在光标位置插入并自动保存');

    check((await paste({ base64: pngBase64, name: '测试截图.png' })).prevented, 'Ctrl+V 截图进入实际 renderer 文件粘贴处理');
    await eventually(async () => (await memo(a.id)).images.length === 1, '粘贴截图没有保存');
    const firstImage = (await memo(a.id)).images[0];
    await eventually(async () => await card(firstImage.id).locator('img.memo-image-preview').evaluate(image => image.complete && image.naturalWidth > 0), '图片预览未显示');
    check(firstImage.width === 2 && firstImage.height === 2 && (await memo(a.id)).text === textWithPaste, '截图经真实 PNG 解码持久保存并显示预览，文字保留');

    const pendingA = `${textWithPaste}\n切换项目之前的最新输入。`;
    await panel.locator('#memo-text').fill(pendingA); await selectProject(b.id);
    check((await memo(a.id)).text === pendingA && (await memo(b.id)).text === '' && (await memo(b.id)).images.length === 0, '切换项目立即保存旧项目，另一个项目从空备忘录开始');
    await eventually(async () => await panel.locator('#memo-text').inputValue() === '', 'B 项目误显示 A 的备忘录');
    const textB = 'B 项目：独立验证需求，等待用户提供样例。';
    await panel.locator('#memo-text').fill(textB); await selectProject(a.id);
    await eventually(async () => await panel.locator('#memo-text').inputValue() === pendingA, '切回 A 没有还原 A 备忘录');
    check((await memo(b.id)).text === textB && (await memo(a.id)).images.length === 1, '两个项目文字与图片独立，切回不会串写');

    await panel.locator('#memo-text').evaluate(editor => { editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); });
    await setClipboard('\n按钮粘贴的补充文字'); await panel.locator('#memo-paste').click();
    const pastedButtonText = `${pendingA}\n按钮粘贴的补充文字`;
    await eventually(async () => (await memo(a.id)).text === pastedButtonText, '按钮粘贴文字没有保存');
    check(await panel.locator('#memo-text').inputValue() === pastedButtonText, '粘贴按钮通过隔离剪贴板读取文字并保留当前内容');
    await setClipboard('', pngBase64); await panel.locator('#memo-paste').click();
    await eventually(async () => (await memo(a.id)).images.length === 2, '按钮粘贴截图没有保存');
    check((await control()).readCalls >= 2 && (await memo(a.id)).text === pastedButtonText, '粘贴按钮兼容 Electron 异步图片剪贴板且不清空文字');

    await panel.locator('#memo-add-images').click();
    await eventually(async () => (await memo(a.id)).images.length === 3, '添加图片按钮没有收录隔离图片');
    check((await control()).pickerCalls === 1, '添加图片按钮经过目录对话框 mock 并真实解码收录 PNG');
    await card(firstImage.id).locator('[data-memo-action="copy-image"]').click();
    await eventually(async () => (await control()).copiedImages.length === 1, '复制图片没有调用剪贴板边界');
    const copied = (await control()).copiedImages[0], preview = await request('memo:preview', { id: a.id, imageId: firstImage.id });
    check(!copied.empty && copied.type === 'image/png' && copied.size.width === 2 && hash(Buffer.from(copied.base64, 'base64')) === await hashFile(preview.path), '复制图片发送当前项目真实 PNG 像素给隔离异步剪贴板');
    check(path.resolve(preview.path).startsWith(`${path.resolve(dataDir)}${path.sep}`) && !originalFiles.includes(preview.path), '图片只保存于 FDE 管理区，不写原始资料或开发目录');
    check((await fs.readFile(preview.path)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), '管理区图片是真实 PNG 二进制文件，不是 JSON 或 base64 文本');
    await card(firstImage.id).locator('[data-memo-action="reveal-image"]').click();
    await eventually(async () => (await control()).reveals.length === 1, '打开目录没有调用文件资源管理器边界');
    check((await control()).reveals[0] === preview.path, '打开图片目录定位当前图片文件（Explorer 使用 mock）');
    await panel.locator('#memo-copy-text').click();
    await eventually(async () => (await control()).copiedTexts.at(-1) === pastedButtonText, '复制文字没有调用隔离剪贴板');
    check((await control()).copiedTexts.at(-1) === pastedButtonText, '复制备忘录仅向隔离剪贴板发送原始文字');

    const removedId = (await memo(a.id)).images[1].id;
    await card(removedId).locator('[data-memo-action="remove-image"]').click();
    await eventually(async () => !(await memo(a.id)).images.some(image => image.id === removedId) && await card(removedId).count() === 0, '图片移除未生效');
    check((await memo(a.id)).images.length === 2 && (await memo(a.id)).text === pastedButtonText && (await memo(b.id)).images.length === 0, '移除图片不影响文字、其他图片或另一个项目');
    let crossProjectRejected = false;
    try { await request('memo:preview', { id: b.id, imageId: firstImage.id }); } catch { crossProjectRejected = true; }
    check(crossProjectRejected, '图片编号不能跨项目读取');

    let collapsedText = `${pastedButtonText}\n收起前立即保存的备注。`;
    await panel.locator('#memo-text').fill(collapsedText); await panel.locator('#collapse').click();
    await eventually(async () => (await memo(a.id)).text === collapsedText, '收起悬浮窗未立即保存');
    await eventually(async () => await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/float.html')).isVisible()), '保存后悬浮窗没有收起');
    check(await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/float.html')).isVisible()), '收起操作等待文字保存后显示悬浮球');
    await showMemo(); await panel.locator('#float-tab-files').click();
    check(await panel.locator('#float-files-panel').isVisible() && await panel.locator('#float-tab-files').getAttribute('aria-selected') === 'true', '备忘录仍可切回资料检索页');
    await panel.locator('#float-refresh').click();
    await eventually(async () => !(await panel.locator('#float-refresh').isDisabled()), '资料刷新没有完成');
    const state = await request('state'), projectA = state.projects.find(project => project.id === a.id);
    check(!projectA.files.some(file => path.resolve(file.path).startsWith(`${path.resolve(dataDir)}${path.sep}`)) && projectA.records.length === 0 && projectA.requirements.length === 0 && projectA.reports.length === 0, '备忘录不会自动混入资料索引、工作记录、需求或日报');
    await showMemo();
    await eventually(async () => await panel.locator('#memo-text').inputValue() === collapsedText && await panel.locator('.memo-image-card').count() === 2, '收起后笔记回读错误');
    // Exercise the actual expanded window with the same isolated memo and images.
    collapsedText += '\n扩大前尚未等待自动保存的文字。';
    await panel.locator('#memo-text').fill(collapsedText);
    await panel.locator('#memo-expand').click();
    let expanded;
    await eventually(async () => { expanded=app.windows().find(window=>window.url().endsWith('/memo.html'));return !!expanded && !(await expanded.locator('#memo-text').isDisabled()); }, '独立备忘录窗口没有就绪');
    expanded.on('pageerror',error=>errors.push(error.message));
    expanded.on('request',pending=>{if(/^https?:/i.test(pending.url()))imageNetworkRequests.push(pending.url());});
    check(await expanded.locator('#memo-text').inputValue()===collapsedText && (await memo(a.id)).text===collapsedText,'扩大前立即保存最新文字，大窗口回读同一项目内容');
    check(await expanded.locator('#memo-project-name').innerText()===a.name && await expanded.locator('.memo-image-card').count()===2,'大窗口展示对应项目名和原有图片');
    check(await expanded.locator('#float-project,.sidebar,.float-tabs,.float-footer').count()===0,'大窗口只展示备忘录，没有资料检索或工作台菜单');
    const sizes=await app.evaluate(({BrowserWindow,screen})=>{
      const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));
      const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/memo.html'));
      const bounds=main.getBounds(),area=screen.getDisplayMatching(bounds).workArea;
      return {actual:win.getBounds(),expected:{width:Math.min(bounds.width,area.width),height:Math.min(bounds.height,area.height)},resizable:win.isResizable(),panelHidden:!BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/float.html')).isVisible()};
    });
    check(Math.abs(sizes.actual.width-sizes.expected.width)<=16 && Math.abs(sizes.actual.height-sizes.expected.height)<=16 && sizes.resizable && sizes.panelHidden,`大窗口与工作台大小相近，可调整大小，悬浮框已收起 ${JSON.stringify(sizes)}`);
    await request('window:memo-open',{id:a.id});
    check(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL().endsWith('/memo.html')).length)===1,'重复扩大同一项目聚焦已有窗口');
    await request('project:select',{id:b.id});await pause(250);
    check(await expanded.locator('#memo-project-name').innerText()===a.name && await expanded.locator('#memo-text').inputValue()===collapsedText,'其他窗口切换项目不改变已打开备忘录的归属');
    check(await expanded.locator('#memo-text').evaluate((editor,base64)=>{
      const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],'大窗口截图.png',{type:'image/png'}));
      const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});editor.dispatchEvent(event);return event.defaultPrevented;
    },pngBase64),'大窗口支持 Ctrl+V 粘贴截图');
    await eventually(async()=> (await memo(a.id)).images.length===3 && await expanded.locator('.memo-image-card').count()===3,'大窗口截图未持久保存');
    const expandedImage=(await memo(a.id)).images.at(-1);
    await expanded.locator(`[data-memo-action="remove-image"][data-image="${expandedImage.id}"]`).click();
    await eventually(async()=> (await memo(a.id)).images.length===2,'大窗口图片移除失败');
    check((await memo(b.id)).text===textB && (await memo(b.id)).images.length===0,'扩大窗口的文字图片操作不影响另一个项目');
    check(await expanded.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1 && document.getElementById('memo-text').getBoundingClientRect().height>300),'大窗口无水平溢出，文字区充分展开');
    await expanded.locator('#memo-mode-preview').click();
    check(await expanded.locator('#memo-preview').isVisible() && (await expanded.locator('#memo-preview').textContent()).trim()===collapsedText && await expanded.locator('#memo-text').isHidden(),'扩大窗口同样支持 Markdown 预览，正文与已保存内容一致');
    await expanded.locator('#memo-mode-edit').click();
    const localDraft=collapsedText+'\n本窗口尚未保存的草稿。',otherWindowText=collapsedText+'\n另一窗口先保存的内容。';
    await expanded.locator('#memo-text').fill(localDraft);
    const beforeConcurrent=await memo(a.id);
    await request('memo:save',{id:a.id,text:otherWindowText,expectedRevision:beforeConcurrent.revision});
    await eventually(async()=>await expanded.locator('#memo-save-status').innerText().then(text=>text.includes('其他窗口更新')),'同时编辑没有显示冲突');
    await pause(800);
    check((await memo(a.id)).text===otherWindowText && await expanded.locator('#memo-text').inputValue()===localDraft,'两个窗口同时编辑时保留当前草稿，自动保存不覆盖另一窗口的新内容');
    collapsedText=otherWindowText+'\n核对后合并本窗口草稿。';
    await expanded.locator('#memo-text').fill(collapsedText);
    await expanded.locator('#memo-retry').click();
    await eventually(async()=> (await memo(a.id)).text===collapsedText,'核对冲突后无法保存');
    check((await memo(a.id)).text===collapsedText,'冲突核对后点击重试保存合并内容');
    await expanded.screenshot({path:path.join(output,PORTABLE?'21-扩大备忘录-便携版.png':'21-扩大备忘录-源码.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/memo.html')).setSize(640,480));await pause(100);
    check(await expanded.evaluate(()=>{const editor=document.getElementById('memo-text').getBoundingClientRect(),images=document.getElementById('memo-images').getBoundingClientRect();return document.documentElement.scrollWidth<=document.documentElement.clientWidth+1 && editor.height>=100 && images.bottom<=innerHeight;}),'缩小至 640×480 后文字和图片仍完整可用');
    collapsedText+='\n大窗口新增内容，返回时立即保存。';
    await expanded.locator('#memo-text').fill(collapsedText);
    await expanded.locator('#memo-collapse').click();
    await eventually(async()=>expanded.isClosed() && await panel.locator('#float-project').inputValue()===a.id && await panel.locator('#memo-text').inputValue()===collapsedText,'返回悬浮框没有回读大窗口最新内容');
    check((await memo(a.id)).text===collapsedText && await panel.locator('#float-tab-memo').getAttribute('aria-selected')==='true','返回悬浮框保存文字并恢复对应项目备忘录页');
    await panel.locator('#memo-mode-preview').click();
    await panel.locator('#memo-expand').click();
    await eventually(async()=>{expanded=app.windows().find(w=>w.url().endsWith('/memo.html'));return !!expanded && !(await expanded.locator('#memo-text').isDisabled());},'再次扩大失败');
    expanded.on('pageerror',error=>errors.push(error.message));
    check(await expanded.locator('#memo-preview').isVisible() && await expanded.locator('#memo-mode-preview').getAttribute('aria-pressed')==='true','从预览模式扩大后继续展示 Markdown 预览');
    await expanded.locator('#memo-mode-edit').click();
    await panel.locator('#memo-mode-edit').evaluate(button=>button.click());
    await app.evaluate(({app})=>{const load=process.mainModule.require.bind(process.mainModule);const {MemoStore}=load(load('node:path').join(app.getAppPath(),'src/core/memos.cjs'));globalThis.__memoSaveOriginal=MemoStore.prototype.save;MemoStore.prototype.save=function(){throw new Error('隔离模拟：扩大窗口保存失败');};});
    collapsedText+='\n保存失败仍保留的扩大窗口草稿。';
    await expanded.locator('#memo-text').fill(collapsedText);
    await expanded.locator('#memo-collapse').click();
    await eventually(async()=>await expanded.locator('#memo-retry').isVisible(),'扩大窗口保存失败没有重试入口');
    check(!expanded.isClosed() && await expanded.locator('#memo-text').inputValue()===collapsedText,'保存失败阻止关闭大窗口并保留最新草稿');
    await app.evaluate(({app})=>{const load=process.mainModule.require.bind(process.mainModule);load(load('node:path').join(app.getAppPath(),'src/core/memos.cjs')).MemoStore.prototype.save=globalThis.__memoSaveOriginal;});
    // Native title-bar close also waits for persistence.
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/memo.html')).close());
    await eventually(async()=>expanded.isClosed() && await panel.locator('#memo-text').inputValue()===collapsedText,'原生关闭未保存并返回悬浮框');
    check((await memo(a.id)).text===collapsedText && (await memo(a.id)).images.length===2,'标题栏关闭保存最新文字，原有图片保留');
    const memoBeforeRestart = await memo(a.id), memoB = await memo(b.id), boundaries = await control();
    await app.close(); app = null;
    await launch(); await showMemo();
    await eventually(async () => await panel.locator('#memo-text').inputValue() === collapsedText && await panel.locator('.memo-image-card').count() === 2, '重启后笔记或图片没有回读');
    check(JSON.stringify(await memo(a.id)) === JSON.stringify(memoBeforeRestart) && JSON.stringify(await memo(b.id)) === JSON.stringify(memoB), '重启完整保留两项目备忘录文字、图片和版本');
    check(await panel.locator('img.memo-image-preview').evaluateAll(images => images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0)), '重启后全部保留图片可以再次预览');
    const managedMemo = path.join(seed.projectFolder(a.id), '备忘录', 'memo.json');
    check(JSON.parse(await fs.readFile(managedMemo, 'utf8')).text === collapsedText && (await fs.readFile(path.join(path.dirname(managedMemo), 'memo.md'), 'utf8')).includes(`./images/${firstImage.fileName}`), '管理区独立 JSON 与 Markdown 成果真实写入磁盘');

    // Preserve a dirty localStorage draft through a process restart while the
    // authoritative memo save fails. The next process loads an unpatched core.
    const beforeFailedSave = await memo(a.id), recoveredText = `${collapsedText}\n保存失败时仍保留的最新草稿。`;
    await app.evaluate(({ app }) => {
      const load = process.mainModule.require.bind(process.mainModule);
      const { MemoStore } = load(load('node:path').join(app.getAppPath(), 'src/core/memos.cjs'));
      MemoStore.prototype.save = function () { throw new Error('隔离模拟：备忘录磁盘暂时不可写'); };
    });
    await panel.locator('#memo-text').fill(recoveredText);
    await eventually(async () => (await panel.locator('#memo-save-status').innerText()).includes('保存失败'), '模拟保存失败没有显示错误');
    check(await panel.locator('#memo-text').inputValue() === recoveredText && await panel.locator('#memo-retry').isVisible(), '保存失败保留正在编辑的文字并提供重试');
    check(JSON.stringify(await memo(a.id)) === JSON.stringify(beforeFailedSave) && JSON.parse(await fs.readFile(managedMemo, 'utf8')).text === collapsedText, '失败保存不覆盖已有真实 JSON 和版本');
    check(await panel.evaluate(({ id, text }) => Object.keys(localStorage).some(key => key.startsWith('fde:memo-draft:') && key.includes(id) && JSON.parse(localStorage.getItem(key)).text === text), { id: a.id, text: recoveredText }), '保存失败的最新文字已经写入本项目本地恢复草稿');
    await app.close(); app = null;
    await launch(); await showMemo();
    await eventually(async () => await panel.locator('#memo-text').inputValue() === recoveredText, '新进程没有恢复未保存草稿');
    await eventually(async () => (await memo(a.id)).text === recoveredText && (await panel.locator('#memo-save-status').innerText()).includes('已保存'), '恢复草稿没有自动持久保存');
    const finalMemo = await memo(a.id);
    check(finalMemo.revision === beforeFailedSave.revision + 1 && JSON.stringify(finalMemo.images) === JSON.stringify(beforeFailedSave.images) && JSON.stringify(await memo(b.id)) === JSON.stringify(memoB), '新进程恢复最新草稿并自动保存一次，图片和另一项目保留');
    check(await panel.evaluate(id => !Object.keys(localStorage).some(key => key.startsWith('fde:memo-draft:') && key.includes(id)), a.id), '草稿成功恢复保存后清除临时恢复副本');
    check(JSON.stringify(await Promise.all(originalFiles.map(hashFile))) === JSON.stringify(sourceBefore), '全部隔离客户原始文件和开发文件内容保持不变');
    check(imageNetworkRequests.length === 0 && (await request('state')).projects.every(project => !project.codex?.threadId), '备忘录验收无网络请求、无真实模型或会话读取');
    check(errors.length === 0, '双窗口无未处理渲染异常');
    check(await panel.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), '430 像素悬浮窗无水平溢出');
    const layout = await panel.evaluate(() => {
      const images = document.getElementById('memo-images').getBoundingClientRect(), footer = document.querySelector('.float-footer').getBoundingClientRect();
      const editor = document.getElementById('memo-text').getBoundingClientRect(), status = document.getElementById('memo-save-status').getBoundingClientRect();
      return { imagesBottom: images.bottom, footerTop: footer.top, editorBottom: editor.bottom, statusTop: status.top };
    });
    check(layout.imagesBottom <= layout.footerTop + 1 && layout.editorBottom <= layout.statusTop + 1, '编辑区与图片区各自滚动且完整处于 footer 上方，不被固定操作栏覆盖');
    screenshot = path.join(output, PORTABLE ? '20-悬浮备忘录-便携版.png' : '20-悬浮备忘录-源码.png');
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/float.html')); window.show(); window.focus(); });
    await panel.screenshot({ path: screenshot });
    await app.close(); app = null;
    check(realBefore === await hashFile(realStore), '真实便携版 store.json SHA256 前后不变');
    reportPath = path.join(output, PORTABLE ? '备忘录验收-便携版.json' : '备忘录验收-源码.json');
    const report = {
      status: 'passed', mode: PORTABLE ? 'portable' : 'source', checkCount: checks.length, checks, fixture, dataDir, screenshot,
      projectCount: projects.length, imageCount: finalMemo.images.length, memoRevision: finalMemo.revision,
      clipboard: { textCopies: boundaries.copiedTexts.length, imageCopies: boundaries.copiedImages.length, reads: boundaries.readCalls },
      pickerCalls: boundaries.pickerCalls, revealCalls: boundaries.reveals.length, networkRequests: imageNetworkRequests.length, realStoreUnchanged: true,
      boundary: '真实双窗、renderer ClipboardEvent、PNG 解码、磁盘和草稿重启恢复；仅 Electron 系统剪贴板、图片选择器、Explorer 及临时保存失败边界使用 mock。未操作用户剪贴板，未访问真实客户正文、Codex 会话或模型密钥。',
    };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, mode: report.mode, checkCount: checks.length, projectCount: projects.length, imageCount: finalMemo.images.length, realStoreUnchanged: true, report: reportPath, screenshot, boundary: report.boundary }));
  } catch (error) {
    const failedReport = path.join(output, PORTABLE ? '备忘录验收失败-便携版.json' : '备忘录验收失败-源码.json');
    if (panel && app) { try { await panel.screenshot({ path: path.join(output, PORTABLE ? '20-悬浮备忘录失败-便携版.png' : '20-悬浮备忘录失败-源码.png') }); } catch {} }
    await fs.writeFile(failedReport, JSON.stringify({ status: 'failed', mode: PORTABLE ? 'portable' : 'source', fixture, checks, error: error.message, rendererErrors: errors, realStoreUnchanged: realBefore === await hashFile(realStore) }, null, 2));
    throw error;
  } finally { if (app) await app.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
