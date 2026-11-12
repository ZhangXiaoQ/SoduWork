'use strict';
const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}

// Windows cannot recycle the long source path. Recycle a verified recovery
// bundle first and remove the source only after the shell confirms success.
// A crash or failure before that point always leaves the original archive.
async function recycleLongPath(shell, filePath) {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw Error('Invalid archive file');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'SoduWork-recycle-'));
  const copy = path.join(folder, path.basename(filePath));
  const info = path.join(folder, 'restore-info.json');
  try {
    if (copy.length >= 260) throw Error('Recovery archive path is too long');
    await fs.copyFile(filePath, copy, constants.COPYFILE_EXCL);
    const originalHash = await digest(filePath);
    if (originalHash !== await digest(copy)) throw Error('Archive recovery copy did not match');
    const recovery = await fs.open(info, 'wx');
    try {
      await recovery.writeFile(JSON.stringify({ originalPath: filePath, sha256: originalHash }, null, 2));
      await recovery.sync();
    } finally { await recovery.close(); }
    const copied = await fs.open(copy, 'r+');
    try { await copied.sync(); } finally { await copied.close(); }
    await shell.trashItem(folder);
    const remaining = await fs.lstat(folder).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (remaining) throw Error('Recovery archive was not moved to the Recycle Bin');
    const after = await fs.lstat(filePath);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || originalHash !== await digest(filePath)) {
      throw Error('Archive changed while recycling; original archive retained');
    }
    await fs.unlink(filePath);
  } finally {
    // Only remove the two copies created above, never any source archive.
    await fs.unlink(copy).catch(() => {});
    await fs.unlink(info).catch(() => {});
    await fs.rmdir(folder).catch(() => {});
  }
}
module.exports = { recycleLongPath };
