const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createArchiveHistory, readSummary } = require('../main/pi-session/archive-history');
const sessions = require('../main/pi-session/session');
const archiveState = require('../main/pi-session/archive-state');

const header = id => ({ type: 'session', version: 3, id, timestamp: '2026-09-01T00:00:00Z', cwd: '/project' });
const message = text => ({ type: 'message', timestamp: '2026-09-02T00:00:00Z',
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1788307200000 } });
const binding = (id, title) => ({ type: 'custom', customType: 'soduwork.task.binding', data: { taskId: id, taskTitle: title } });
const encode = entries => entries.map(row => JSON.stringify(row)).join('\n') + '\n';

test('archive history records all actual runtime sources without promoting an unused selection', async t => {
  const f = await fixture(t);
  const output = (sourceAgent, role = 'assistant') => ({ type: 'message', timestamp: '2026-09-02T00:01:00Z',
    message: { role, content: [{ type: 'text', text: 'Output' }], sourceAgent } });
  const file = await f.write('runtime-sources', [header('runtime-sources'), message('Question'),
    { type: 'custom', customType: 'model', data: { adapterId: 'opencode' } },
    output(undefined), output({ agentId: 'qwen' }), output({ agentId: 'qwen' }, 'toolResult'),
    { ...output(undefined), message: { role: 'assistant', taskId: 'legacy-task', content: 'Unknown task source' } },
    output({ agentId: 'not-a-runtime' }), output({ agentId: 'claude' }),
    { type: 'custom', customType: 'soduwork.task.tool', data: { event: { sourceAgent: { agentId: 'codex-harness' } } } }]);
  const before = await fs.readFile(file, 'utf8');
  const row = (await sessions.historyEntry(f.app, 'runtime-sources')).entry;
  assert.deepEqual(row.usedHarnesses, ['pi', 'qwen', 'claude', 'codex-harness']);
  await fs.appendFile(file, encode([output({ agentId: 'harness2' })]));
  assert.deepEqual((await sessions.historyEntry(f.app, 'runtime-sources')).entry.usedHarnesses,
    ['pi', 'qwen', 'claude', 'codex-harness', 'harness2']);
  assert.ok((await fs.readFile(file, 'utf8')).startsWith(before), 'projection never rewrites source records');
  await f.write('unanswered', [header('unanswered'), message('Not answered'), binding('task', 'Task')]);
  assert.deepEqual((await sessions.historyEntry(f.app, 'unanswered')).entry.usedHarnesses, []);
});
const moved = dir => ({ type: 'custom', customType: 'soduwork.workspace.moved', data: { version: 1, cwd: dir } });

test('换个文件夹继续：存档投影优先返回最新的工作目录覆盖', async t => {
  const f = await fixture(t);
  await f.write('moved-once', [header('moved-once'), message('Question'), moved('D:/new/place')]);
  assert.equal((await sessions.historyEntry(f.app, 'moved-once')).entry.cwd, 'D:/new/place');
  /* 多次换目录时，最新一次生效。 */
  await f.write('moved-twice', [header('moved-twice'), message('Question'),
    moved('D:/first/place'), moved('D:/second/place')]);
  assert.equal((await sessions.historyEntry(f.app, 'moved-twice')).entry.cwd, 'D:/second/place');
  /* 没有换目录记录的会话仍返回存档头部目录。 */
  await f.write('unmoved', [header('unmoved'), message('Question')]);
  assert.equal((await sessions.historyEntry(f.app, 'unmoved')).entry.cwd, '/project');
});

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-history-index-'));
  const root = path.join(base, 'pi-agent'), directory = path.join(root, 'sessions', 'project');
  await fs.mkdir(directory, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const write = async (id, entries = [header(id), message('Original title')]) => {
    const file = path.join(directory, id + '.jsonl');
    await fs.writeFile(file, encode(entries));
    return file;
  };
  return { base, root, directory, write, app: { getPath: () => base } };
}
function tracked(root, reader = readSummary) {
  let reads = 0;
  const index = createArchiveHistory({ root, project: s => ({
    id: s.id, path: s.path, at: s.modified, title: s.firstMessage, count: s.messageCount,
  }), read: async (...args) => { reads++; return reader(...args); } });
  return { index, reads: () => reads };
}

