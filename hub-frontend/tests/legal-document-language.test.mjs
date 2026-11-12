import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalLanguage, detectDocumentLanguage } from '../src/screens/legal-document-language.js'

const english = 'These terms explain the conditions for using this service. You retain your rights to your personal information. We collect only the information necessary to provide the service and protect your account.'
test('document text wins over stale Word locale and regional hints only refine matching languages', () => {
  assert.equal(detectDocumentLanguage(english, ['zh-CN', 'en-GB']), 'en-GB')
  assert.equal(detectDocumentLanguage(english, ['zh-CN']), 'en')
  assert.equal(detectDocumentLanguage('本协议说明服务使用规则和个人信息处理方式。我们仅收集提供服务所需的信息，用户可以查看、修改或删除自己的账户资料。', ['en-US', 'zh-CN']), 'zh-CN')
  assert.equal(detectDocumentLanguage('サービスの提供に必要な範囲で処理されます。ユーザーは自分のアカウント情報を確認し、変更または削除できます。', ['ja-JP']), 'ja-JP')
  assert.equal(detectDocumentLanguage('사용자는 자신의 계정 정보를 확인하고 수정하거나 삭제할 수 있습니다.', ['ko-KR']), 'ko-KR')
})
test('short, ambiguous and mixed-language documents require a human language choice', () => {
  assert.equal(detectDocumentLanguage('Short text.', ['en-US']), '')
  assert.equal(detectDocumentLanguage('12345678', ['zh-CN']), '')
  assert.equal(detectDocumentLanguage(english + '本协议说明服务使用规则和个人信息处理方式。用户可以查看、修改或删除自己的账户资料。'), '')
})
test('corrected language tags match the existing publication contract', () => {
  assert.equal(canonicalLanguage('en_gb'), 'en-GB')
  assert.equal(canonicalLanguage('fra'), 'fr')
  assert.equal(canonicalLanguage('zh-Hant-TW'), 'zh-Hant-TW')
  for (const value of ['', 'not a language', 'en-US-x-private', '<script>']) assert.equal(canonicalLanguage(value), '')
})
