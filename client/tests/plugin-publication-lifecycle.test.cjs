const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const publication = read('components/panels/plugin-publication-ux.js');
const catalog = read('components/panels/panels-capability-plugins.js');

async function submitCopy({ application = false, template = 'app', proof = 'trusted', fail = false } = {}) {
  const handlers = {}, notices = [], button = { disabled: false, textContent: '' };
  const draft = { template, name: 'Fixture', version: '1.0.0' };
  const control = { addEventListener() {} };
  const layer = { hidden: false, querySelectorAll: () => [], querySelector(selector) {
    if (selector === '#capPublishDo') return button;
    if (selector === 'input[name="capAudience"]:checked') return { value: 'organization' };
    if (['#capPublishAppCategory', '#capAudienceSearch', '#capAudienceUnitSearch'].includes(selector)) return null;
    return control;
  } };
  // The production stale-dialog check requires the same live button identity.
  button.addEventListener = (_type, fn) => { handlers.submit = fn; };
  const api = { personalPlugin: async () => ({ plugin: { localDraft: draft } }),
    pluginAudienceCandidates: async () => ({}), personalPluginPublisherIdentity: async () => ({ identity: {} }),
    signPersonalPluginDraft: async () => ({}), publishPersonalPlugin: async () => {
      if (fail) throw Error();
      return { message: '插件已上传企业隔离区，管理员审核发布后按所选范围可用', preview: { signature: { state: proof } } };
    } };
  const window = {};
  require('node:vm').runInNewContext(publication, { window });
  await window.SoduWorkPluginPublication.openPersonalPublish({ pluginId: 'fixture' }, {
    openModal: () => layer, closeModal() {}, say: text => notices.push(text), refresh() {},
    errorText: (_error, fallback) => fallback,
  }, { api, application, load: async () => {} });
  await handlers.submit.call(button);
  return notices.at(-1);
}

test('application review copy replaces generic server plugin text including identity and failure paths', async () => {
  assert.match(await submitCopy(), /^应用已提交审核/);
  assert.match(await submitCopy({ template: 'skill', application: true }), /^应用已提交审核/);
  assert.match(await submitCopy({ proof: 'unknown-key' }), /^应用已签名并提交审核/);
  assert.equal(await submitCopy({ fail: true }), '应用没有提交成功');
  assert.match(await submitCopy({ template: 'skill' }), /^插件已上传企业隔离区/);
  assert.match(await submitCopy({ template: 'skill', proof: 'unknown-key' }), /^插件已签名并进入隔离区/);
});

test('personal receipts require the current key and version and select the newest server record', () => {
  const window = {};
  require('node:vm').runInNewContext(publication, { window });
  const find = window.SoduWorkPluginPublication.personalSubmission;
  const item = { personal: true, key: 'example', version: '2.0.0' };
  const current = { key: 'example', version: '2.0.0', createdAt: 20, trustState: 'quarantined' };
  const rows = [{ key: 'other', version: '2.0.0', createdAt: 99 },
    { key: 'example', version: '1.0.0', createdAt: 98 },
    { ...current, createdAt: 10 }, current];
  assert.equal(find(item, rows), current);
  assert.equal(find({ ...item, personal: false }, rows), null);
  assert.equal(find({ ...item, key: '' }, rows), null);
  assert.equal(find({ ...item, version: '3.0.0' }, rows), null);
});

function ordered(source, first, second) {
  assert.ok(source.indexOf(first) >= 0, `missing ${first}`);
  assert.ok(source.indexOf(second) > source.indexOf(first), `${first} must load before ${second}`);
}

test('publication lifecycle owns submission, review recovery and enterprise upload', () => {
  assert.match(publication, /function submissionStrip\(rows, trustName\)/);
  assert.match(publication, /function openSubmission\(item, ctx, options\)/);
  assert.match(publication, /function openPersonalPublish\(item, ctx, options\)/);
  assert.match(publication, /发布身份待登记/);
  assert.match(publication, /打开个人插件继续改进/);
  assert.match(publication, /提交审核/);
  assert.doesNotMatch(catalog, /const \[detailResult, peopleResult, publisherResult\]/);
});

test('enterprise upload keeps the detail visible while prerequisites load', () => {
  assert.match(catalog, /this\.textContent = '正在准备…'/);
  assert.doesNotMatch(catalog, /ctx\.closeModal\(\); await openPersonalPublish/);
  assert.match(catalog, /this\.disabled = false; this\.textContent = label/);
});

test('publication module remains ahead of the catalog shell in both renderers', () => {
  for (const page of ['index.html', 'desk.html']) {
    const html = read(page);
    ordered(html, 'plugin-publication-ux.js', '<script src="components/panels/panels-capability-plugins.js"');
  }
});