test('more than 500 archives remain cached; an identity lookup reads no other transcript', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 512 }, (_, n) => f.write('chat-' + n)));
  const { index, reads } = tracked(f.root);
  assert.equal((await index.list()).length, 512);
  assert.equal(reads(), 512);
  await Promise.all([index.list(), index.list(), index.list()]);
  assert.equal(reads(), 512);
  assert.equal((await index.find('chat-511')).id, 'chat-511');
  assert.equal(reads(), 512);
  await fs.appendFile(path.join(f.directory, 'chat-511.jsonl'), encode([message('followup')]));
  assert.equal((await index.find('chat-511')).count, 2);
  await index.list();
  assert.equal(reads(), 513);
});

test('cold identity lookup reads only the requested archive before the sidebar index is ready', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 128 }, (_, n) => f.write('chat-' + n)));
  const { index, reads } = tracked(f.root);
  assert.equal((await index.find('chat-127')).id, 'chat-127');
  assert.equal(reads(), 1);
});

test('internal context never enters cold, cached, direct or archived conversation titles', async t => {
  const connector = require('../main/pi-session/connector-context.cjs');
  const plugins = require('../main/pi-session/plugin-context');
  const f = await fixture(t);
  const raw = connector.augment(plugins.augment('你好', [
    { pluginId: 'fixture', name: 'Fixture', context: 'private-plugin-guide' },
  ]), 'private-connector-guide');
  const entry = message(raw);
  const file = await f.write('with-context', [header('with-context'), entry]);
  const before = await fs.readFile(file, 'utf8');
  assert.equal((await sessions.history(f.app, 50)).chats[0].title, '你好');
  assert.equal((await sessions.history(f.app, 50)).chats[0].title, '你好');
  assert.equal((await sessions.historyEntry(f.app, 'with-context')).entry.title, '你好');
  await sessions.archiveHistory(f.app, 'with-context');
  assert.equal((await sessions.archivedHistory(f.app)).chats[0].title, '你好');
  assert.equal(await fs.readFile(file, 'utf8'), before, 'title projection must not rewrite the transcript');
});
test('real session history preserves task bindings, list order, empty bound chats and old identities', async t => {
  const f = await fixture(t);
  const file = await f.write('bound', [header('bound'), message('Original title'), binding('a', 'Task A'), binding('b', 'Task B')]);
  await f.write('empty-bound', [header('empty-bound'), binding('c', 'Task C')]);
  await f.write('empty', [header('empty')]);
  const initial = await sessions.history(f.app, 50);
  assert.equal(initial.ok, true);
  assert.equal(initial.chats.length, 2);
  const row = initial.chats.find(row => row.id === 'bound');
  assert.equal(row.title, 'Original title');
  assert.deepEqual(row.taskIds, ['a', 'b']);
  assert.equal(row.activeTaskId, 'b');
  assert.equal(initial.chats.find(row => row.id === 'empty-bound').title, 'Task C');
  // No new message/activity timestamp: metadata alone must invalidate the cache.
  await fs.appendFile(file, encode([binding('d', 'Task D')]));
  const updated = await sessions.historyEntry(f.app, 'bound');
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.entry.taskIds, ['a', 'b', 'd']);
  assert.equal(updated.entry.at, row.at, 'opening/binding must not reorder the sidebar');
  assert.equal(updated.entry.activeTaskId, 'd');
  assert.equal(updated.entry.title, 'Original title');
});

test('partial JSONL appends are recovered, and deleted or replaced archives cannot be resumed', async t => {
  const f = await fixture(t), file = await f.write('a');
  const { index, reads } = tracked(f.root);
  const added = JSON.stringify(message('next'));
  await fs.appendFile(file, added.slice(0, 25));
  assert.equal((await index.list())[0].count, 1);
  await fs.appendFile(file, added.slice(25) + '\n');
  assert.equal((await index.find('a')).count, 2);
  assert.equal(reads(), 2);
  await fs.writeFile(file, encode([header('replacement'), message('new identity')]));
  assert.equal(await index.find('a'), null);
  assert.equal((await index.find('replacement')).title, 'new identity');
  await fs.unlink(file);
  assert.equal(await index.find('replacement'), null);
  assert.deepEqual(await index.list(), []);
  assert.equal(await index.find('../../outside'), null);
});

