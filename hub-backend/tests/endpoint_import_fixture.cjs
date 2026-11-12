'use strict';
// The fixture emulates transport only; imports use the real desktop worker and
// SQLite durability protocol. Python supplies bytes read from the real Runner.
const readline = require('node:readline');
const path = require('node:path');
const { createWorker } = require('../../client/main/conversation/replica-store.cjs');
const { run } = require('../../client/main/conversation/import-content.cjs');
const input = readline.createInterface({ input: process.stdin });
input.once('line', async line => {
  input.close();
  const request = JSON.parse(line), store = createWorker(path.join(request.root, 'replicas.sqlite'));
  try {
    if (request.deletedSource) {
      await store.register([{ id: request.metadata.sourceSessionId, adapterId: 'pi' }]);
      await store.lifecycle(request.metadata.sourceSessionId, 'delete');
    }
    const receipt = await run({ history: { store, resolve: id => store.get(id) },
      identity: request.identity, pointer: request.pointer, metadata: request.metadata,
      guard: async () => {}, rpc: async (op, args) => {
        if (op !== 'runtime.content.read' || args.scope !== request.pointer.scope)
          throw Error('Unexpected fixture content request');
        const data = request.chunks.find(chunk => chunk.offset === args.offset && chunk.sha256 === args.sha256);
        return { ok: !!data, data };
      } });
    const row = await store.get(receipt.id), messages = await store.messages(receipt.id);
    let total = 0, after = -1, lastText = '';
    do {
      const page = await store.messages(receipt.id, { after });
      total += page.items.length; lastText = page.items.at(-1)?.text || lastText;
      after = page.next;
    } while (after != null);
    process.stdout.write(JSON.stringify({ receipt, row, messages, total, lastText }) + '\n');
  } catch (error) { process.stderr.write(error.stack);process.exitCode = 1; }
  finally { await store.close(); }
});
