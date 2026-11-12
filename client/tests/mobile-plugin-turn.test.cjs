'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const pluginStore = require('../main/personal-plugins');
const {prepare} = require('../main/mobile-plugin-turn.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-turn-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const app = {getPath: () => root, isPackaged:false};
  const plugin = pluginStore.catalog(app, true).find(row => row.pluginId === 'local:plugin-builder');
  let checks = 0;
  return { app, pluginStore, args: {ref:'existing',plugins:[{pluginId:plugin.pluginId,checksum:plugin.checksum}]},
    context:{ref:'existing',cwd:root,text:'按原对话制作插件',capabilityIds:[],readOnly:false},
    shared:{use: async id => pluginStore.get(app,id)}, guard:async()=>{checks++;}, checks:()=>checks };
}
test('existing turn resolves the real desktop builder and its resources without opening a session', async t => {
  const f=fixture(t), result=await prepare(f);
  assert.equal(result.plugins[0].pluginId,'local:plugin-builder');
  assert.match(result.promptText,/按原对话制作插件/);
  assert.ok(result.resourceBundles.some(row=>row.resources.length));
  assert.ok(f.checks()>=2);
});
test('changed plugin version and changed conversation fail before using instructions', async t => {
  const f=fixture(t);
  await assert.rejects(prepare({...f,context:{...f.context,ref:'other'}}),/不匹配/);
  f.args.plugins[0].checksum='0'.repeat(64);
  await assert.rejects(prepare(f),/版本已变化/);
});
test('desktop source authorization failure is preserved', async t => {
  const f=fixture(t); f.shared.use=async()=>{throw Error('source denied');};
  await assert.rejects(prepare(f),/source denied/);
});
