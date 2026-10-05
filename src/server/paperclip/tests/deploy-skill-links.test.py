import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("deploy", HERE.parent / "scripts/deploy-native-release.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class RepointManagedSkillLinks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name).resolve()
        self.root, self.home = base / "deploy", base / "home"
        for rel in ["old/skills/paperclip", "new/skills/paperclip", "old/skills/only-old"]:
            (self.root / rel).mkdir(parents=True)
        (base / "user-skill").mkdir()
        self.new = self.root / "new"

    def tearDown(self):
        self.tmp.cleanup()

    def link(self, rel, target):
        p = self.home / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.symlink_to(target)
        return p

    def test_repoints_only_managed_stale_links(self):
        hermes = self.link(".hermes/skills/paperclip", self.root / "old/skills/paperclip")
        pi = self.link(".pi/agent/skills/paperclip", self.root / "old/skills/paperclip")
        user = self.link(".claude/skills/mine", Path(self.tmp.name).resolve() / "user-skill")
        compat = self.link(".leophoneagent/paperclip", self.root)
        missing = self.link(".cursor/skills/only-old", self.root / "old/skills/only-old")
        current = self.link(".codex/skills/paperclip", self.root / "new/skills/paperclip")

        changed = deploy.repoint_managed_skill_links(self.root, self.new, home=self.home)

        self.assertEqual(sorted(c[0] for c in changed), sorted([str(hermes), str(pi)]))
        self.assertEqual(Path(os.readlink(hermes)), self.new / "skills/paperclip")
        self.assertEqual(Path(os.readlink(pi)), self.new / "skills/paperclip")
        self.assertEqual(Path(os.readlink(user)), Path(self.tmp.name).resolve() / "user-skill")
        self.assertEqual(Path(os.readlink(compat)), self.root)
        self.assertEqual(Path(os.readlink(missing)), self.root / "old/skills/only-old")
        self.assertEqual(Path(os.readlink(current)), self.root / "new/skills/paperclip")
        # 再次运行无变化（幂等）
        self.assertEqual(deploy.repoint_managed_skill_links(self.root, self.new, home=self.home), [])


if __name__ == "__main__":
    unittest.main()
