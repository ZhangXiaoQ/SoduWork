"""Real filesystem/ZIP compatibility for per-turn local file delivery."""
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import ai_local


class LocalArtifactContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-artifact-contract-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.run = {"ref": "fixture-run", "ws": str(self.workspace), "seen": set()}

    def write(self, name, body, timestamp):
        full = self.workspace / name
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(body)
        os.utime(full, (1700000000 + timestamp, 1700000000 + timestamp))

    def test_archive_preserves_directories_exact_bytes_and_live_store_override(self):
        expected = {"index.html": b'<link href="css/site.css">',
                    "css/site.css": b"body { color: blue }", "assets/data.bin": b"\x00\xff",
                    "guide.md": b"Guide", "summary.txt": b"Summary"}
        for i, (name, data) in enumerate(expected.items()):
            self.write(name, data, 1000 + i)
        with patch.object(ai_local, "_store_dir", return_value=str(self.root / "archive")) as store:
            bundle = ai_local._bundle_artifact(self.run, ai_local._fresh_entries(self.run))
        store.assert_called_once_with("fixture-run")
        self.assertEqual(bundle["files"], len(expected))
        filename = self.root / "archive" / "bundles" / bundle["filename"]
        with zipfile.ZipFile(filename) as zipped:
            self.assertEqual({name: zipped.read(name) for name in zipped.namelist()}, expected)

    def flat_output_status(self, count):
        expected = {}
        for index in range(count):
            name = "output-%02d.md" % index
            expected[name] = bytes((index, 0, 255)) + name.encode("utf-8")
            self.write(name, expected[name], 2000 + index)
        self.assertEqual(len(ai_local._fresh_entries(self.run)), count)
        self.assertEqual(set(ai_local._new_files(self.run)), set(expected))
        self.assertEqual(self.run["artDropped"], 0)
        run = dict(self.run, state="done", artifactMode="files", cli="pi", lines=[])
        with patch.dict(ai_local._RUNS, {run["ref"]: run}), patch.object(
            ai_local, "_store_dir", return_value=str(self.root / "archive")
        ):
            status = ai_local.status_sync({}, run["ref"])
            self.assertTrue(status["ok"])
            attachments = status["attachments"]
            individual = [item for item in attachments if not item["id"].startswith("@bundle/")]
            bundles = [item for item in attachments if item["id"].startswith("@bundle/")]
            self.assertEqual(len(individual), count)
            self.assertEqual({item["filename"] for item in individual}, set(expected))
            for item in individual:
                self.assertEqual(ai_local.fetch_attachment_for_sync({}, run["ref"], item["id"]),
                                 expected[item["filename"]])
            bundled_bytes = [ai_local.fetch_attachment_for_sync({}, run["ref"], item["id"])
                             for item in bundles]
        self.assertEqual(status["artifactsDropped"], 0)
        self.assertEqual(status["artifactsHidden"], 0)
        return status, bundles, bundled_bytes, expected

    def test_auto_archive_starts_after_two_final_outputs_without_renaming_loose_files(self):
        for count in (1, 2, 3, 20):
            with self.subTest(files=count):
                status, bundles, bundled_bytes, expected = self.flat_output_status(count)
                bundled = count > 2
                self.assertEqual(len(status["attachments"]), count + int(bundled))
                self.assertEqual(len(bundles), int(bundled))
                self.assertEqual(status["artifactsBundled"], count if bundled else 0)
                if bundled:
                    with zipfile.ZipFile(io.BytesIO(bundled_bytes[0])) as zipped:
                        self.assertEqual({name: zipped.read(name) for name in zipped.namelist()}, expected)

    def test_twenty_one_flat_outputs_expose_individual_files_and_complete_bundle(self):
        status, bundles, bundled_bytes, expected = self.flat_output_status(21)
        self.assertEqual(len(status["attachments"]), 22)
        self.assertEqual(len(bundles), 1)
        self.assertEqual(status["artifactsBundled"], 21)
        self.assertIsNotNone(bundled_bytes[0])
        with zipfile.ZipFile(io.BytesIO(bundled_bytes[0])) as zipped:
            self.assertEqual(len(zipped.namelist()), 21)
            self.assertEqual({name: zipped.read(name) for name in zipped.namelist()}, expected)

    def test_noise_baseline_and_live_cap_override_keep_the_original_delivery_rules(self):
        self.write("existing.txt", b"unchanged", 1000)
        self.run["seen"] = ai_local._snapshot(str(self.workspace))
        self.write("report.md", b"report", 1001)
        self.write("assets/facts.json", b"{}", 1002)
        self.write(".pytest_cache/CACHEDIR.TAG", b"cache", 1003)
        self.write("application.db", b"private database", 1004)
        entries = ai_local._fresh_entries(self.run)
        # Internal file selections retain native separators; ZIP names use "/".
        selected = os.path.join("assets", "facts.json")
        self.assertEqual([name for name, _ in entries], [selected, "report.md"])
        with patch.object(ai_local, "_ART_CAP", 1):
            self.assertEqual(ai_local._new_files(self.run), [selected])
        self.assertEqual(self.run["artDropped"], 1)

    def test_outside_files_and_symlink_targets_never_enter_a_bundle(self):
        external = self.root / "private.txt"
        external.write_text("private")
        self.assertEqual(ai_local._safe_work_file(self.run, "../private.txt"), "")
        self.write("outputs/report.md", b"report", 1000)
        with patch.object(ai_local, "_store_dir", return_value=str(self.root / "archive")) as store:
            self.assertIsNone(ai_local._bundle_artifact(
                self.run, [("../private.txt", 1001), ("outputs/report.md", 1000)]))
        store.assert_not_called()
        if os.name != "nt":
            (self.workspace / "outputs" / "linked.txt").symlink_to(external)
            self.assertEqual(ai_local._safe_work_file(self.run, "outputs/linked.txt"), "")
            with patch.object(ai_local, "_store_dir", return_value=str(self.root / "archive")) as store:
                self.assertIsNone(ai_local._bundle_artifact(
                    self.run, [("outputs/linked.txt", 1001), ("outputs/report.md", 1000)]))
            store.assert_not_called()
        self.assertFalse((self.root / "archive").exists())


    def test_single_file_has_no_bundle_and_verification_is_not_added_to_a_bundle(self):
        self.write('result.md', b'result', 1000)
        self.write('screenshot.png', b'proof', 1001)
        with patch.object(ai_local, '_store_dir', return_value=str(self.root / 'archive')):
            self.assertIsNone(ai_local._bundle_artifact(self.run, ai_local._fresh_entries(self.run)))
            self.write('appendix.md', b'appendix', 1002)
            self.assertIsNone(ai_local._bundle_artifact(self.run, ai_local._fresh_entries(self.run)))
            self.write('summary.txt', b'summary', 1003)
            bundle = ai_local._bundle_artifact(self.run, ai_local._fresh_entries(self.run))
        with zipfile.ZipFile(self.root / 'archive' / 'bundles' / bundle['filename']) as archive:
            self.assertEqual(set(archive.namelist()), {'result.md', 'appendix.md', 'summary.txt'})

    def test_support_files_do_not_trigger_auto_archive_but_overflow_remains_complete(self):
        self.write('index.html', b'<link href="site.css">', 1000)
        self.write('site.css', b'body{}', 1001)
        self.write('script.js', b'void 0;', 1002)
        with patch.object(ai_local, '_store_dir', return_value=str(self.root / 'archive')):
            self.assertIsNone(ai_local._bundle_artifact(self.run, ai_local._fresh_entries(self.run)))
            for index in range(201):
                self.write('assets/%s.css' % index, b'body{}', 1003 + index)
            bundle = ai_local._bundle_artifact(self.run, ai_local._fresh_entries(self.run))
            self.assertEqual(bundle['files'], 204)
            with zipfile.ZipFile(self.root / 'archive' / 'bundles' / bundle['filename']) as archive:
                self.assertEqual(len(archive.namelist()), 204)


if __name__ == "__main__":
    unittest.main()
