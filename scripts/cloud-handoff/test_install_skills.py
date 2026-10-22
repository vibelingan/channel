"""Focused offline checks for untrusted archives and preserving existing skills."""
import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('installer', pathlib.Path(__file__).with_name('install-skills.py'))
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as writer:
        for path, content, kind in entries:
            member = tarfile.TarInfo(path)
            member.type = kind
            member.size = len(content) if kind == tarfile.REGTYPE else 0
            writer.addfile(member, io.BytesIO(content) if member.size else None)
    return output.getvalue()


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.entries = [('repo/SKILL.md', b'---\nname: demo\n---\n', tarfile.REGTYPE),
                        ('repo/LICENSE', b'MIT', tarfile.REGTYPE)]

    def select(self, data):
        return INSTALLER.select_files(data, {'archiveSha256': hashlib.sha256(data).hexdigest()}, {'path': '.'})

    def test_success_and_idempotent_install(self):
        files = self.select(archive(self.entries))
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)
            self.assertEqual(INSTALLER.install_files(path, 'demo', files), 'installed')
            self.assertEqual(INSTALLER.install_files(path, 'demo', files), 'unchanged')
            self.assertIn('UPSTREAM-LICENSE', files)

    def test_checksum_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            INSTALLER.select_files(archive(self.entries), {'archiveSha256': '0' * 64}, {'path': '.'})

    def test_path_traversal_rejected(self):
        for path in ['repo/../../escape', '/absolute/file', 'repo/dir\\file']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.select(archive(self.entries + [(path, b'x', tarfile.REGTYPE)]))

    def test_symlink_and_duplicate_rejected(self):
        for entry in [('repo/link', b'', tarfile.SYMTYPE), self.entries[0]]:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                self.select(archive(self.entries + [entry]))

    def test_missing_skill_rejected(self):
        with self.assertRaises(ValueError):
            self.select(archive([self.entries[1]]))

    def test_plugin_bridge_preserves_notice_and_does_not_execute_hooks(self):
        data = archive([('repo/README.md', b'Private. Not licensed for redistribution.', tarfile.REGTYPE),
                        ('repo/hooks/setup.sh', b'exit 99', tarfile.REGTYPE)])
        source = {'archiveSha256': hashlib.sha256(data).hexdigest(), 'noticeFile': 'README.md'}
        skill = {'path': '.', 'codexEntry': 'docs/cloud-handoff/dev-pipeline-codex.SKILL.md'}
        files = INSTALLER.select_files(data, source, skill)
        self.assertIn(b'name: dev-pipeline', files['SKILL.md'])
        self.assertEqual(files['UPSTREAM-NOTICE'], b'Private. Not licensed for redistribution.')
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory)
            self.assertEqual(INSTALLER.install_files(destination, 'demo', files), 'installed')
            self.assertEqual(INSTALLER.install_files(destination, 'demo', files), 'unchanged')
            self.assertEqual((destination / 'demo/hooks/setup.sh').read_bytes(), b'exit 99')

    def test_bridge_cannot_replace_upstream_entry_or_escape_repo(self):
        data = archive(self.entries)
        source = {'archiveSha256': hashlib.sha256(data).hexdigest()}
        with self.assertRaises(ValueError):
            INSTALLER.select_files(data, source, {
                'path': '.', 'codexEntry': 'docs/cloud-handoff/dev-pipeline-codex.SKILL.md'})
        plugin_data = archive([('repo/README.md', b'Private', tarfile.REGTYPE)])
        source = {'archiveSha256': hashlib.sha256(plugin_data).hexdigest(), 'noticeFile': 'README.md'}
        for entry in ['../outside', '/absolute']:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                INSTALLER.select_files(plugin_data, source, {'path': '.', 'codexEntry': entry})

    def test_explicit_notice_must_exist_inside_archive(self):
        data = archive(self.entries)
        for notice in ['missing', '../LICENSE', '/LICENSE']:
            with self.subTest(notice=notice), self.assertRaises(ValueError):
                INSTALLER.select_files(data, {'archiveSha256': hashlib.sha256(data).hexdigest(),
                                              'noticeFile': notice}, {'path': '.'})

    def test_existing_different_install_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)
            INSTALLER.install_files(path, 'demo', {'SKILL.md': b'local'})
            with self.assertRaises(ValueError):
                INSTALLER.install_files(path, 'demo', {'SKILL.md': b'upstream'})
            self.assertEqual((path / 'demo/SKILL.md').read_bytes(), b'local')

    def test_existing_symlink_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)
            (path / 'demo').symlink_to(path / 'elsewhere')
            with self.assertRaises(ValueError):
                INSTALLER.install_files(path, 'demo', {'SKILL.md': b'x'})
            self.assertTrue((path / 'demo').is_symlink())

    def test_locked_sources_are_complete(self):
        lock = json.loads((INSTALLER.ROOT / 'docs/cloud-handoff/skills.lock.json').read_text())
        names = []
        for source in lock['sources']:
            self.assertRegex(source['commit'], r'^[a-f0-9]{40}$')
            self.assertRegex(source['archiveSha256'], r'^[a-f0-9]{64}$')
            for skill in source['skills']:
                names.append(skill['name'])
                INSTALLER.checked_path(skill['path'])
        self.assertEqual(len(names), len(set(names)))


if __name__ == '__main__':
    unittest.main()
