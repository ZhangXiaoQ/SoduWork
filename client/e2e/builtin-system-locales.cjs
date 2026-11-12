'use strict';
// Exercise mounted production cards and dialogs without services or user profiles.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
require('./lib/isolated-profile.cjs').isolateProfile(app, 'builtin-locales');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'outputs/nov02-builtin-locales');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let win;
const js = code => win.webContents.executeJavaScript(code);
const tick = () => js('new Promise(resolve => setTimeout(resolve, 100))');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const plugins = require('../main/personal-plugins').catalog(app);
  win = new BrowserWindow({ show: false, width: 1200, height: 950,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error(message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  await win.loadFile(path.join(__dirname, 'fixtures/capability-toolbar.html'));
  await js(`for(const href of ['../../components/panels/plugin-presentation.css','../../components/panels/capability-type-scale.css']){
    const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.appendChild(link);}`);
  for (const name of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + name) + '\n;void 0;');
  for (const name of ['core/i18n-dom.js', 'core/i18n.js', 'core/builtin-skill-presentation.js', 'core/plugin-locales.js',
    'core/plugin-icon.js', 'components/panels/plugin-ui-host.js', 'components/panels/plugin-catalog-format.js',
    'components/panels/plugin-dependency-ux.js', 'components/panels/plugin-lifecycle.js',
    'components/panels/panels-capability-directory.js',
    'components/panels/compose-candidate-navigation.js', 'components/panels/panels-compose-skills.js',
    'components/panels/panels-plugin-maker-skills.js',
    'components/panels/panels-capability-plugins.js', 'components/panels/task-trace-view.js']) {
    await js(read(name) + '\n;void 0;');
  }
  await js(`window.shipped=${JSON.stringify(plugins)};
    SoduWorkAPI.pluginCatalog=async()=>({items:shipped.map(item=>SoduWorkPluginLocales.present(item,SoduWorkI18n.getLocale())),submissions:[],categories:[]});
    catalog.skills=[{name:'office',description:'Original bundled description',builtIn:true,sourceKey:'builtin',enabled:true,available:true,portable:true},
      {name:'Custom skill 保存',description:'My own description 保存',sourceKey:'personal',enabled:true,available:true,portable:true}];
    SoduWorkAPI.skillDetails=async name=>({name,builtIn:true,description:'Original bundled description',files:[],fileCount:0,unpackedBytes:0,checksum:'fixture-sha'});
    openCapabilityPanel();void 0;`);
  await tick();
  await js(`document.querySelector('[data-cap-tab=skills]').click()`); await tick();
  await js(`(async()=>{const fixture=document.createElement('section');fixture.id='skillTooltipFixture';
    fixture.innerHTML='<div id="composeFixture"><textarea></textarea></div><div id="makerFixture"></div>';
    document.body.appendChild(fixture);
    const chooser=ComposeSkills.create({host:fixture.querySelector('#composeFixture'),input:fixture.querySelector('textarea'),loading:false});
    const selectable=catalog.skills.map(item=>item.builtIn?item:{...item,name:'custom-skill'});
    chooser.setItems(selectable);chooser.restore(selectable.map(item=>item.name));
    await SoduWorkPluginMakerSkills.create({root:fixture.querySelector('#makerFixture'),selected:new Set(),
      deps:{loadSkills:async()=>({skills:catalog.skills})}}).load();})()`);
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN', 'en-US']) {
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)})`); await tick();
    const content = await js('document.querySelector("#capContent").innerText');
    assert.ok(content.includes(await js('SoduWorkI18n.t("builtin.skill.office.name")')), locale + ' skill name: ' + content);
    assert.ok(content.includes(await js('SoduWorkI18n.t("builtin.skill.office.description")')), locale + ' skill description');
    assert.ok(content.includes('Custom skill 保存') && content.includes('My own description 保存'), 'custom metadata is preserved');
    for (const selector of ['.cp-skill-tag', '#makerFixture label']) {
      const titles = await js(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}),node=>node.title)`);
      assert.deepEqual(titles, [await js('SoduWorkI18n.t("builtin.skill.office.description")'), 'My own description 保存']);
    }
  }
  await js(`document.querySelector('#skillTooltipFixture').remove()`);
  await js(`document.querySelector('[data-cap-tab=plugins]').click()`); await tick();
  const builder = plugins.find(item => item.pluginId === 'local:plugin-builder');
  assert.ok(builder);
  await js(`document.querySelector('[data-plugin="local:plugin-builder"]').click()`); await tick();
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN', 'en-US']) {
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)})`); await tick();
    const expected = require('../core/plugin-locales').present(builder, locale);
    assert.equal(await js('document.querySelector("#capModalTitle").textContent'), expected.name, locale + ' mounted plugin dialog');
    assert.ok((await js('document.querySelector(".cap-plugin-detail-head").innerText')).includes(expected.description));
    if (locale === 'en-US') assert.doesNotMatch(await js('document.querySelector(".cap-modal").innerText'), /[\u4e00-\u9fff]/);
    assert.ok((await js(`document.querySelector('[data-plugin="local:plugin-builder"]').innerText`)).includes(expected.name));
    fs.writeFileSync(path.join(output, locale + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  for (const item of plugins) {
    await js(`document.querySelector('#capModalClose').click();document.querySelector('[data-plugin=${JSON.stringify(item.pluginId)}]').click()`);
    await tick();
    const visible = await js('document.querySelector(".cap-modal").innerText');
    fs.writeFileSync(path.join(output, item.key + '-en.txt'), visible);
    assert.doesNotMatch(visible, /[\u4e00-\u9fff]/, item.pluginId + ': ' + visible.split('\n').filter(line => /[\u4e00-\u9fff]/.test(line)).join('\n'));
  }
  await js(`document.querySelector('#capModalClose').click();`);
  for (const file of ['components/panels/chat-plugin-mention-model.js', 'components/panels/chat-plugin-mention.js', 'components/panels/work-composer.js']) {
    await js(read(file) + '\nvoid 0;');
  }
  await js(`window.composerFixture=document.createElement('section');
    composerFixture.innerHTML='<textarea></textarea><div id="morePluginRows"></div>';document.body.appendChild(composerFixture);
    window.composerItems=shipped.concat([{pluginId:'custom-name',name:'插件开发助手',description:'Custom description 保存',personal:true,enabled:true}]);
    window.picker=ChatPluginMention.create({host:composerFixture,input:composerFixture.querySelector('textarea'),catalog:async()=>({items:composerItems})});
    picker.open();`); await tick();
  await js(`picker.restore([composerItems.find(item=>item.pluginId==='local:plugin-builder'),composerItems.at(-1)]);`);
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN', 'en-US']) {
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});picker.open();
      document.querySelector('#morePluginRows').innerHTML=WorkComposer.pluginRows(ChatPluginMentionModel.normalizeCatalog({items:composerItems}),[]);`);
    await tick();
    const expected = require('../core/plugin-locales').present(builder, locale);
    assert.deepEqual(await js(`Array.from(composerFixture.querySelectorAll('.nplugin-chip>span'),node=>node.textContent)`), [expected.name, '插件开发助手']);
    for (const item of plugins) {
      const translated = require('../core/plugin-locales').present(item, locale);
      const content = await js(`document.querySelector('[data-more-plugin=${JSON.stringify(item.pluginId)}]')?.textContent`);
      if (!require('../components/panels/chat-plugin-mention-model').isWorkspaceApp(item)) {
        assert.ok(content?.includes(translated.name), locale + ' composer name: ' + item.pluginId);
        assert.ok(content?.includes(translated.description), locale + ' composer description: ' + item.pluginId);
      }
    }
  }
  await js('picker.destroy();composerFixture.remove();');
  assert.deepEqual(await js('errors'), []);
  console.log('PASS: five locale transitions on mounted built-in skill cards and plugin cards/dialogs; custom metadata and identifiers preserved');
  win.destroy(); app.exit(0);
}).catch(async error => { console.error(error); if (win) console.error(await js('JSON.stringify(errors)').catch(() => 'Renderer unavailable')); win?.destroy(); app.exit(1); });
