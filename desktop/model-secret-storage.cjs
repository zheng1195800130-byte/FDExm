'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createDecipheriv } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HEADER = Buffer.from('FDE-DPAPI-1\n');
const ENTROPY = Buffer.from('FDE Desk/model-key/v1');

// Only fixed code is passed on the command line. Secret bytes travel through
// anonymous pipes, never arguments, environment variables, logs or temp files.
function windowsDpapi(operation, bytes, entropy = null) {
  if (!['protect', 'unprotect'].includes(operation)) throw new Error('无效的系统密钥操作');
  const method = operation === 'protect' ? 'Protect' : 'Unprotect';
  const script = `$ErrorActionPreference='Stop'; try {
    Add-Type -AssemblyName System.Security;
    $fdeBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());
    $fdeEntropy=${entropy ? `[Convert]::FromBase64String('${entropy.toString('base64')}')` : '$null'};
    $fdeResult=[Security.Cryptography.ProtectedData]::${method}($fdeBytes,$fdeEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Console]::Out.Write([Convert]::ToBase64String($fdeResult));
  } catch { exit 1 }`;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    input: bytes.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024
  });
  const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (result.error || result.status !== 0 || !output || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) throw new Error('Windows 账户密钥保护暂不可用，原密钥已保留');
  return Buffer.from(output, 'base64');
}

function createModelSecretStorage({ dataDir, safeStorage, platform = process.platform, dpapi = windowsDpapi }) {
  if (platform !== 'win32') return safeStorage;
  let cachedBytes, cachedText;
  const native = bytes => bytes.subarray(0, HEADER.length).equals(HEADER);
  function recoverLegacy(bytes) {
    // Chromium v10: AES-256-GCM; its master key is protected for the same
    // Windows user. Read only this archive's encryption context, never caches
    // or unrelated applications. The GCM tag authenticates recovered text.
    if (bytes.length < 31 || bytes.subarray(0, 3).toString() !== 'v10') throw new Error('不支持的旧密钥格式');
    for (const relative of ['runtime/browser/Local State', 'runtime/Local State']) {
      let master;
      try {
        const file = path.join(dataDir, relative);
        if (fs.statSync(file).size > 64 * 1024) continue;
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        const wrapped = Buffer.from(state.os_crypt?.encrypted_key || '', 'base64');
        if (wrapped.subarray(0, 5).toString() !== 'DPAPI') continue;
        master = dpapi('unprotect', wrapped.subarray(5));
        if (master.length !== 32) continue;
        const decipher = createDecipheriv('aes-256-gcm', master, bytes.subarray(3, 15));
        decipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([decipher.update(bytes.subarray(15, -16)), decipher.final()]).toString('utf8');
      } catch { /* Try the other supported legacy profile location. */ }
      finally { master?.fill(0); }
    }
    throw new Error('旧密钥自动恢复未成功');
  }
  return {
    isEncryptionAvailable: () => true,
    shouldReEncrypt: bytes => !native(bytes),
    encryptString(text) {
      const bytes = Buffer.concat([HEADER, dpapi('protect', Buffer.from(text), ENTROPY)]);
      cachedBytes = Buffer.from(bytes); cachedText = text;
      return bytes;
    },
    decryptString(bytes) {
      if (cachedBytes?.equals(bytes)) return cachedText;
      let text;
      if (native(bytes)) text = dpapi('unprotect', bytes.subarray(HEADER.length), ENTROPY).toString('utf8');
      else {
        try { text = safeStorage.decryptString(bytes); }
        catch { text = recoverLegacy(bytes); }
      }
      cachedBytes = Buffer.from(bytes); cachedText = text;
      return text;
    }
  };
}
module.exports = { createModelSecretStorage, windowsDpapi, HEADER };
