"""Real isolated HTTP/SQLite regression for publishing and exact-revision receipts."""
import asyncio
import io
import json
from datetime import timedelta
import unittest
import zipfile
from unittest.mock import patch

import test_email_auth as fixture
from fastapi import Depends
from sqlalchemy import delete, func, select
from app.api import account_profile, legal_documents
from app.db import Base, SessionLocal, engine
from app.deps import current_ai_client
from app.legal_models import LegalDraft, LegalReceipt, LegalVersion
from app.models import AppSetting, AuditLog, User
from app.services import legal_publications as legal

for router in (account_profile.router, account_profile.admin_router, legal_documents.router, legal_documents.admin_router):
    fixture.app.include_router(router)


@fixture.app.post('/_test/legal-ai')
async def ai_route(client=Depends(current_ai_client)):
    return {"ok": True}


class LegalPublicationsTests(unittest.IsolatedAsyncioTestCase):
    post = fixture.EmailAuthTests.post
    proof = fixture.EmailAuthTests.proof

    async def asyncSetUp(self):
        await fixture.EmailAuthTests.asyncSetUp(self)
        tables = [LegalDraft.__table__, LegalVersion.__table__, LegalReceipt.__table__]
        async with engine.begin() as connection:
            await connection.run_sync(lambda c: Base.metadata.create_all(c, tables=tables))
            for table in reversed(tables):
                await connection.execute(delete(table))
        result, _ = await fixture.EmailAuthTests.register(self)
        self.uid = result['user']['id']
        self.headers = {"Authorization": "Device " + result['session']}
        async with SessionLocal() as session:
            admin = User(id='legal-admin', username='legal-admin', display_name='Publisher', password_hash='unused',
                         is_super=True, is_active=True, org_id='root')
            session.add(admin)
            await session.commit()
            self.admin = {"Authorization": "Bearer " + fixture.sign_token(admin.id, admin.auth_version)}
            user = await session.get(User, self.uid)
            self.user_bearer = {"Authorization": "Bearer " + fixture.sign_token(user.id, user.auth_version)}

    async def asyncTearDown(self):
        await fixture.EmailAuthTests.asyncTearDown(self)

    async def call(self, method, path, body=None, headers=None):
        return await self.http.request(method, path, headers=headers or self.admin,
            **({"json": body} if body is not None else {}))

    async def state(self, kind='terms'):
        result = await self.call('GET', '/api/v1/admin/legal-documents/' + kind)
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def payload(self, version='v1', action='notice'):
        return {'version': version, 'action': action, 'defaultLocale': 'en-US', 'format': 'markdown',
                'translations': {'en-US': {'title': 'Terms <script>', 'content': '## Rules\n**Exact** legal text.', 'summary': 'Changed scope.'},
                                 'ja-JP': {'title': '利用規約', 'content': '一、利用条件\n原文', 'summary': '更新内容'}}}

    async def publish(self, kind='terms', version='v1', action='notice', effective=None):
        state = await self.state(kind)
        saved = await self.call('PUT', f'/api/v1/admin/legal-documents/{kind}/draft',
            {'revision': state['revision'], 'draft': self.payload(version, action)})
        self.assertEqual(saved.status_code, 200, saved.text)
        result = await self.call('POST', f'/api/v1/admin/legal-documents/{kind}/publish',
            {'revision': saved.json()['revision'], 'effectiveAt': effective.isoformat() if effective else None})
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()['publication']

    async def status(self):
        response = await self.call('GET', '/api/v1/client-auth/me/legal-status', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def respond(self, row, action='accept', locale='ja-JP'):
        return await self.call('POST', '/api/v1/client-auth/me/legal-response',
            {'kind': row['key'], 'revisionId': row['id'], 'action': action, 'locale': locale}, self.headers)

    async def test_html_snapshot_preserves_layout_and_rejects_empty_rendered_text(self):
        payload = self.payload()
        content = '<p style="margin-bottom:8pt;line-height:1.5;text-indent:22pt">1.1 <strong>Exact legal text</strong></p>'
        payload['translations']['en-US'].update(format='html', content=content)
        saved = await self.call('PUT', '/api/v1/admin/legal-documents/terms/draft', {'revision': 0, 'draft': payload})
        self.assertEqual(saved.status_code, 200, saved.text)
        published = await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': saved.json()['revision']})
        self.assertEqual(published.status_code, 200, published.text)
        public = await self.call('GET', '/api/v1/client-auth/legal-documents')
        row = next(row for row in public.json()['documents'] if row['key'] == 'terms' and row['locale'] == 'en-US')
        self.assertEqual(row['format'], 'html')
        self.assertEqual(row['content'], content)
        self.assertEqual(row['digest'], legal.digest(payload['translations']['en-US']))
        for empty in ('<p>&nbsp;<br></p>', '<script>invisible()</script>', '<style>p{color:red}</style>'):
            payload['translations']['en-US']['content'] = empty
            state = await self.state()
            saved = await self.call('PUT', '/api/v1/admin/legal-documents/terms/draft', {'revision': state['revision'], 'draft': payload})
            self.assertEqual(saved.status_code, 200)
            result = await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': saved.json()['revision']})
            self.assertEqual(result.status_code, 422, result.text)
        self.assertEqual(len((await self.state())['history']), 1)

    async def test_draft_is_private_and_cas_prevents_lost_updates(self):
        before = (await self.status())['documents']
        body = {'revision': 0, 'draft': self.payload()}
        path = '/api/v1/admin/legal-documents/terms/draft'
        results = await asyncio.gather(self.call('PUT', path, body), self.call('PUT', path, body))
        self.assertEqual(sorted(item.status_code for item in results), [200, 409])
        self.assertEqual((await self.status())['documents'], before)
        state = await self.state()
        self.assertEqual(state['revision'], 1)
        self.assertEqual(state['history'], [])
        async with SessionLocal() as session:
            self.assertIsNone(await session.get(AppSetting, legal.MARKER))

    async def test_only_superadmin_can_maintain_or_publish(self):
        async with SessionLocal() as session:
            session.add(fixture.models.Role(id='legal-org-manager', name='Organization administrator', permissions=['identity.manage']))
            user = await session.get(User, self.uid)
            user.role_id = 'legal-org-manager'
            await session.commit()
        for method, path, body in [('GET', '/terms', None), ('PUT', '/terms/draft', {'revision': 0, 'draft': self.payload()}),
                                   ('POST', '/terms/publish', {'revision': 1})]:
            response = await self.call(method, '/api/v1/admin/legal-documents' + path, body, self.user_bearer)
            self.assertEqual(response.status_code, 403, response.text)
        response = await self.http.get('/api/v1/admin/legal-documents/terms')
        self.assertEqual(response.status_code, 401)
        legacy = await self.call('GET', '/api/v1/admin/account-legal', headers=self.user_bearer)
        self.assertFalse(legacy.json()['canEdit'])
        denied = await self.call('PUT', '/api/v1/admin/account-legal',
            {'operatorName': 'Unauthorized change', 'contactEmail': 'privacy@example.test'}, self.user_bearer)
        self.assertEqual(denied.status_code, 403)

    async def test_published_snapshot_is_immutable_and_multilingual(self):
        before = (await self.status())['documents']
        privacy_fallback = [row for row in before if row['key'] == 'privacy']
        self.assertEqual([row['locale'] for row in privacy_fallback], ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'])
        first = await self.publish()
        docs = (await self.status())['documents']
        published_terms = [row for row in docs if row['key'] == 'terms']
        self.assertEqual([row['locale'] for row in published_terms], ['en-US', 'ja-JP'])
        self.assertEqual(len(docs), 6)
        self.assertEqual([row for row in docs if row['key'] == 'privacy'], privacy_fallback)
        for locale, translation in self.payload()['translations'].items():
            row = next(row for row in docs if row['key'] == 'terms' and row['locale'] == locale)
            self.assertEqual(row['content'], translation['content'])
            self.assertEqual(row['digest'], legal.digest({**translation, 'format': self.payload()['format']}))
        await self.publish(version='v2')
        current = (await self.status())['documents']
        self.assertEqual([row for row in current if row['key'] == 'privacy'], privacy_fallback)
        old = await self.call('GET', '/api/v1/client-auth/legal-documents/versions/' + first['id'])
        self.assertEqual(old.status_code, 200)
        self.assertTrue(all(row['version'] == 'v1' for row in old.json()['documents']))
        self.assertEqual(old.json()['documents'], published_terms)
        self.assertEqual((await self.state())['history'][1]['digest'], first['digest'])
        state = await self.state()
        saved = await self.call('PUT', '/api/v1/admin/legal-documents/terms/draft', {'revision': state['revision'], 'draft': self.payload('v1')})
        published = await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': saved.json()['revision']})
        self.assertEqual(published.status_code, 200, published.text)
        self.assertEqual(published.json()['publication']['version'], 'v3')
        duplicate = await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': saved.json()['revision']})
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual((await self.state())['history'][2]['digest'], first['digest'])

    async def test_scheduled_version_hidden_until_effective_and_cancelable(self):
        first = await self.publish()
        future = legal.now() + timedelta(days=2)
        scheduled = await self.publish(version='v2', effective=future)
        self.assertEqual((await self.status())['requiredConsentVersions']['terms'], 'v1')
        private = await self.call('GET', '/api/v1/client-auth/legal-documents/versions/' + scheduled['id'])
        self.assertEqual(private.status_code, 404)
        with patch.object(legal, 'now', return_value=future + timedelta(seconds=1)):
            self.assertEqual((await self.status())['requiredConsentVersions']['terms'], 'v2')
        canceled = await self.call('POST', '/api/v1/admin/legal-documents/versions/' + scheduled['id'] + '/cancel')
        self.assertEqual(canceled.status_code, 200)
        with patch.object(legal, 'now', return_value=future + timedelta(seconds=1)):
            self.assertEqual((await self.status())['requiredConsentVersions']['terms'], 'v1')
        self.assertEqual((await self.call('POST', '/api/v1/admin/legal-documents/versions/' + first['id'] + '/cancel')).status_code, 409)
        next_version = await self.publish(version='v2')
        self.assertEqual(next_version['version'], 'v3')

    async def test_acceptance_is_explicit_idempotent_and_blocks_only_new_ai_work(self):
        row = await self.publish(action='accept')
        self.assertTrue((await self.status())['acceptanceRequired'])
        self.assertEqual((await self.respond(row, 'notice')).status_code, 428)
        self.assertEqual((await self.call('POST', '/_test/legal-ai', headers=self.headers)).status_code, 428)
        self.assertEqual((await self.call('GET', '/api/v1/client-auth/me', headers=self.headers)).status_code, 200)
        for _ in range(2):
            response = await self.respond(row)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertFalse(response.json()['acceptanceRequired'])
        self.assertEqual((await self.call('POST', '/_test/legal-ai', headers=self.headers)).status_code, 200)
        async with SessionLocal() as session:
            evidence = (await session.scalars(select(LegalReceipt))).all()
            self.assertEqual(len(evidence), 1)
            self.assertEqual(evidence[0].locale, 'ja-JP')
            self.assertEqual(evidence[0].digest, legal.digest(row['payload']['translations']['ja-JP']))
            self.assertEqual(evidence[0].user_id, self.uid)

    async def test_stale_revision_or_unknown_language_cannot_be_accepted(self):
        first = await self.publish(action='accept')
        current = await self.publish(version='v2', action='accept')
        self.assertEqual((await self.respond(first)).status_code, 409)
        self.assertEqual((await self.respond(current, locale='ko-KR')).status_code, 409)
        self.assertTrue((await self.status())['acceptanceRequired'])

    async def test_notice_does_not_erase_pending_terms_acceptance_or_create_consent(self):
        await self.publish(action='accept')
        current = await self.publish(version='v2')
        self.assertTrue((await self.status())['acceptanceRequired'])
        self.assertEqual((await self.respond(current)).status_code, 200)
        notice = await self.publish('privacy')
        self.assertFalse((await self.status())['acceptanceRequired'])
        self.assertEqual((await self.respond(notice, 'notice')).status_code, 200)
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(fixture.UserConsent)
                .where(fixture.UserConsent.document == 'privacy', fixture.UserConsent.version == 'v1')), 0)

    async def test_registration_rejects_old_versions_without_spending_email_proof(self):
        row = await self.publish(action='accept')
        proof = await self.proof('second@example.test', device=2)
        body = {**proof, 'password': 'Original-password-123', 'consents': fixture.required_versions()}
        rejected = await self.post('/register', body, device=2)
        self.assertEqual(rejected.status_code, 422)
        async with SessionLocal() as session:
            self.assertIsNone((await session.get(fixture.EmailChallenge, proof['challengeId'])).consumed_at)
        body.update(consents={'terms': 'v1', 'privacy': fixture.required_versions()['privacy']}, consentLocales={'terms': 'ja-JP'})
        success = await self.post('/register', body, device=2)
        self.assertEqual(success.status_code, 200, success.text)
        async with SessionLocal() as session:
            self.assertFalse(await legal.needs_acceptance(session, success.json()['user']['id']))
            receipts = await legal.receipt_details(session, success.json()['user']['id'])
            self.assertEqual(receipts[0]['revisionId'], row['id'])
            self.assertEqual(receipts[0]['locale'], 'ja-JP')

    async def test_export_includes_own_notices_without_mislabeling_them_as_acceptance(self):
        from app.services import account_privacy

        terms = await self.publish(action='accept')
        privacy = await self.publish('privacy')
        self.assertEqual((await self.respond(terms)).status_code, 200)
        self.assertEqual((await self.respond(privacy, 'notice')).status_code, 200)
        tables = [model.__table__ for model in (account_privacy.LibraryFolder, account_privacy.LibraryItem,
                  account_privacy.MemoryRecord, account_privacy.SessionMemory)]
        async with engine.begin() as connection:
            await connection.run_sync(lambda c: Base.metadata.create_all(c, tables=tables))
        async with SessionLocal() as session:
            row = await session.get(LegalVersion, privacy['id'])
            await legal.receipt(session, 'legal-admin', '', row, 'notice', 'en-US')
            await session.commit()
            self.assertEqual(len(await legal.receipt_details(session, self.uid)), 1)
            user = await session.get(User, self.uid)
            encrypted = await account_privacy.build_export(session, user)
        with zipfile.ZipFile(io.BytesIO(account_privacy.cipher().decrypt(encrypted.encode()))) as archive:
            records = json.loads(archive.read('personal-data.json'))['legalReceipts']
        self.assertEqual(len(records), 2)
        self.assertEqual({row['action'] for row in records}, {'accept', 'notice'})
        notice = next(row for row in records if row['action'] == 'notice')
        self.assertEqual(notice['revisionId'], privacy['id'])
        self.assertTrue(notice['recordedAt'])
        self.assertNotIn('acceptedAt', notice)

    async def test_publish_requires_complete_language_content_and_valid_timezone(self):
        payload = self.payload(); payload['translations']['ja-JP']['summary'] = ''
        saved = await self.call('PUT', '/api/v1/admin/legal-documents/terms/draft', {'revision': 0, 'draft': payload})
        result = await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': saved.json()['revision']})
        self.assertEqual(result.status_code, 422)
        result = await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': 1, 'effectiveAt': '2030-01-01T00:00:00'})
        self.assertEqual(result.status_code, 422)
        bad = await self.call('PUT', '/api/v1/admin/legal-documents/privacy/draft', {'revision': 0, 'draft': self.payload(action='accept')})
        self.assertEqual(bad.status_code, 422)

    async def test_publish_competitors_cannot_publish_same_draft_twice(self):
        await self.call('PUT', '/api/v1/admin/legal-documents/terms/draft', {'revision': 0, 'draft': self.payload()})
        results = await asyncio.gather(*[self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': 1}) for _ in range(2)])
        self.assertEqual(sorted(result.status_code for result in results), [200, 409])
        self.assertEqual(next(result.json()['publication']['version'] for result in results if result.status_code == 200), 'v1')
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(LegalVersion)), 1)
            self.assertEqual(await session.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == 'legal.publish')), 1)

    async def test_failed_audit_rolls_back_publication_and_keeps_draft_retryable(self):
        await self.call('PUT', '/api/v1/admin/legal-documents/terms/draft', {'revision': 0, 'draft': self.payload()})
        with patch.object(legal, 'audit_event', side_effect=RuntimeError('fixture audit failure')):
            with self.assertRaisesRegex(RuntimeError, 'fixture audit failure'):
                await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': 1})
        state = await self.state()
        self.assertEqual(state['revision'], 1)
        self.assertEqual(state['history'], [])
        async with SessionLocal() as session:
            self.assertIsNone(await session.get(AppSetting, legal.MARKER))
        retry = await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': 1})
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json()['publication']['version'], 'v1')

    async def test_numbers_are_allocated_only_on_publish_and_legacy_names_are_preserved(self):
        payload = self.payload('operator-input-is-ignored')
        for revision in range(3):
            saved = await self.call('PUT', '/api/v1/admin/legal-documents/terms/draft', {'revision': revision, 'draft': payload})
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(saved.json()['draft']['version'], '')
        self.assertEqual((await self.state())['history'], [])
        result = await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': 3})
        first = result.json()['publication']
        self.assertEqual(first['version'], 'v1')
        # Simulate an existing manually numbered release and an old saved draft.
        async with SessionLocal() as session:
            row = await session.get(LegalVersion, first['id'])
            row.version = 'v2'
            row.payload = {**row.payload, 'version': 'v2'}
            row.digest = legal.digest(row.payload)
            legacy_digest = row.digest
            draft = await session.get(LegalDraft, 'terms')
            draft.payload = {**draft.payload, 'version': 'v2'}
            await session.commit()
        state = await self.state()
        self.assertEqual(state['draft']['version'], '')
        result = await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': state['revision']})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['publication']['version'], 'v3')
        old = await self.call('GET', '/api/v1/client-auth/legal-documents/versions/' + first['id'])
        self.assertTrue(all(row['version'] == 'v2' for row in old.json()['documents']))
        self.assertEqual((await self.state())['history'][1]['digest'], legacy_digest)
        privacy = await self.publish('privacy', version='')
        self.assertEqual(privacy['version'], 'v1')

    async def test_body_whitespace_is_preserved_and_legacy_client_language_stays_unknown(self):
        payload = self.payload()
        payload['translations']['en-US']['content'] = '\n    Exact indented text.\n\n'
        saved = await self.call('PUT', '/api/v1/admin/legal-documents/terms/draft', {'revision': 0, 'draft': payload})
        self.assertEqual(saved.json()['draft']['translations']['en-US']['content'], payload['translations']['en-US']['content'])
        publication = await self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': 1})
        row = publication.json()['publication']
        proof = await self.proof('legacy@example.test', device=2)
        success = await self.post('/register', {**proof, 'password': 'Original-password-123',
            'consents': {'terms': 'v1', 'privacy': fixture.required_versions()['privacy']}}, device=2)
        self.assertEqual(success.status_code, 200, success.text)
        async with SessionLocal() as session:
            receipts = await legal.receipt_details(session, success.json()['user']['id'])
            self.assertEqual(receipts[0]['locale'], '')
            self.assertEqual(receipts[0]['digest'], row['digest'])

    async def test_publication_race_never_records_acceptance_of_an_unseen_revision(self):
        first = await self.publish(action='accept')
        second = await self.publish(version='v2', action='accept')
        async with SessionLocal() as session:
            race_user = 'race-user'
            session.add(User(id=race_user, username=race_user, org_id='root', is_active=True))
            old = await session.get(LegalVersion, first['id'])
            new = await session.get(LegalVersion, second['id'])
            # Model a publication becoming visible between two reads in one request.
            with patch.object(legal, 'active_versions', side_effect=[{'terms': old}, {'terms': new}]):
                await legal.register_receipts(session, race_user, 'email-device-1',
                    {'terms': 'v1', 'privacy': fixture.required_versions()['privacy']}, {'terms': 'en-US'})
            await session.commit()
            rows = (await session.scalars(select(LegalReceipt).where(LegalReceipt.user_id == race_user))).all()
            self.assertEqual([row.version_id for row in rows], [first['id']])
            self.assertTrue(await legal.needs_acceptance(session, race_user))

    async def test_status_uses_one_publication_snapshot_for_documents_and_update_references(self):
        first = await self.publish()
        second = await self.publish(version='v2')
        async with SessionLocal() as session:
            old = await session.get(LegalVersion, first['id'])
            new = await session.get(LegalVersion, second['id'])
            # A concurrent publication must not mix a newer document with an older notification.
            with patch.object(legal, 'active_versions', side_effect=[{'terms': old}, {'terms': new}]) as snapshots:
                result = await legal.status(session, self.uid)
            self.assertEqual({row['revisionId'] for row in result['documents'] if row['key'] == 'terms'}, {first['id']})
            self.assertEqual(result['updates'][0]['revisionId'], first['id'])
            self.assertEqual(snapshots.await_count, 1)


if __name__ == '__main__':
    unittest.main()
