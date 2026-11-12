'use strict';







const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const lifecycle = () => read('core', 'store-lifecycle.js');

test('store.js：定义服务端专属字段清单与剥离函数', () => {
  const store = lifecycle();
  assert.match(store, /CFG_SERVER_OWNED = \['modelProviders'\]/);
  assert.match(store, /CFG_SERVER_OWNED\.forEach\(key => \{ delete value\[key\]; \}\)/);
});

test('store：启动读入 localStorage 即剥离存量污染', () => {
  const store = read('core', 'store.js');
  assert.match(
    store,
    /*
     * Allow direct parsing or tolerant safeParseCfg, but require stripServerOwned around
     * initial configuration.
     */
    /_cfg:stripServerOwned\(Object\.assign\(\{mode:'quad'[\s\S]{0,200}(?:JSON\.parse\(localStorage\.getItem\(LS_CFG\)\|\|'\{}'\)|safeParseCfg\(localStorage\.getItem\(LS_CFG\)\))\)\)/,
    '_cfg 初始化必须过 stripServerOwned，历史污染启动即洗掉'
  );
});

test('store：hydrate 回灌合并前剥离后台下行值', () => {
  const store = lifecycle();
  const hydrate = store.slice(store.indexOf('_loadConfig(revision)'), store.indexOf('hydrate(force'));
  assert.match(hydrate, /const incoming = stripServerOwned\(\{ \.\.\.apiCfg \}\);/,
    'hydrate must sanitize a copied server configuration');
  assert.match(hydrate, /Object\.assign\(this\._cfg, incoming\);/,
    'hydrate must merge only the sanitized configuration copy');
  // Strip server-owned fields from persisted snapshots to clean legacy contamination.
  assert.match(hydrate, /localStorage\.setItem\(LS_CFG, JSON\.stringify\(stripServerOwned\(this\._cfg\)\)\)/);
});

test('store：saveCfg 上报的是剥离副本，本地真值不被改动', () => {
  const store = lifecycle();
  assert.match(
    store,
    /api\(\)\.syncConfig\(stripServerOwned\(Object\.assign\(\{\}, this\._cfg\)\)\)/,
    '_syncCfgToHub 必须上报剥离副本'
  );
  assert.doesNotMatch(store, /api\.syncConfig\(this\._cfg\)/, '不得再把含服务端字段的真值原样上报');
});

test('store：WS config.patch 下发合并前剥离', () => {
  const store = read('core', 'store.js');
  assert.match(store, /this\._applyConfigPatch\(ev\.patch\)/);
  const patch = lifecycle().slice(lifecycle().indexOf('_applyConfigPatch(patch)'), lifecycle().indexOf('initLocal()'));
  assert.match(patch, /const incoming = stripServerOwned\(\{ \.\.\.patch \}\);/,
    'config.patch must sanitize a copied server patch');
  assert.match(patch, /Object\.assign\(this\._cfg, incoming\);/,
    'config.patch must merge only the sanitized server patch');
});

test('store：pending 标记读取异常时保守视为「有待同步」', () => {
  const store = lifecycle();
  assert.match(
    store,
    /function cfgSyncPending\(\)\s*\{\s*try\s*\{ return global\.localStorage\.getItem\(LS_CFG_PENDING\) === '1'; \} catch \(_\) \{ return true; \}/,
    '读异常返回 true（宁可多补推，不给后台旧值回灌开门）'
  );
});

test('win-bridge：窗口广播合并前剥离（自包含清单，不依赖加载顺序）', () => {
  const bridge = read('core', 'win-bridge.js');
  const pull = bridge.slice(bridge.indexOf('function pullCfg()'), bridge.indexOf('function pullCfg()') + 700);
  assert.match(pull, /\['modelProviders'\]\.forEach\(k\s*=>\s*\{\s*delete incoming\[k\];\s*\}\)/);
});
