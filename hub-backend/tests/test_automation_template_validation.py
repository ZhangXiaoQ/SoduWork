"""Identity validation rejects malformed writes before mutating the template catalog."""
import asyncio
import os
import unittest
os.environ.setdefault("AUTH_SECRET", "isolated-template-validation-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-template-validation-admin")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models
from app.services import automation_templates as templates

VALID = {"id": "daily-report", "name": "日报", "note": "Keep instructions"}
INVALID = [
    ({"id": ""}, "请填写模板标识"), ({"id": "a"}, "2–64"),
    ({"id": "a" * 65}, "2–64"), ({"id": "Daily-Report"}, "小写"),
    ({"id": " daily-report"}, "空格"), ({"id": "daily-report\n"}, "空格"),
    ({"id": "_daily"}, "开头"), ({"id": "每日"}, "小写"),
    ({"id": "daily/report"}, "仅支持"), ({"id": "daily report"}, "空格"),
    ({"id": ["daily-report"]}, "请填写模板标识"),
    ({"name": " 　"}, "不能全为空白"), ({"name": ""}, "填写"),
    ({"name": "报" * 81}, "80"), ({"name": "日报\n总结"}, "控制字符"),
    ({"name": "日报\x00"}, "控制字符"), ({"name": ["日报"]}, "填写"),
]

class TemplateValidationTests(unittest.TestCase):
    def test_rejects_malformed_values_without_coercion_or_truncation(self):
        for changes, message in INVALID:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, message):
                templates.normalize({**VALID, **changes})

    def test_accepts_boundaries_multilingual_names_and_trims_display_name(self):
        for template_id, name in [("a1", "报"), ("a" * 64, "报" * 80),
                                  ("1.a_b-c", " Weekly 日報 주간 / Review（2026） 📊 "),
                                  ("emoji", "📊" * 80)]:
            result = templates.normalize({**VALID, "id": template_id, "name": name})
            self.assertEqual(result["id"], template_id)
            self.assertEqual(result["name"], name.strip())

    def test_normalizes_optional_date_range_and_rejects_invalid_ranges(self):
        result = templates.normalize({**VALID, "startDate": "2026-11-12", "endDate": "2026-12-01"})
        self.assertEqual(result["startDate"], "2026-11-12")
        self.assertEqual(result["endDate"], "2026-12-01")
        with self.assertRaisesRegex(ValueError, "结束日期不能早于开始日期"):
            templates.normalize({**VALID, "startDate": "2026-12-01", "endDate": "2026-11-12"})
        with self.assertRaisesRegex(ValueError, "开始日期格式无效"):
            templates.normalize({**VALID, "startDate": "2026-02-30"})

    def test_invalid_batch_and_duplicate_id_leave_persisted_catalog_unchanged(self):
        async def scenario():
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(models.Base.metadata.create_all)
                sessions = async_sessionmaker(engine, expire_on_commit=False)
                async with sessions() as db:
                    before = await templates.save(db, [VALID])
                    await db.commit()
                    for changes, message in INVALID:
                        with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, message):
                            await templates.save(db, [VALID, {**VALID, "id": "another", **changes}])
                        self.assertEqual(await templates.load(db), before)
                    with self.assertRaisesRegex(ValueError, "模板标识不能重复"):
                        await templates.save(db, [VALID, {**VALID, "name": "Another", "enabled": False}])
                    self.assertEqual(await templates.load(db), before)
            finally:
                await engine.dispose()
        asyncio.run(scenario())

if __name__ == "__main__":
    unittest.main()
