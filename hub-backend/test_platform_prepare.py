"""Offline DWS preparation regression; all archives and executables are temporary fixtures."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
import warnings
import zipfile

os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'
SCRIPT = Path(__file__).resolve().parent / 'plugins/platforms/prepare-dingtalk.py'
SPEC = importlib.util.spec_from_file_location('soduwork_prepare_dingtalk', SCRIPT)
prepare_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare_module)
LOCK = {'package': 'dingtalk-workspace-cli', 'version': '1.0.61'}
PAYLOAD = b'INERT DWS FIXTURE: this is never executed\n'


def directory_link(target: Path, link: Path) -> None:
    if os.name == 'nt':
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    else:
        link.symlink_to(target, target_is_directory=True)


def rename_fixture_directory(source: Path, target: Path) -> None:
    # A scanner may briefly retain a handle after the synthetic ZIP is closed.
    # Retry only fixture setup; the junction/security assertions below still run.
    for delay in (0, 0.05, 0.2, 0.5):
        if delay:
            time.sleep(delay)
        try:
            source.rename(target)
            return
        except PermissionError as error:
            if os.name != 'nt' or error.winerror not in (5, 32) or delay == 0.5:
                raise


def archive_bytes(system='win32', members=None, symlink=None):
    """Return a synthetic archive; payloads are text, never real CLI programs."""
    output = io.BytesIO()
    if system == 'win32':
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
                for name, content in members if members is not None else [('dws.exe', PAYLOAD)]:
                    archive.writestr(name, content)
    else:
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            for name, content in members if members is not None else [('dws', PAYLOAD)]:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            if symlink:
                member = tarfile.TarInfo(symlink[0])
                member.type = tarfile.SYMTYPE
                member.linkname = symlink[1]
                archive.addfile(member)
    return output.getvalue()


class DingtalkPrepareTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='soduwork-dws-prepare-')
        self.root = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        self.prefix = self.root / 'independent CLI'
        self.package = self.prefix / 'node_modules/dingtalk-workspace-cli'
        (self.package / 'assets').mkdir(parents=True)
        (self.package / 'package.json').write_text(json.dumps({
            'name': LOCK['package'], 'version': LOCK['version'],
        }), encoding='utf8')

    def write_archive(self, system='win32', machine='amd64', members=None, symlink=None):
        os_name = {'win32': 'windows', 'linux': 'linux', 'darwin': 'darwin'}[system]
        suffix = '.zip' if system == 'win32' else '.tar.gz'
        name = 'dws-' + os_name + '-' + machine + suffix
        data = archive_bytes(system, members, symlink)
        target = self.package / 'assets' / name
        target.write_bytes(data)
        # Exercise the standard checksum file's optional binary marker.
        (self.package / 'assets/checksums.txt').write_text(
            hashlib.sha256(data).hexdigest() + ' *' + name + '\n', encoding='utf8')
        return target

    def prepare(self, system='win32', machine='amd64'):
        with patch('subprocess.Popen', side_effect=AssertionError('Preparation must not execute programs')):
            with patch('socket.socket', side_effect=AssertionError('Preparation must stay offline')):
                return prepare_module.prepare(self.prefix, LOCK, system=system, machine=machine)

    def test_windows_root_binary_checksum_mode_and_idempotence(self):
        self.write_archive()
        first = self.prepare(machine='AMD64')
        target = self.package / 'vendor/dws.exe'
        before = target.stat().st_mtime_ns
        second = self.prepare(machine='x86_64')
        self.assertEqual(first, second)
        self.assertEqual(target.read_bytes(), PAYLOAD)
        self.assertEqual(before, target.stat().st_mtime_ns, 'Repeat preparation must not rewrite a binary')
        self.assertEqual(first['sha256'], hashlib.sha256(PAYLOAD).hexdigest())
        self.assertEqual(first['authentication'], 'not-checked')
        self.assertEqual(first['version'], LOCK['version'])
        self.assertEqual(set((self.package / 'vendor').iterdir()), {target})

    def test_linux_tar_root_binary_and_macos_dot_root_binary(self):
        for system, binary_name, machine in [('linux', 'dws', 'amd64'), ('darwin', './dws', 'arm64')]:
            with self.subTest(system=system):
                self.write_archive(system, machine, [(binary_name, PAYLOAD)])
                result = self.prepare(system, 'aarch64' if machine == 'arm64' else 'x64')
                self.assertEqual(Path(result['path']).name, 'dws')
                self.assertEqual(Path(result['path']).read_bytes(), PAYLOAD)
                if os.name != 'nt':
                    self.assertTrue(Path(result['path']).stat().st_mode & 0o111)

    def test_checksum_mismatch_and_missing_checksum_fail_before_writing(self):
        target = self.write_archive()
        target.write_bytes(target.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.prepare()
        self.assertFalse((self.package / 'vendor').exists())
        self.write_archive()
        (self.package / 'assets/checksums.txt').write_text('invalid checksum row\n', encoding='utf8')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.prepare()
        self.assertFalse((self.package / 'vendor').exists())

    def test_archive_traversal_and_extra_members_are_never_extracted(self):
        for system, binary in [('win32', 'dws.exe'), ('linux', 'dws')]:
            with self.subTest(system=system):
                self.write_archive(system, members=[
                    (binary, PAYLOAD), ('../../escape.txt', b'do not extract'),
                    ((self.root / 'absolute-escape.txt').as_posix(), b'do not extract'),
                    ('other/install-agent-skill.sh', b'do not execute'),
                    ('nested/' + binary, b'wrong binary'),
                ])
                before = {p.relative_to(self.root) for p in self.root.rglob('*')}
                result = self.prepare(system)
                after = {p.relative_to(self.root) for p in self.root.rglob('*')}
                allowed = {(self.package / 'vendor').relative_to(self.root), Path(result['path']).relative_to(self.root)}
                self.assertTrue(after - before <= allowed)
                self.assertEqual(Path(result['path']).read_bytes(), PAYLOAD)

    def test_nested_duplicate_or_missing_root_binary_is_rejected(self):
        for system, binary in [('win32', 'dws.exe'), ('linux', 'dws')]:
            for members in [[('nested/' + binary, PAYLOAD)], [], [(binary, PAYLOAD), (binary, PAYLOAD)]]:
                with self.subTest(system=system, members=len(members)):
                    self.write_archive(system, members=members)
                    with self.assertRaisesRegex(ValueError, 'one bounded root executable'):
                        self.prepare(system)
                    self.assertFalse((self.package / 'vendor').exists())

    def test_tar_symbolic_link_cannot_be_the_executable(self):
        self.write_archive('linux', members=[], symlink=('dws', '../../outside'))
        with self.assertRaisesRegex(ValueError, 'one bounded root executable'):
            self.prepare('linux')
        self.assertFalse((self.package / 'vendor').exists())

    def test_zero_size_and_oversized_uncompressed_binary_are_rejected(self):
        for system, binary in [('win32', 'dws.exe'), ('linux', 'dws')]:
            with self.subTest(system=system, size='zero'):
                self.write_archive(system, members=[(binary, b'')])
                with self.assertRaisesRegex(ValueError, 'invalid size'):
                    self.prepare(system)
            with self.subTest(system=system, size='large'):
                self.write_archive(system, members=[(binary, b'0' * 10000)])
                with patch.object(prepare_module, 'MAX_BYTES', 512):
                    with self.assertRaisesRegex(ValueError, 'one bounded root executable'):
                        self.prepare(system)
        self.assertFalse((self.package / 'vendor').exists())

    def test_archive_size_bound_is_checked_before_reading(self):
        self.write_archive()
        with patch.object(prepare_module, 'MAX_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'archive is too large'):
                self.prepare()
        self.assertFalse((self.package / 'vendor').exists())

    def test_existing_different_binary_is_preserved(self):
        self.write_archive()
        target = self.package / 'vendor/dws.exe'
        target.parent.mkdir()
        target.write_bytes(b'existing binary must remain')
        with self.assertRaisesRegex(ValueError, 'Existing executable differs'):
            self.prepare()
        self.assertEqual(target.read_bytes(), b'existing binary must remain')
        self.assertEqual(list(target.parent.iterdir()), [target])

    def test_package_junction_cannot_escape_installation_prefix(self):
        outside = self.root / 'outside package'
        rename_fixture_directory(self.package, outside)
        directory_link(outside, self.package)
        with self.assertRaisesRegex(ValueError, 'Package cannot escape'):
            self.prepare()
        self.assertFalse((outside / 'vendor').exists())

    def test_archive_junction_cannot_escape_official_package(self):
        self.write_archive()
        outside = self.root / 'outside archives'
        rename_fixture_directory(self.package / 'assets', outside)
        directory_link(outside, self.package / 'assets')
        with self.assertRaisesRegex(ValueError, 'Archive cannot escape'):
            self.prepare()
        self.assertFalse((self.package / 'vendor').exists())

    def test_vendor_junction_cannot_write_outside_package(self):
        self.write_archive()
        outside = self.root / 'outside vendor'
        outside.mkdir()
        keep = outside / 'keep.txt'
        keep.write_text('untouched', encoding='utf8')
        directory_link(outside, self.package / 'vendor')
        with self.assertRaisesRegex(ValueError, 'Vendor directory cannot escape'):
            self.prepare()
        self.assertEqual(list(outside.iterdir()), [keep])
        self.assertEqual(keep.read_text(encoding='utf8'), 'untouched')

    def test_wrong_package_name_version_platform_and_relative_prefix_fail(self):
        self.write_archive()
        for metadata in [{'name': 'unexpected', 'version': LOCK['version']},
                         {'name': LOCK['package'], 'version': '0.0.0'}]:
            (self.package / 'package.json').write_text(json.dumps(metadata), encoding='utf8')
            with self.assertRaisesRegex(ValueError, 'exact pinned official npm package'):
                self.prepare()
        (self.package / 'package.json').write_text(json.dumps({'name': LOCK['package'], 'version': LOCK['version']}), encoding='utf8')
        for system, machine in [('freebsd', 'amd64'), ('win32', 'ia32'), ('linux', 'mips')]:
            with self.assertRaisesRegex(ValueError, 'Unsupported DWS platform'):
                self.prepare(system, machine)
        with self.assertRaisesRegex(ValueError, 'absolute directory'):
            prepare_module.prepare(Path('relative-prefix'), LOCK, system='win32', machine='amd64')
        self.assertFalse((self.package / 'vendor').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)