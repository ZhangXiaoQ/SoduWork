'use strict';

// Account-only renderer fixtures have no native archives. Keep their existing
// directory response while honoring the desktop preload's local capability.
function create(readAccount, { local } = {}) {
  const workspace = require('node:crypto').randomUUID();
  return async (event, options) => {
    if (options?.source !== 'local') return readAccount(event, options);
    if (local) return local(options);
    if (options.workspace !== undefined && options.workspace !== workspace) throw Error('Local history workspace changed');
    return { ok: true, chats: [], next: null, localCatalog: { workspace, revision: 0,
      ...(options.catalogRevision === 0 ? {} : { items: [] }) } };
  };
}
module.exports = { create };
