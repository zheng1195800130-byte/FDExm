'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const IMAGE_LIMIT = 20 * 1024 * 1024;
const TEXT_LIMIT = 200000;

function createMemoActions({ memos, clipboard, ClipboardItem, nativeImage, dialog, shell, windowForSender }) {
  function text(value) {
    if (typeof value !== 'string' || value.length > TEXT_LIMIT || value.includes('\0')) throw new Error('备忘录文字无效或超过 20 万字');
    return value;
  }
  function pngFromImage(image) {
    if (!image || image.isEmpty()) throw new Error('无法读取这张图片，请使用 PNG、JPG、WebP、GIF 或 BMP');
    const { width, height } = image.getSize();
    if (!width || !height || width * height > 50000000) throw new Error('图片尺寸过大，请缩小后添加');
    const png = image.toPNG();
    if (!png.length || png.length > IMAGE_LIMIT) throw new Error('图片超过 20 MB，请缩小后添加');
    return png;
  }
  function decode(bytes) {
    let buffer;
    if (Buffer.isBuffer(bytes)) buffer = bytes;
    else if (bytes instanceof ArrayBuffer) buffer = Buffer.from(bytes);
    else if (ArrayBuffer.isView(bytes)) buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else throw new Error('图片内容无效');
    if (!buffer.length || buffer.length > IMAGE_LIMIT) throw new Error('图片超过 20 MB 或内容为空');
    // Reject document/vector content before invoking the native raster decoder.
    const raster = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      (buffer[0] === 255 && buffer[1] === 216) || /^(GIF87a|GIF89a|BM)/.test(buffer.subarray(0, 6).toString('ascii')) ||
      (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP');
    if (!raster) throw new Error('请添加 PNG、JPG、WebP、GIF 或 BMP 图片');
    return pngFromImage(nativeImage.createFromBuffer(buffer));
  }
  async function imageFor(projectId, imageId) {
    const imagePath = memos.imagePath(projectId, imageId);
    const stat = await fs.stat(imagePath);
    if (stat.size > IMAGE_LIMIT) throw new Error('备忘录图片过大，请打开目录查看');
    const image = nativeImage.createFromBuffer(await fs.readFile(imagePath));
    if (image.isEmpty()) throw new Error('备忘录图片无法读取，请打开目录检查');
    return { image, imagePath };
  }
  return async function dispatch(action, p, sender) {
    // Every path goes through the project callback, including clipboard-only
    // actions, so a stale selection cannot accidentally target another project.
    switch (action) {
      case 'memo:get': return memos.get(p.id);
      case 'memo:save': return memos.save(p.id, { text: text(p.text), expectedRevision: p.expectedRevision });
      case 'memo:add-image': return memos.addImage(p.id, { buffer: decode(p.bytes), name: p.name || '粘贴图片.png' });
      case 'memo:add-images': {
        const previous = memos.get(p.id);
        const result = await dialog.showOpenDialog(windowForSender(sender), {
          title: '添加备忘录图片', properties: ['openFile', 'multiSelections'],
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
        });
        if (result.canceled) return previous;
        if (result.filePaths.length > 20 || previous.images.length + result.filePaths.length > 50) throw new Error('每次最多添加 20 张，备忘录最多保留 50 张图片');
        let latest = previous, added = 0;
        for (const source of result.filePaths) {
          try {
            if ((await fs.stat(source)).size > IMAGE_LIMIT) throw new Error('图片超过 20 MB');
            latest = memos.addImage(p.id, { buffer: decode(await fs.readFile(source)), name: path.basename(source) });
            added++;
          } catch (error) {
            if (!added) throw error;
            return { ...latest, warning: `已添加 ${added} 张图片，其余未添加：${error.message}` };
          }
        }
        return latest;
      }
      case 'memo:paste': {
        memos.get(p.id);
        const pastedText = text(await clipboard.readText());
        let png;
        if (typeof clipboard.readImage === 'function') {
          const image = await clipboard.readImage();
          if (!image.isEmpty()) png = pngFromImage(image);
        } else {
          for (const item of await clipboard.read()) {
            const mime = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].find(type => item.types.includes(type));
            if (!mime) continue;
            const blob = await item.getType(mime);
            if (blob.size > IMAGE_LIMIT) throw new Error('剪贴板图片超过 20 MB，请缩小后添加');
            png = decode(Buffer.from(await blob.arrayBuffer()));
            break;
          }
        }
        if (png) return { text: pastedText, memo: memos.addImage(p.id, { buffer: png, name: '粘贴截图.png' }) };
        if (!pastedText) throw new Error('剪贴板中没有文字或图片');
        return { text: pastedText };
      }
      case 'memo:preview': {
        const note = memos.get(p.id), entry = note.images.find(image => image.id === p.imageId);
        const { image, imagePath } = await imageFor(p.id, p.imageId);
        return { name: entry.name, path: imagePath, dataUrl: image.resize({ width: Math.min(image.getSize().width, 1000) }).toDataURL() };
      }
      case 'memo:copy-text': memos.get(p.id); await clipboard.writeText(text(p.text)); return true;
      case 'memo:copy-image': {
        const { image } = await imageFor(p.id, p.imageId);
        if (typeof clipboard.writeImage === 'function') await clipboard.writeImage(image);
        else await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })]);
        return true;
      }
      case 'memo:reveal-image': shell.showItemInFolder(memos.imagePath(p.id, p.imageId)); return true;
      case 'memo:remove-image': return memos.removeImage(p.id, p.imageId);
      default: throw new Error('不支持的备忘录操作');
    }
  };
}

module.exports = { createMemoActions };
