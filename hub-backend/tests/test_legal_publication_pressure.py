"""Bounded ASGI/SQLite load checks; no live accounts or published documents."""
import asyncio
import json
import time
import unittest
from datetime import timedelta

from sqlalchemy import event, func, insert, select

import test_legal_publications as fixture
from app.db import SessionLocal, engine
from app.legal_models import LegalReceipt, LegalVersion
from app.models import AuditLog
from app.services import legal_publications as legal


class LegalPublicationPressureTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.LegalPublicationsTests.asyncSetUp
    asyncTearDown = fixture.LegalPublicationsTests.asyncTearDown
    post = fixture.LegalPublicationsTests.post
    proof = fixture.LegalPublicationsTests.proof
    call = fixture.LegalPublicationsTests.call
    state = fixture.LegalPublicationsTests.state
    payload = fixture.LegalPublicationsTests.payload
    publish = fixture.LegalPublicationsTests.publish
    respond = fixture.LegalPublicationsTests.respond

    async def test_publication_and_receipt_bursts_remain_atomic_and_idempotent(self):
        saved = await self.call('PUT', '/api/v1/admin/legal-documents/terms/draft',
            {'revision': 0, 'draft': self.payload(action='accept')})
        self.assertEqual(saved.status_code, 200)
        started = time.perf_counter()
        responses = await asyncio.gather(*[
            self.call('POST', '/api/v1/admin/legal-documents/terms/publish', {'revision': 1})
            for _ in range(16)])
        self.assertEqual(sorted(response.status_code for response in responses), [200] + [409] * 15)
        publication = next(response.json()['publication'] for response in responses if response.status_code == 200)
        receipts = await asyncio.gather(*[self.respond(publication) for _ in range(16)])
        self.assertTrue(all(response.status_code == 200 for response in receipts))
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(LegalVersion)), 1)
            self.assertEqual(await session.scalar(select(func.count()).select_from(LegalReceipt)), 1)
            self.assertEqual(await session.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == 'legal.publish')), 1)
        print(json.dumps({'scenario': 'publication-receipt-bursts', 'writers': 16, 'receipt_replays': 16,
            'elapsed_ms': round((time.perf_counter() - started) * 1000, 1)}))

    async def test_status_load_keeps_document_queries_bounded_with_large_history_and_body(self):
        publication = await self.publish()
        timestamp = legal.now() - timedelta(days=365)
        payload = self.payload()
        large_text = 'Exact legal paragraph. ' * 8000
        self.assertLess(len(large_text), 200000)
        payload['version'] = 'v1'
        payload['translations'] = {locale: {'title': 'Legal text', 'content': large_text,
            'summary': 'Fixture summary', 'format': 'text'} for locale in ('en-US', 'fr-FR', 'de-DE', 'es-ES')}
        history = 1000
        async with SessionLocal() as session:
            row = await session.get(LegalVersion, publication['id'])
            row.payload = payload
            row.digest = legal.digest(payload)
            await session.execute(insert(LegalVersion), [{'id': f'history-{index}', 'kind': 'terms',
                'version': f'legacy-{index}', 'payload': self.payload(), 'digest': 'fixture-digest', 'action': 'notice',
                'effective_at': timestamp, 'published_at': timestamp, 'published_by': 'legal-admin'} for index in range(history)])
            await session.execute(insert(LegalReceipt), [{'id': f'evidence-{index}', 'user_id': self.uid,
                'version_id': f'history-{index}', 'action': 'notice', 'locale': 'en-US', 'digest': 'fixture-digest',
                'device_id': 'fixture-device'} for index in range(history)])
            await session.commit()
        statements = []
        def capture(_conn, _cursor, statement, _parameters, _context, _many):
            statements.append(statement)
        event.listen(engine.sync_engine, 'before_cursor_execute', capture)
        durations = []
        semaphore = asyncio.Semaphore(8)
        async def request():
            async with semaphore:
                started = time.perf_counter()
                response = await self.call('GET', '/api/v1/client-auth/me/legal-status', headers=self.headers)
                self.assertEqual(response.status_code, 200, response.text[:200])
                data = response.json()
                terms = [row for row in data['documents'] if row['key'] == 'terms']
                self.assertEqual(len(terms), 4)
                self.assertTrue(all(row['content'] == large_text and row['revisionId'] == publication['id'] for row in terms))
                self.assertEqual(data['updates'][0]['revisionId'], publication['id'])
                durations.append((time.perf_counter() - started) * 1000)
        started = time.perf_counter()
        try:
            await asyncio.wait_for(asyncio.gather(*[request() for _ in range(64)]), timeout=60)
        finally:
            event.remove(engine.sync_engine, 'before_cursor_execute', capture)
        body_queries = [sql for sql in statements if sql.startswith('SELECT') and 'legal_version.payload' in sql]
        receipt_queries = [sql for sql in statements if sql.startswith('SELECT legal_receipt.version_id')]
        self.assertEqual(len(body_queries), 64 * 2)
        self.assertEqual(len(receipt_queries), 64)
        self.assertTrue(all('legal_receipt.version_id IN' in sql for sql in receipt_queries))
        durations.sort()
        print(json.dumps({'scenario': 'large-history-status', 'requests': 64, 'concurrency': 8,
            'historical_versions': history, 'historical_receipts': history, 'body_characters': len(large_text) * 4,
            'body_queries_per_request': len(body_queries) / 64,
            'p50_ms': round(durations[len(durations) // 2], 1), 'p95_ms': round(durations[int(len(durations) * 0.95)], 1),
            'max_ms': round(max(durations), 1), 'elapsed_ms': round((time.perf_counter() - started) * 1000, 1)}))


if __name__ == '__main__':
    unittest.main()
