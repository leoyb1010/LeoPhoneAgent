import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

LAUNCHER = Path(__file__).resolve().parents[1] / "scripts/start-native-server.sh"
STORAGE_GUARD = LAUNCHER.read_text().split("<<'PY_STORAGE_GUARD'\n", 1)[1].split("\nPY_STORAGE_GUARD", 1)[0]

def launcher_env(**values):
    return {**{key: value for key, value in os.environ.items() if key not in ("PAPERCLIP_STORAGE_VOLUME", "PAPERCLIP_STORAGE_VOLUME_UUID")}, **values}

class NativeLauncherTest(unittest.TestCase):
    def test_launchd_sparse_path_finds_cli_without_replacing_pinned_node_or_home(self):
        with tempfile.TemporaryDirectory(prefix="paperclip launcher ") as tmp:
            root = Path(tmp)
            (root / "env").mkdir()
            (root / "env/server.env").write_text("export PAPERCLIP_TEST_MARKER=ready\nexport HTTPS_PROXY=http://127.0.0.1:7890\nexport NO_PROXY=localhost,127.0.0.1,::1\n")
            (root / "env/server.env").chmod(0o600)
            (root / "release/current").mkdir(parents=True)
            node = root / "runtime/node-v24.11.0-darwin-arm64/bin/node"
            node.parent.mkdir(parents=True)
            node.write_text('#!/bin/bash\nprintf "%s\\n" "$(command -v codex)" "$(command -v node)" "$HOME" "$PWD" "$PAPERCLIP_TEST_MARKER" "$HTTPS_PROXY" "$NO_PROXY" "$@"\n')
            node.chmod(0o755)
            cli_bin = root / "user global bin"
            cli_bin.mkdir()
            codex = cli_bin / "codex"
            codex.write_text("#!/bin/sh\nexit 0\n")
            codex.chmod(0o755)
            env = launcher_env(PATH="/usr/bin:/bin", PAPERCLIP_DEPLOY_ROOT=str(root), PAPERCLIP_CLI_BIN_DIR=str(cli_bin))
            result = subprocess.run(["/bin/bash", str(LAUNCHER)], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), [str(codex), str(node), os.environ["HOME"], str(root / "release/current"), "ready", "http://127.0.0.1:7890", "localhost,127.0.0.1,::1", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"])

    def test_missing_environment_fails_before_starting_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(["/bin/bash", str(LAUNCHER)], env=launcher_env(PAPERCLIP_DEPLOY_ROOT=tmp), text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")

    def test_directory_masquerading_as_volume_fails_before_node_or_new_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "env").mkdir()
            volume = root / "ordinary-directory"
            volume.mkdir()
            (root / "env/server.env").write_text(f'export PAPERCLIP_STORAGE_VOLUME="{volume}"\n')
            (root / "env/server.env").chmod(0o600)
            before = sorted(str(item.relative_to(root)) for item in root.rglob("*"))
            result = subprocess.run(["/bin/bash", str(LAUNCHER)], env=launcher_env(PAPERCLIP_DEPLOY_ROOT=str(root)), text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("external storage volume is not mounted", result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(before, sorted(str(item.relative_to(root)) for item in root.rglob("*")))

    # 1.1.6：私密 env 文件权限过宽、为符号链接时，启动模板在 source 前拒绝，不执行其中任何内容。
    def test_env_file_wider_than_0600_or_symlink_is_refused_before_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "env").mkdir()
            marker = root / "sourced"
            env_file = root / "env/server.env"
            env_file.write_text(f'touch "{marker}"\n')
            for mode in (0o644, 0o640, 0o604, 0o660):
                env_file.chmod(mode)
                with self.subTest(mode=oct(mode)):
                    result = subprocess.run(["/bin/bash", str(LAUNCHER)], env=launcher_env(PAPERCLIP_DEPLOY_ROOT=str(root)), text=True, capture_output=True)
                    self.assertEqual(result.returncode, 78)
                    self.assertIn("must not be wider than 0600", result.stderr)
                    self.assertFalse(marker.exists())
            real = root / "real.env"
            real.write_text(f'touch "{marker}"\n')
            real.chmod(0o600)
            env_file.unlink()
            env_file.symlink_to(real)
            result = subprocess.run(["/bin/bash", str(LAUNCHER)], env=launcher_env(PAPERCLIP_DEPLOY_ROOT=str(root)), text=True, capture_output=True)
            self.assertEqual(result.returncode, 78)
            self.assertIn("must be a regular file", result.stderr)
            self.assertFalse(marker.exists())

    def check_guard(self, deploy_root, volume, uuid="", mounted=True, info=None):
        if info is None:
            info = {"MountPoint": str(volume), "GlobalPermissionsEnabled": True}
        with patch.object(sys, "argv", ["storage-guard", str(deploy_root), str(volume), uuid]), patch("os.path.ismount", return_value=mounted), patch("subprocess.check_output", return_value=plistlib.dumps(info)) as diskutil:
            exec(compile(STORAGE_GUARD, str(LAUNCHER), "exec"), {})
            return diskutil

    def test_mounted_volume_accepts_compatibility_symlink_and_matching_uuid(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            volume = base / "external volume"
            deploy_root = volume / "LeoPhoneAgent/paperclip"
            deploy_root.mkdir(parents=True)
            compatibility = base / "compatibility-root"
            compatibility.symlink_to(deploy_root, target_is_directory=True)
            diskutil = self.check_guard(compatibility, volume, "ABCD-1234", info={"Mounted": True, "MountPoint": str(volume), "VolumeUUID": "abcd-1234", "GlobalPermissionsEnabled": True})
            diskutil.assert_called_once_with(["/usr/sbin/diskutil", "info", "-plist", str(volume.resolve())], stderr=subprocess.PIPE)
            # Mac mini diskutil confirms MountPoint/VolumeUUID but omits Mounted.
            self.check_guard(compatibility, volume, "ABCD-1234", info={"MountPoint": str(volume), "VolumeUUID": "abcd-1234", "GlobalPermissionsEnabled": True})

    def test_off_volume_root_and_symlink_escape_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            volume = base / "external"
            volume.mkdir()
            # A shared string prefix is insufficient: external-other is off-volume.
            outside = base / "external-other"
            outside.mkdir()
            escape = volume / "escape"
            escape.symlink_to(outside, target_is_directory=True)
            for root in (outside, escape):
                with self.subTest(root=root), self.assertRaisesRegex(SystemExit, "deployment root resolves outside"):
                    self.check_guard(root, volume)

    def test_wrong_uuid_unmounted_diskutil_and_missing_volume_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            volume = Path(tmp) / "external"
            deploy_root = volume / "paperclip"
            deploy_root.mkdir(parents=True)
            for info, message in [
                ({"Mounted": True, "MountPoint": str(volume), "VolumeUUID": "other-uuid", "GlobalPermissionsEnabled": True}, "UUID does not match"),
                ({"Mounted": False, "MountPoint": str(volume), "VolumeUUID": "expected"}, "does not confirm"),
                ({"Mounted": True, "MountPoint": str(volume.parent), "VolumeUUID": "expected"}, "does not confirm"),
            ]:
                with self.subTest(info=info), self.assertRaisesRegex(SystemExit, message):
                    self.check_guard(deploy_root, volume, "expected", info=info)
            with self.assertRaisesRegex(SystemExit, "must name an absolute mounted volume"):
                self.check_guard(deploy_root, "", "expected")
            with self.assertRaisesRegex(SystemExit, "not mounted"):
                self.check_guard(deploy_root, volume / "missing")

    def test_disabled_and_unknown_ownership_fail_even_without_uuid(self):
        with tempfile.TemporaryDirectory() as tmp:
            volume = Path(tmp)
            for ownership in (False, None, "true", 1):
                info = {"MountPoint": str(volume)}
                if ownership is not None:
                    info["GlobalPermissionsEnabled"] = ownership
                with self.subTest(ownership=ownership), self.assertRaisesRegex(SystemExit, "ownership must be enabled"):
                    self.check_guard(volume, volume, info=info)
            self.check_guard(volume, volume, info={"MountPoint": str(volume), "GlobalPermissionsEnabled": True})

    def test_uuid_query_failure_is_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            volume = Path(tmp)
            with patch.object(sys, "argv", ["storage-guard", str(volume), str(volume), "expected"]), patch("os.path.ismount", return_value=True), patch("subprocess.check_output", side_effect=subprocess.CalledProcessError(1, "diskutil")), self.assertRaisesRegex(SystemExit, "cannot verify"):
                exec(compile(STORAGE_GUARD, str(LAUNCHER), "exec"), {})

if __name__ == "__main__": unittest.main()
