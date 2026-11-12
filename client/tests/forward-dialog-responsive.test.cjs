'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const detail = fs.readFileSync(path.join(root, 'components', 'requirements', 'requirement-assignment.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'components', 'panels', 'panels-forward-plugin.css'), 'utf8');

test('dispatch dialog keeps its footer reachable on short screens', () => {
  assert.match(detail, /class="fwd-scroll"/);
  const requirementCss = fs.readFileSync(path.join(root, 'components/requirements/requirements-board.css'), 'utf8');
  assert.match(requirementCss, /\.rq-assignment-backdrop \.fwd-pop\{[^}]*display:flex/);
  assert.match(css, /\.fwd-pop\{[^}]*max-height:min\(740px,calc\(100dvh - 32px\)\)[^}]*flex-direction:column[^}]*overflow:hidden/);
  assert.match(css, /\.fwd-scroll\{[^}]*min-height:0[^}]*flex:1 1 auto[^}]*overflow:hidden/);
  assert.match(detail, /class="frw-main"/);
  assert.match(detail, /class="fwd-settings"/);
  assert.ok(detail.indexOf('id="fwdNote"') < detail.indexOf('class="fwd-settings"'));
  assert.ok(detail.indexOf('id="fwdList"') > detail.indexOf('class="fwd-settings"'));
  assert.doesNotMatch(detail, /核对安排|fwd-decision-copy/);
  assert.match(css, /\.fwd-actions\{[^}]*flex:0 0 auto/);
  assert.match(css, /@media\(max-width:680px\)\{\.fwd-pop\{[^}]*max-height:calc\(100dvh - 16px\)/);
});

test('retrying dispatch always refreshes options and presents a structured coworker picker', () => {
  const options = fs.readFileSync(path.join(root, 'components', 'panels', 'panels-forward-picker.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(root, 'components', 'panels', 'panels-forward-options.js'), 'utf8');

  assert.match(detail, /_fwdSwitch\(task\.id, tab \|\| 'ai', \{fresh: true\}\)/);
  assert.match(options, /function _fwdNormalizeMates\(raw\)/);
  assert.match(options, /function _fwdRenderMatePanel\(box, tid\)/);
  assert.match(options, /data-fwd-mate-filter/);
  assert.match(options, /_fwdLoadSeq/);
  assert.match(css, /\.fwd-mate-toolbar/);
  assert.match(css, /\.fwd-mate-group/);

  const context = { window: {addEventListener() {}} };
  vm.runInNewContext(options, context);
  const rows = context._fwdNormalizeMates([
    { id: ' u-2 ', name: 'Bob', org: 'Engineering', hasBox: false, deviceCount: 1 },
    { id: 'u-1', name: 'Alice', org: 'Engineering', hasBox: true, devices: [{}, {}] },
    { id: 'u-2', name: 'Bob', org: 'Engineering', hasBox: false, deviceCount: 2 },
    { id: 'u-3', name: 'Carol', org: 'Sales', hasBox: true, canReceive: false },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map(row => [
    row.id, row.name, row.org, row.hasBox, row.deviceCount,
  ]))), [
    ['u-1', 'Alice', 'Engineering', true, 2],
    ['u-2', 'Bob', 'Engineering', false, 2],
    ['u-3', 'Carol', 'Sales', false, 0],
  ]);
});


test('assignment includes the concrete catalog default and shows the selected Agent preference', () => {
  const context = {window:{},esc:value=>String(value).replaceAll('<','&lt;')};
  vm.runInNewContext(fs.readFileSync(path.join(root,'components/panels/panels-forward-plugin.js'),'utf8'),context);
  const options = {defaultModel:'catalog-default',models:['review'],modelOptions:[{name:'catalog-default'},{name:'review'}],
    defaultModels:{pi:'review'},defaultModelErrors:{qwen:'Unavailable'}};
  const state=context._fwpModelState(options,'catalog-default');
  assert.deepEqual(Array.from(state.models),['catalog-default','review']);assert.equal(state.stale,false);
  assert.match(context._fwpModelOptions(state,'Default'),/value="catalog-default" selected/);
  assert.equal(context._fwpDefaultModelLabel(options,{cli:'pi'}),'跟随底座默认 · review');
  assert.match(context._fwpDefaultModelLabel(options,{cli:'qwen'}),/不可用/);
  assert.match(context._fwpDefaultModelLabel(options,{cli:'pi',remote:true}),/派发时解析/);
  assert.match(context._fwpDefaultModelLabel({defaultModel:'old-hub-default'},{cli:'pi'}),/目录默认：old-hub-default/);
  assert.equal(context._fwpModelState({defaultModel:'only',models:[]},'').models.length,1);
  assert.equal(context._fwpModelState(options,'removed').stale,true);
});


test('assignment labels identify an unambiguous provider without changing model values', () => {
  const context = {window:{},esc:value=>String(value).replaceAll('<','&lt;')};
  vm.runInNewContext(fs.readFileSync(path.join(root,'components/panels/panels-forward-plugin.js'),'utf8'),context);
  const row = {name:'model-a',providerId:'provider-a',providerName:'Example <provider>'};
  const options = {defaultModels:{pi:'model-a'},defaultModel:'model-a',modelOptions:[row]};
  assert.equal(context._fwpDefaultModelLabel(options,{cli:'pi'}),'跟随底座默认 · model-a · Example <provider>');
  const state=context._fwpModelState(options,'model-a');
  assert.equal(state.value,'model-a');assert.equal(state.stale,false);
  assert.match(context._fwpModelOptions(state,'Default'),/value="model-a" selected>model-a · Example &lt;provider>/);
  assert.equal(context._fwpModelLabel({...options,modelOptions:[row,{...row}]},'model-a'),'model-a · Example <provider>');
  assert.equal(context._fwpModelLabel({...options,modelOptions:[row,{...row,providerId:'provider-b'}]},'model-a'),'model-a');
  assert.equal(context._fwpModelLabel({...options,modelOptions:[row,{...row,providerName:''}]},'model-a'),'model-a');
});
