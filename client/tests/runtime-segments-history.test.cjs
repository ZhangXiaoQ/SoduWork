'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const segments = require('../main/conversation/runtime-segments');

test('runtime history merges authenticated account aliases without joining an independent namesake', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-history-'));
  const app = { getPath: () => root };
  const record = {
    version: 1, id: 'public-conversation', owner: 'owner-a', cwd: root, at: 1,
    title: 'Original conversation', prefix: { messages: [], tools: [] },
    active: { sessionId: 'native-segment', adapterId: 'opencode', path: '' },
    segments: [{ sessionId: 'native-segment', adapterId: 'opencode', path: '' }],
  };
  try {
    await segments.save(app, record);
    await segments.flush(app, record.id);
    const rows = segments.mergeHistory(app, [
      { id: 'account-copy', sourceSessionId: 'native-segment', historyAliasIds: ['public-conversation', 'native-segment'],
        title: 'Original conversation', adapterId: 'opencode', usedHarnesses: ['opencode'] },
      { id: 'native-segment', title: 'runtime error copy', adapterId: 'opencode', state: 'unreachable' },
      { id: 'foreign-copy', sourceSessionId: 'native-segment', title: 'Original conversation', adapterId: 'pi' },
      { id: 'independent', title: 'Original conversation', adapterId: 'pi' },
    ]);
    assert.deepEqual(rows.map(row => row.id).sort(), ['foreign-copy', 'independent', 'public-conversation']);
    const merged = rows.find(row => row.id === record.id);
    assert.deepEqual(new Set(merged.historyAliasIds), new Set(['account-copy', 'native-segment', 'public-conversation']));
    assert.equal(rows.find(row => row.id === 'independent').title, 'Original conversation');
    assert.equal(rows.find(row => row.id === 'foreign-copy').id, 'foreign-copy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
