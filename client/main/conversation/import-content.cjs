'use strict';

// Import only already-durable bytes from this computer's endpoint store. The
// SQLite worker verifies the complete checksum before publishing a local copy.
async function run({ history, identity, pointer, metadata, guard, rpc = require('../runner-runtime').rpc }) {
  const crypto = require('node:crypto');
  if (!pointer || !/^[a-f0-9]{64}$/.test(pointer.scope) || !/^[a-f0-9]{64}$/.test(pointer.sha256) ||
      !Number.isSafeInteger(pointer.size) || pointer.size < 0 || pointer.size > 128 * 1024 * 1024 ||
      !metadata || typeof metadata.id !== 'string' || !metadata.id.startsWith('acct-')) throw Error('Invalid history migration');
  const realm = crypto.createHash('sha256').update(String(identity.hub).replace(/\/+$/, '')).digest('hex');
  const id = 'migrated-' + crypto.createHash('sha256').update(realm + ':' + metadata.id).digest('hex');
  let sourceLocalId = '';
  if (metadata.sourceClientId === identity.clientId && typeof metadata.sourceSessionId === 'string') {
    const source = await history.resolve(metadata.sourceSessionId);
    if (source && !source.cached) sourceLocalId = source.id;
  }
  async function download(part) {
    for (let offset = 0; offset < Math.max(1, part.size); offset += 256 * 1024) {
      await guard(true);
      const reply = await rpc('runtime.content.read', { realm, scope: part.scope, sha256: part.sha256, offset }, 15000);
      if (!reply?.ok || reply.data?.scope !== part.scope || reply.data?.offset !== offset || reply.data?.sha256 !== part.sha256 || reply.data?.size !== part.size)
        throw Error('Migrated history receipt mismatch');
      const result = await history.store.importChunk(id, part, offset, reply.data.b64);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  const loaded = await download(pointer);
  if (!loaded.ok) return loaded;
  const plan = await history.store.importPlan(id, pointer);
  for (let index = 0; index < (plan?.pages.length || 0); index++) {
    await guard(true);
    const page = plan.pages[index];
    if (page.staged) continue;
    const result = await download(page);
    if (!result.ok) return result;
    await guard(true);
    await history.store.importPage(id, pointer, page, index);
  }
  await guard(true);
  const receipt = await history.store.sealImport(id, pointer, { title: String(metadata.title || '').slice(0, 200),
    archived: metadata.archived === true, deleted: metadata.deleted === true,
    adapterId: 'account-sync', createdAt: metadata.createdAt || '',
    sourceLocalId,
    creator: { account: require('../device-auth-request').accountId(identity), hub: identity.hub },
    source: { id: metadata.id, hub: identity.hub } });
  return { ...receipt, id };
}
module.exports = { run };