test('concurrent lists coalesce and a live append during parsing is not cached as current', async t => {
  const f = await fixture(t), file = await f.write('a');
  let changed = false;
  const { index, reads } = tracked(f.root, async (...args) => {
    const row = await readSummary(...args);
    if (!changed) { changed = true; await fs.appendFile(file, encode([message('during scan')])); }
    return row;
  });
  await Promise.all([index.list(), index.list(), index.list()]);
  assert.equal(reads(), 1);
  assert.equal((await index.list())[0].count, 2);
  assert.equal(reads(), 2);
  await index.list();
  assert.equal(reads(), 2);
});

test('identity lookup returns a row while an active archive keeps changing', async t => {
  const f = await fixture(t), file = await f.write('a');
  let scans = 0;
  const index = createArchiveHistory({ root: f.root, project: s => ({
    id: s.id, path: s.path, at: s.modified, title: s.firstMessage, count: s.messageCount,
  }), read: async (...args) => {
    const row = await readSummary(...args);
    scans += 1;
    if (scans <= 2) await fs.appendFile(file, encode([message('live-' + scans)]));
    return row;
  }});
  const listed = await index.list();
  assert.equal(listed[0].id, 'a');
  // The first scan changed during parsing, so it was intentionally not cached.
  // A click from the sidebar must still resolve the row returned by the retry scan.
  const found = await index.find('a');
  assert.equal(found.id, 'a');
  assert.ok(scans >= 2);
});

test('archive indexes are isolated by profile and missing/invalid archives do not invent sessions', async t => {
  const a = await fixture(t), b = await fixture(t);
  await a.write('same', [header('same'), message('Profile A')]);
  await b.write('same', [header('same'), message('Profile B')]);
  await a.write('broken', [{ type: 'message', message: {} }]);
  assert.equal((await sessions.historyEntry(a.app, 'same')).entry.title, 'Profile A');
  assert.equal((await sessions.historyEntry(b.app, 'same')).entry.title, 'Profile B');
  assert.equal((await sessions.historyEntry(a.app, 'missing')).notFound, true);
  assert.equal((await sessions.history(a.app, 50)).chats.length, 1);
  assert.deepEqual(await tracked(path.join(a.base, 'missing')).index.list(), []);
});

test('strict absence tolerates unrelated malformed archives and verifies moved identities', async t => {
  const f = await fixture(t), file = await f.write('moved');
  await f.write('unrelated-broken', [{ type: 'message', message: {} }]);
  await fs.rename(file, path.join(f.directory, 'renamed.jsonl'));
  const { index } = tracked(f.root);
  assert.equal((await index.find('moved', { strict: true })).id, 'moved');
  assert.equal(await index.find('absent', { strict: true }), null);
  await fs.unlink(path.join(f.directory, 'renamed.jsonl'));
  assert.equal(await index.find('moved', { strict: true }), null);
});

for (const code of ['EACCES', 'EPERM']) test('strict lookup does not treat a ' + code + ' transcript as missing', async t => {
  const f = await fixture(t);
  await f.write('denied');
  const { index } = tracked(f.root, async () => { throw Object.assign(Error('fixture permission failure'), { code }); });
  assert.equal(await index.find('denied'), null, 'ordinary sidebar lookup retains its tolerant behavior');
  await assert.rejects(index.find('denied', { strict: true }), { code });
  await assert.rejects(index.find('denied', { strict: true }), { code }, 'retry retains the failure');
});

test('strict lookup refuses incomplete directory enumeration instead of proving absence', async t => {
  const f = await fixture(t);
  await f.write('denied-directory');
  const realReadDir = fs.readdir;
  const realDirectory = await fs.realpath(f.directory);
  t.mock.method(fs, 'readdir', async (directory, ...args) => {
    if (path.resolve(directory) === path.resolve(f.directory) || path.resolve(directory) === realDirectory)
      throw Object.assign(Error('fixture inaccessible directory'), { code: 'EACCES' });
    return realReadDir(directory, ...args);
  });
  const { index } = tracked(f.root);
  assert.equal(await index.find('denied-directory'), null);
  await assert.rejects(index.find('denied-directory', { strict: true }), { code: 'EACCES' });
});

test('strict lookup rejects a corrupt or replaced target even after tolerant lookup cached it', async t => {
  const f = await fixture(t);
  const { index } = tracked(f.root);
  for (const [id, entries] of [['empty-target', []], ['bad-header', [{ type: 'message', message: {} }]],
    ['replaced-target', [header('different-id'), message('different conversation')]]]) {
    const file = await f.write(id, entries);
    assert.equal(await index.find(id), null);
    await assert.rejects(index.find(id, { strict: true }), { code: 'HISTORY_ARCHIVE_INVALID' });
    assert.equal(await fs.readFile(file, 'utf8'), encode(entries), 'strict checks never rewrite the archive');
  }
});

