#!/usr/bin/env python3
"""Execute production command preparation against harmless local Git/SSH fixtures.
No remote hosts, credentials, or user repositories are used.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--swiftc', default=shutil.which('swiftc'))
args, rest = parser.parse_known_args()
if not args.swiftc:
    parser.error('swiftc is required')


class CoreExecutionSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='core-execution-')
        cls.root = Path(cls.tmp.name)
        main = cls.root / 'main.swift'
        main.write_text('''import Foundation
if CommandLine.arguments[1] == "git" {
    print(SmartShellApproval.preparedCommand(CommandLine.arguments[2]) ?? "ASK")
} else {
    print(RemoteSSHTrust.relayCommand(host: "test.example", port: 2222, username: "test-user", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJg7MhLhe4dZCFklpKuTkicrf/c98q5q7wT/+FkAoPB0", command: "printf '%s' fixture")!)
}
''')
        cls.binary = cls.root / 'prepare'
        subprocess.run([args.swiftc, '-module-cache-path', str(cls.root / 'cache'),
                        str(ROOT / 'src/ios/Shared/CommandRisk.swift'),
                        str(ROOT / 'src/ios/Agent/Session/RemoteSSHTrust.swift'),
                        str(main), '-o', str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_git_inspection_cannot_execute_configured_fsmonitor(self):
        repo = self.root / 'git-fixture'
        repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        marker = repo / 'hook-ran'
        hook = self.root / 'fsmonitor'
        hook.write_text('#!/bin/sh\nprintf ran > ' + repr(str(marker)) + '\nprintf "clock\\n"\n')
        hook.chmod(0o700)
        subprocess.run(['git', '-C', str(repo), 'config', 'core.fsmonitor', str(hook)], check=True)
        subprocess.run(['git', '-C', str(repo), 'status', '--short'], check=True, capture_output=True)
        self.assertTrue(marker.exists(), 'baseline must demonstrate the configured execution route')
        marker.unlink()
        prepared = subprocess.check_output([str(self.binary), 'git', 'git status --short'], text=True).strip()
        self.assertEqual(prepared, 'ASK', 'worktree status must require normal approval')
        prepared = subprocess.check_output([str(self.binary), 'git', 'git rev-parse --show-toplevel'], text=True).strip()
        self.assertNotEqual(prepared, 'ASK', 'metadata-only inspection remains available')
        subprocess.run(['sh', '-c', prepared], cwd=repo, check=True, capture_output=True)
        self.assertFalse(marker.exists(), 'smart-approved execution must disable the hook')

    def test_git_clean_filters_cannot_run_through_smart_approval(self):
        repo = self.root / 'filter-fixture'
        repo.mkdir()
        def git(*arguments):
            return subprocess.run(['git', '-C', str(repo), *arguments], check=True,
                                  capture_output=True, text=True)
        git('init', '-q')
        git('config', 'user.name', 'Local regression fixture')
        git('config', 'user.email', 'fixture@example.invalid')
        (repo / '.gitattributes').write_text('tracked filter=auditclean\n')
        (repo / 'tracked').write_text('base\n')
        git('add', '.')
        git('commit', '-qm', 'fixture')
        marker = self.root / 'clean-filter-ran'
        hook = self.root / 'clean-filter'
        hook.write_text('#!/bin/sh\nprintf ran >> ' + repr(str(marker)) + '\ncat\n')
        hook.chmod(0o700)
        git('config', 'filter.auditclean.clean', str(hook))
        git('config', 'filter.auditclean.required', 'true')
        # Same-size changes exercise Git's content comparison/filter path.
        (repo / 'tracked').write_text('next\n')
        for command in ('git status --short', 'git ls-files --modified'):
            with self.subTest(command=command):
                # Exact former execution prefix is the vulnerable control.
                vulnerable = 'GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false -c core.untrackedCache=false ' + command[4:]
                subprocess.run(['sh', '-c', vulnerable], cwd=repo, check=True, capture_output=True)
                self.assertTrue(marker.exists(), 'control must execute the configured clean filter')
                marker.unlink()
                prepared = subprocess.check_output([str(self.binary), 'git', command], text=True).strip()
                self.assertEqual(prepared, 'ASK', 'filter-capable inspection must require approval')
                self.assertFalse(marker.exists())
        for command in ('git rev-parse HEAD', 'git rev-parse --show-toplevel', 'git rev-parse --is-inside-work-tree'):
            prepared = subprocess.check_output([str(self.binary), 'git', command], text=True).strip()
            self.assertNotEqual(prepared, 'ASK')
            subprocess.run(['sh', '-c', prepared], cwd=repo, check=True, capture_output=True)
            self.assertFalse(marker.exists(), 'metadata-only control must not invoke the filter')

    def test_gateway_uses_pin_and_cleans_temporary_known_hosts(self):
        bindir = self.root / 'bin'
        bindir.mkdir()
        fixture = bindir / 'ssh'
        fixture.write_text('''#!/usr/bin/env python3
import json, pathlib, sys
options = dict(v.split("=", 1) for v in sys.argv[1:] if "=" in v)
p = pathlib.Path(options['UserKnownHostsFile'])
print(json.dumps({'argv':sys.argv[1:], 'knownHosts':p.read_text(), 'path':str(p)}))
''')
        fixture.chmod(0o700)
        prepared = subprocess.check_output([str(self.binary), 'ssh'], text=True).strip()
        result = subprocess.check_output(['sh', '-c', prepared], text=True,
                    env={**os.environ, 'PATH': str(bindir) + os.pathsep + os.environ['PATH']})
        value = json.loads(result)
        self.assertIn('StrictHostKeyChecking=yes', value['argv'])
        self.assertIn('GlobalKnownHostsFile=/dev/null', value['argv'])
        self.assertEqual(value['argv'][:2], ['-F', '/dev/null'])
        self.assertIn('leo-pinned-target ssh-ed25519 ', value['knownHosts'])
        self.assertEqual(value['argv'][-1], "printf '%s' fixture")
        self.assertFalse(Path(value['path']).exists(), 'temporary public-key file must be removed')


if __name__ == '__main__':
    unittest.main(argv=[__file__] + rest)
