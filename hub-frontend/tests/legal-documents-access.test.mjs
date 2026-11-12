import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as marked from 'marked'
import DOMPurify from 'dompurify'
import { createComponentHarness } from './helpers/react-harness.mjs'

for (const user of [null, { isSuper: false, permissions: ['identity.manage'] }]) {
  test(`legal editor refuses ${user ? 'ordinary administrators' : 'missing accounts'} before loading drafts`, async t => {
    const calls = []
    const page = await createComponentHarness(new URL('../src/screens/LegalDocuments.jsx', import.meta.url), { dependencies: {
      marked,
      dompurify: { default: DOMPurify, __esModule: true },
      '../api.js': { getUser: () => user, api: { legalDocument: async kind => { calls.push(kind); return {} } } },
      '../ui.jsx': { toast() {} },
      './LegalDocumentImport.jsx': { default: 'LegalDocumentImport', __esModule: true },
      './legal-documents.css': {},
      turndown: {}, 'turndown-plugin-gfm': {},
      '../../../client/components/client-auth/legal-html.js': {},
      '../../../client/components/client-auth/legal-html.css': {},
    } })
    t.after(() => page.unmount())
    page.render(); await page.flush()
    assert.deepEqual(calls, [])
    assert.equal(page.nodes(node => node.props.role === 'status')[0].props.children, '协议维护需要超级管理员权限')
    assert.equal(page.nodes(node => ['input', 'textarea', 'select', 'button'].includes(node.type)).length, 0)
  })
}