test('strict lookup keeps a known renamed target identifiable across repeated corrupt reads', async t => {
  const f = await fixture(t), original = await f.write('renamed-target');
  const file = path.join(f.directory, 'legacy-name.jsonl');
  await fs.rename(original, file);
  const { index } = tracked(f.root);
  assert.equal((await index.find('renamed-target', { strict: true })).id, 'renamed-target');
  await fs.writeFile(file, '{broken-json\n');
  await assert.rejects(index.find('renamed-target', { strict: true }), { code: 'HISTORY_ARCHIVE_INVALID' });
  await assert.rejects(index.find('renamed-target', { strict: true }), { code: 'HISTORY_ARCHIVE_INVALID' });
});

test('strict absence does not reuse a tolerant in-flight permission failure', async t => {
  const f = await fixture(t);
  await f.write('shared-denied');
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  const { index } = tracked(f.root, async () => {
    started(); await pending;
    throw Object.assign(Error('fixture permission failure'), { code: 'EPERM' });
  });
  const listing = index.list();
  await reading;
  const checked = assert.rejects(index.find('shared-denied', { strict: true }), { code: 'EPERM' });
  release();
  assert.deepEqual(await listing, []);
  await checked;
});

test('directories linked outside the archive root are rejected, including after a cached hit', async t => {
  const f = await fixture(t);
  const file = await f.write('safe');
  const { index } = tracked(f.root);
  assert.equal((await index.find('safe')).id, 'safe');
  const outside = path.join(f.base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'safe.jsonl'), encode([header('safe'), message('not authorized')]));
  await fs.unlink(file);
  await fs.rmdir(f.directory);
  await fs.symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await index.find('safe'), null);
  assert.deepEqual(await index.list(), []);
  await assert.rejects(index.find('safe', { strict: true }), { code: 'HISTORY_ARCHIVE_UNSAFE' });
});

test('a same-size rewrite and changed model metadata do not alter message activity order', async t => {
  const f = await fixture(t), file = await f.write('a', [header('a'), message('title-a')]);
  const { index } = tracked(f.root);
  const before = await index.find('a');
  await fs.writeFile(file, encode([header('a'), message('title-b')]));
  await fs.utimes(file, new Date(), new Date(Date.now() + 10000));
  const after = await index.find('a');
  assert.equal(after.title, 'title-b');
  assert.equal(after.at, before.at);
});


test('identity lookup finds moved archives and archives outside the 50-row sidebar', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 60 }, (_, i) => f.write('chat-' + i)));
  const page = await sessions.history(f.app, 50);
  assert.equal(page.chats.length, 50);
  const hidden = Array.from({ length: 60 }, (_, i) => 'chat-' + i).find(id => !page.chats.some(row => row.id === id));
  assert.equal((await sessions.historyEntry(f.app, hidden)).ok, true);
  const nextDirectory = path.join(f.root, 'sessions', 'moved');
  await fs.mkdir(nextDirectory);
  await fs.rename(path.join(f.directory, hidden + '.jsonl'), path.join(nextDirectory, 'renamed.jsonl'));
  const moved = await sessions.historyEntry(f.app, hidden);
  assert.equal(moved.ok, true);
  assert.equal(moved.entry.path, await fs.realpath(path.join(nextDirectory, 'renamed.jsonl')));
});

test('conversation archive lifecycle hides, restores and permanently removes the transcript', async t => {
  const f = await fixture(t), file = await f.write('archivable');
  assert.equal((await sessions.history(f.app, 50)).chats.some(row => row.id === 'archivable'), true);
  assert.equal((await sessions.archiveHistory(f.app, 'archivable')).ok, true);
  assert.equal((await sessions.history(f.app, 50)).chats.some(row => row.id === 'archivable'), false);
  assert.equal((await sessions.archivedHistory(f.app, 50)).chats.some(row => row.id === 'archivable'), true);
  assert.equal((await sessions.restoreHistory(f.app, 'archivable')).ok, true);
  assert.equal((await sessions.history(f.app, 50)).chats.some(row => row.id === 'archivable'), true);
  await sessions.archiveHistory(f.app, 'archivable');
  assert.equal((await sessions.permanentlyDeleteHistory(f.app, 'archivable')).permanentlyDeleted, true);
  await assert.rejects(() => fs.stat(file));
});

