'use strict';
// Use only an official, checksum-verified archive already downloaded locally.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
const root = path.resolve(__dirname, '..');
const version = require('electron/package.json').version;
const name = `electron-v${version}-win32-x64.zip`;
const archive = path.join(root, '.electron-cache', 'official', name);
const expected = require('../node_modules/electron/checksums.json')[name];
const bytes = fs.readFileSync(archive);
if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Electron 运行时 SHA256 校验失败');
new AdmZip(bytes).extractAllTo(path.join(root, 'node_modules/electron/dist'), true);
fs.writeFileSync(path.join(root, 'node_modules/electron/path.txt'), 'electron.exe');
console.log(`Electron ${version} 官方运行时 SHA256 校验通过并已解压。`);
