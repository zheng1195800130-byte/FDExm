'use strict';
const packager = require('@electron/packager');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
// extract-zip can leave an unresolved promise with this host's Node runtime.
// Keep Packager's normal pipeline and use the verified archive via AdmZip.
const unzip = require(path.join(path.dirname(require.resolve('@electron/packager')), 'unzip.js'));
unzip.extractElectronZip = async (archive, target) => {
  const version = require('electron/package.json').version;
  const name = `electron-v${version}-win32-x64.zip`;
  const bytes = fs.readFileSync(archive);
  const expected = require('../node_modules/electron/checksums.json')[name];
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Electron 运行时 SHA256 校验失败');
  new AdmZip(bytes).extractAllTo(target, true);
};
(async () => {
  const locations = await packager({
    dir: path.resolve(__dirname, '..'), name: 'FDE Desk', platform: 'win32', arch: 'x64',
    // Build outside the app directory; overwriting a build must never delete user data.
    out: path.resolve(__dirname, '../../.fde-build/output'), overwrite: true, asar: true,
    tmpdir: path.resolve(__dirname, '../../.fde-build'),
    electronVersion: require('electron/package.json').version,
    electronZipDir: path.resolve(__dirname, '../.electron-cache/official'),
    icon: path.resolve(__dirname, '../assets/icon.ico'),
    ignore: [/^\/data($|\/)/, /^\/test-output($|\/)/, /^\/release($|\/)/, /^\/\.(?:git|githooks|fde-build|npm-cache|electron-cache|pack-tmp|test-tmp|tmp)($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/],
    prune: true, executableName: 'FDE Desk', appBundleId: 'local.fde.desk',
    win32metadata: { CompanyName: 'FDE Desk', FileDescription: '个人 FDE 工作台', ProductName: 'FDE Desk' }
  });
  if (!locations.length || !fs.existsSync(path.join(locations[0], 'FDE Desk.exe'))) throw new Error('未生成便携程序');
  for (const location of locations) {
    fs.copyFileSync(path.resolve(__dirname, '../README.md'), path.join(location, '使用说明.md'));
    fs.copyFileSync(path.resolve(__dirname, '../docs/开源复用说明.md'), path.join(location, '开源复用说明.md'));
    const verification = path.resolve(__dirname, '../docs/验证结果.md');
    if (fs.existsSync(verification)) fs.copyFileSync(verification, path.join(location, '验证结果.md'));
  }
  if (process.argv.includes('--stage-only')) {
    console.log(locations.join('\n'));
    return;
  }
  for (const location of locations) {
    const destination = path.resolve(__dirname, '../release', path.basename(location));
    // Copy application files into place, preserving the portable app's data folder.
    fs.cpSync(location, destination, { recursive: true, force: true, filter: source => path.relative(location, source).split(path.sep)[0] !== 'data' });
    console.log(destination);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
