import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("content_installer", Path(__file__).with_name("install.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InstallerTests(unittest.TestCase):
    def test_install_and_repeat_preserve_existing_assistant_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            package, home = base / "package", base / "hermes"
            package.mkdir()
            home.mkdir()
            config = home / "config.yaml"
            config.write_text("mcp_servers:\n  existing: keep\n")
            skill = package / "skills/channel-blog-writing/SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("Content-only skill")
            digest = hashlib.sha256(skill.read_bytes()).hexdigest()
            (package / "MANIFEST.json").write_text(json.dumps({"version": "1", "credentialIncluded": False, "files": {"skills/channel-blog-writing/SKILL.md": digest}}))
            before = config.read_bytes()
            self.assertTrue(module.install(package, home)["ok"])
            self.assertTrue(module.install(package, home)["alreadyInstalled"])
            self.assertEqual(config.read_bytes(), before)
            (home / "skills/channel-blog-writing/SKILL.md").write_text("Human edits")
            with self.assertRaises(ValueError):
                module.install(package, home)
            self.assertEqual((home / "skills/channel-blog-writing/SKILL.md").read_text(), "Human edits")

    def test_a_package_mismatch_or_unknown_assistant_home_does_not_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "MANIFEST.json").write_text(json.dumps({"version": "1", "credentialIncluded": False, "files": {"skills/channel-blog-writing/SKILL.md": "0" * 64}}))
            with self.assertRaises((ValueError, FileNotFoundError)):
                module.install(base, base / "missing")
