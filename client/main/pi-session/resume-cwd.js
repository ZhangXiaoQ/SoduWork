'use strict';

const fs = require('fs');
const path = require('path');

/* Validate persisted history directories before handing them to Pi. A
   conversation may outlive a renamed project, disconnected share, or old
   machine path; the archive remains authoritative while execution falls
   back to the current SoduWork workspace. Renderer options cannot relocate
   an existing conversation away from its persisted working directory. */
module.exports = function resumeCwd(app, resume, fallback) {
  const candidate = String(resume && resume.cwd || '').trim();
  if (candidate) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return path.resolve(candidate);
    } catch (_) { /* stale or inaccessible cwd */ }
  }
  return fallback(app);
};
