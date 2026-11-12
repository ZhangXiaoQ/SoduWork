'use strict';

// Serialized into the installed Electron main process; keep this function
// self-contained. The marker is synthetic, and only its hash enters receipts.
function secureStorageProbe(profile, mode) {
  const fs = process.mainModule.require('node:fs');
  const path = process.mainModule.require('node:path');
  const crypto = process.mainModule.require('node:crypto');
  const { safeStorage } = process.mainModule.require('electron');
  if (!path.isAbsolute(profile) || !path.basename(profile).startsWith('soduwork-acceptance-profile-'))
    throw Error('Secure-storage probe requires an isolated acceptance profile');
  if (!['write', 'read'].includes(mode)) throw Error('Invalid secure-storage marker mode');
  const directory = fs.lstatSync(profile);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Unsafe secure-storage acceptance profile');
  if (!safeStorage.isEncryptionAvailable()) throw Error('Electron safeStorage is unavailable');
  const file = path.join(profile, 'acceptance-secure-storage.bin');
  const marker = 'soduwork-keychain-smoke-v1';
  if (mode === 'write') {
    // Never replace earlier ciphertext: a fresh key must not hide data loss.
    fs.writeFileSync(file, safeStorage.encryptString(marker), { flag: 'wx', mode: 0o600 });
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 65536)
    throw Error('Invalid secure-storage acceptance ciphertext');
  const cipher = fs.readFileSync(file);
  if (safeStorage.decryptString(cipher) !== marker)
    throw Error('Electron safeStorage did not preserve the earlier ciphertext');
  return { available: true, roundTrip: true, persisted: true, mode,
    ciphertextSha256: crypto.createHash('sha256').update(cipher).digest('hex') };
}

module.exports = { secureStorageProbe };