for (const linkAt of ['root', 'ancestor']) {
  test('permanent deletion refuses an external junction at the archive ' + linkAt, async t => {
    const f = await fixture(t), profile = path.join(f.base, 'linked-profile');
    const outside = path.join(f.base, 'outside-profile');
    const actualRoot = linkAt === 'root' ? outside : path.join(outside, 'pi-agent');
    const directory = path.join(actualRoot, 'sessions', 'project'); await fs.mkdir(directory, {recursive: true});
    const file = path.join(directory, 'external-root.jsonl'), bytes = encode([header('external-root'), message('Outside profile')]);
    await fs.writeFile(file, bytes);
    archiveState.write(actualRoot, {conversations: {'external-root': Date.now()}});
    const beforeState = await fs.readFile(path.join(actualRoot, 'archive-state.json'));
    if (linkAt === 'root') {
      await fs.mkdir(profile);
      await fs.symlink(actualRoot, path.join(profile, 'pi-agent'), process.platform === 'win32' ? 'junction' : 'dir');
    } else await fs.symlink(outside, profile, process.platform === 'win32' ? 'junction' : 'dir');
    const app = {getPath: () => profile};
    // Prime the existing index through the linked profile as a late user
    // deletion may run after this transcript has already appeared in history.
    await sessions.historyEntry(app, 'external-root');
    const result = await sessions.permanentlyDeleteHistory(app, 'external-root')
      .catch(() => ({ok: false}));
    assert.equal(await fs.readFile(file, 'utf8').catch(() => null), bytes,
      'the external transcript must survive even if archive-state persistence fails');
    assert.equal(result.ok, false);
    assert.deepEqual(await fs.readFile(path.join(actualRoot, 'archive-state.json')), beforeState);
  });
}

test('permanent deletion refuses a root retargeted during the indexed lookup', async t => {
  const f = await fixture(t), file = await f.write('late-root');
  assert.equal((await sessions.archiveHistory(f.app, 'late-root')).ok, true);
  const realFile = await fs.realpath(file), outside = path.join(f.base, 'outside-agent');
  const directory = path.join(outside, 'sessions', 'project'); await fs.mkdir(directory, {recursive: true});
  const external = path.join(directory, 'late-root.jsonl'), bytes = encode([header('late-root'), message('Outside root')]);
  await fs.writeFile(external, bytes);
  archiveState.write(outside, {conversations: {'late-root': Date.now()}});
  const beforeState = await fs.readFile(path.join(outside, 'archive-state.json'));
  const backup = path.join(f.base, 'original-agent'), realpath = fs.realpath; let retargeted = false;
  t.mock.method(fs, 'realpath', async target => {
    const resolved = await realpath(target);
    if (!retargeted && path.resolve(target) === path.resolve(realFile)) {
      await fs.rename(f.root, backup);
      await fs.symlink(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
      retargeted = true;
    }
    return resolved;
  });
  const result = await sessions.permanentlyDeleteHistory(f.app, 'late-root').catch(() => ({ok: false}));
  assert.equal(retargeted, true, 'the fixture must change the root during lookup');
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(external, 'utf8'), bytes);
  assert.deepEqual(await fs.readFile(path.join(outside, 'archive-state.json')), beforeState);
});

