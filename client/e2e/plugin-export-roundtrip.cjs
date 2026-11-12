'use strict';

// Runs the native exporter and picker through the Hub's actual import parser.
// No service, account, model, or real plugin library is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const personal = require('../main/personal-plugins');
const picker = require('../main/plugin-package-picker');
const backend = path.resolve(__dirname, '../../hub-backend');
const python = process.env.SODUWORK_TEST_PYTHON || path.join(backend, '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const parseArchive = `
import sys, io, zipfile, json
from app.services import plugin_packages
raw = sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    assert archive.testzip() is None
parsed = plugin_packages.parse(raw)
result = plugin_packages.public_summary(parsed)
sys.stdout.write(json.dumps(result['personalDraft'], ensure_ascii=True))
`;

for (const template of ['method', 'workflow']) for (const suffix of ['json', 'soduwork-plugin', 'soduwork-plugin', 'soduwork-plugin', 'zip']) {
  test(template + ' ' + suffix + ' archive imports with complete Chinese and binary resources', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-export-roundtrip-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = { getPath: () => path.join(root, 'source') };
    const target = { getPath: () => path.join(root, 'target') };
    const body = {
      template, key: 'portable-check', name: '插件归档校验', version: '1.0.0',
      description: '验证完整资源可跨用户导入', instructions: '读取随附模板并保留资源。',
      skills: ['browser-use'],
      resources: [
        { path: 'templates/报告.md', kind: 'template', encoding: 'utf8', content: '# 报告\n正文\n' },
        { path: 'scripts/render.mjs', kind: 'script', encoding: 'utf8', content: 'console.log("fixture")\n' },
        { path: 'assets/sample.bin', kind: 'asset', encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64') },
      ],
    };
    const installed = personal.create(source, body).plugin;
    const exported = await personal.exportToFile(source, {
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, 'export.' + suffix) }),
    }, installed.pluginId);
    const selected = await picker.choose({
      showOpenDialog: async () => ({ canceled: false, filePaths: [exported.filePath] }),
    });
    assert.equal(selected.kind, 'archive');
    assert.equal(selected.name, 'export.' + (suffix === 'json' ? 'soduwork-plugin' : suffix));
    const checked = spawnSync(python, ['-c', parseArchive], {
      cwd: backend, input: Buffer.from(selected.content, 'base64'), maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true,
    });
    assert.ifError(checked.error);
    assert.equal(checked.status, 0, checked.stderr.toString('utf8'));
    const draft = JSON.parse(checked.stdout.toString('utf8'));
    const imported = personal.create(target, draft).plugin;
    const restored = personal.exportDraft(target, imported.pluginId);
    const original = personal.exportDraft(source, installed.pluginId);
    assert.equal(restored.template, template);
    assert.equal(restored.instructions, body.instructions);
    assert.deepEqual(restored.skills, original.skills);
    assert.equal(restored.resources.length, original.resources.length);
    for (const item of original.resources) {
      const got = restored.resources.find(row => row.path === item.path);
      assert.ok(got, item.path);
      assert.equal(got.sha256, item.sha256, item.path);
      assert.equal(got.content, item.content, item.path);
    }
    if (template === 'workflow') {
      assert.deepEqual(restored.workflow.nodes.map(row => row.key), original.workflow.nodes.map(row => row.key));
    }
  });
}