test('permanent deletion preserves external flags when final transcript resolution finds a retargeted root', async t => {
  const f = await fixture(t), file = await f.write('missing-retarget');
  assert.equal((await sessions.archiveHistory(f.app, 'missing-retarget')).ok, true);
  const realFile = await fs.realpath(file), outside = path.join(f.base, 'outside-missing');
  await fs.mkdir(outside);
  archiveState.write(outside, {conversations: {'missing-retarget': Date.now()}});
  const beforeState = await fs.readFile(path.join(outside, 'archive-state.json'));
  const realpath = fs.realpath, remove = archiveState.remove; let checks = 0, writes = 0;
  t.mock.method(archiveState, 'remove', (...args) => { writes++; return remove(...args); });
  t.mock.method(fs, 'realpath', async target => {
    if (path.resolve(target) === path.resolve(realFile) && ++checks === 2) {
      await fs.rename(f.root, path.join(f.base, 'original-missing'));
      await fs.symlink(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return realpath(target);
  });
  const result = await sessions.permanentlyDeleteHistory(f.app, 'missing-retarget').catch(() => ({ok: false}));
  assert.equal(checks, 2, 'the fixture must retarget the root during final transcript resolution');
  assert.equal(writes, 0, 'no archive-state write may be attempted through the external root');
  assert.equal(result.ok, false);
  assert.deepEqual(await fs.readFile(path.join(outside, 'archive-state.json')), beforeState);
});

test('permanent deletion preserves external flags when the root changes during unlink', async t => {
  const f = await fixture(t), file = await f.write('unlink-retarget');
  assert.equal((await sessions.archiveHistory(f.app, 'unlink-retarget')).ok, true);
  const realFile = await fs.realpath(file), outside = path.join(f.base, 'outside-unlink');
  await fs.mkdir(outside);
  archiveState.write(outside, {conversations: {'unlink-retarget': Date.now()}});
  const beforeState = await fs.readFile(path.join(outside, 'archive-state.json'));
  const unlink = fs.unlink, remove = archiveState.remove; let deleted = false, writes = 0;
  t.mock.method(archiveState, 'remove', (...args) => { writes++; return remove(...args); });
  t.mock.method(fs, 'unlink', async target => {
    await unlink(target);
    if (path.resolve(target) === path.resolve(realFile)) {
      await fs.rename(f.root, path.join(f.base, 'original-unlink'));
      await fs.symlink(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
      deleted = true;
    }
  });
  const result = await sessions.permanentlyDeleteHistory(f.app, 'unlink-retarget').catch(() => ({ok: false}));
  assert.equal(deleted, true, 'the fixture must delete the owned transcript before retargeting');
  assert.equal(writes, 0, 'no archive-state write may be attempted through the external root');
  assert.equal(result.ok, false);
  assert.deepEqual(await fs.readFile(path.join(outside, 'archive-state.json')), beforeState);
});

for (const kind of ['file', 'directory']) {
  test('permanent deletion keeps an outside transcript after a cached ' + kind + ' link replacement', async t => {
    const f = await fixture(t), file = await f.write('replacement');
    assert.equal((await sessions.archiveHistory(f.app, 'replacement')).ok, true);
    const outside = path.join(f.base, 'outside'); await fs.mkdir(outside);
    const external = path.join(outside, 'replacement.jsonl'), bytes = encode([header('replacement'), message('Outside archive')]);
    await fs.writeFile(external, bytes); await fs.unlink(file);
    if (kind === 'file') await fs.symlink(external, file, 'file');
    else {await fs.rmdir(f.directory); await fs.symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir');}
    const result = await sessions.permanentlyDeleteHistory(f.app, 'replacement');
    assert.notEqual(result.permanentlyDeleted, true);
    assert.equal(await fs.readFile(external, 'utf8'), bytes);
  });
}

test('permanent deletion rechecks a transcript replaced after the indexed lookup', async t => {
  const f = await fixture(t), file = await f.write('late-replacement');
  assert.equal((await sessions.archiveHistory(f.app, 'late-replacement')).ok, true);
  const realFile = await fs.realpath(file), outside = path.join(f.base, 'outside'); await fs.mkdir(outside);
  const external = path.join(outside, 'late-replacement.jsonl'), bytes = encode([header('late-replacement'), message('Outside archive')]);
  await fs.writeFile(external, bytes);
  const realpath = fs.realpath; let fileChecks = 0, replaced = false;
  t.mock.method(fs, 'realpath', async target => {
    // The primed lookup first revalidates its cached path. Replace the file
    // on the subsequent path check made by the deletion itself.
    if (path.resolve(target) === path.resolve(realFile) && ++fileChecks === 2) {
      await fs.unlink(file); await fs.symlink(external, file, 'file'); replaced = true;
    }
    return realpath(target);
  });
  const result = await sessions.permanentlyDeleteHistory(f.app, 'late-replacement');
  assert.equal(replaced, true, 'the fixture must replace the file after lookup');
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(external, 'utf8'), bytes);
});
test('archived history returns all archived rows instead of a fixed page cap', async t => {
  const f = await fixture(t);
  const ids = Array.from({ length: 205 }, (_, n) => 'archived-' + n);
  await Promise.all(ids.map(id => f.write(id)));
  archiveState.write(f.root, { conversations: Object.fromEntries(ids.map((id, index) => [id, Date.now() + index])) });
  const result = await sessions.archivedHistory(f.app);
  assert.equal(result.ok, true);
  assert.equal(result.chats.length, ids.length);
});
