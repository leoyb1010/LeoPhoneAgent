#!/usr/bin/env python3
"""Portable iOS sync security checks (runtime helpers + exact-source syntax/contract).

Usage: python3 scripts/SyncBoundaryTests.py [--swiftc /path/to/swiftc]
The Apple app/CloudKit/Keychain/Xcode build remains a separate required gate.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / 'src/ios/Agent/Sync/V2'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--swiftc', default=shutil.which('swiftc'))
args, rest = parser.parse_known_args()
if not args.swiftc:
    parser.error('swiftc is required; do not silently skip security runtime tests')


class SyncBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='sync-boundary-')
        cls.work = Path(cls.temp.name)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def compile_run(self, files, name):
        binary = self.work / name
        subprocess.run([args.swiftc, '-module-cache-path', str(self.work / 'cache'),
                        '-parse-as-library', *map(str, files), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)

    def test_paths_archives_memory_and_failed_atomic_replacement(self):
        self.compile_run([SYNC / 'SyncFileSafety.swift', SYNC / 'SafeSkillArchive.swift',
                          ROOT / 'scripts/SyncSafetySmoke.swift'], 'safety')

    def test_upload_policy_and_awaited_durable_callback_contract(self):
        # Extract the exact outbound value type so this inbound-only test does
        # not require SQLite dev libraries. No persistence behavior is stubbed.
        ticket = (SYNC / 'SyncDeliveryLedger.swift').read_text().split('struct SyncDeliveryTicket', 1)[1].split('\n}', 1)[0]
        declaration = self.work / 'Ticket.swift'
        declaration.write_text('import Foundation\nstruct SyncDeliveryTicket' + ticket + '\n}\n')
        self.compile_run([declaration, SYNC / 'PortableRecord.swift', SYNC / 'UploadPolicy.swift',
                          SYNC / 'SyncCoreHydrators.swift', ROOT / 'scripts/SyncInboundHydratorsSmoke.swift'], 'inbound')

    def test_all_changed_domain_sources_parse(self):
        names = ['Agent/Chat/ChatStore.swift', 'Agent/Session/SkillStore.swift', 'Agent/Session/MCPStore.swift',
                 'Agent/Session/SoulStore.swift', 'Agent/Artifacts/ArtifactRepository.swift', 'Shared/EnvVarStore.swift', 'Providers/ProviderConfigDB.swift',
                 'Providers/ProviderConfigStore.swift', 'Agent/Sync/CloudSyncEngine.swift',
                 'Agent/Sync/V2/ChatStoreSyncHydrators.swift', 'Agent/Sync/V2/SyncCore.swift',
                 'Agent/Sync/V2/TailnetSyncTransport.swift', 'Agent/Sync/V2/SessionProvenanceStore.swift']
        subprocess.run([args.swiftc, '-frontend', '-enable-bare-slash-regex', '-parse',
                        *[str(ROOT / 'src/ios' / name) for name in names]], check=True)

    def test_send_policy_precedes_deletes_and_frozen_records(self):
        source = (SYNC / 'SyncCore.swift').read_text()
        loop = source[source.index('for ticket in tickets where'):source.index('guard !snapshots.isEmpty')]
        self.assertLess(loop.index('UploadPolicy.allowsRecordType'), loop.index('ticket.operation == "delete"'))
        self.assertLess(loop.index('UploadPolicy.allowsRecordType'), loop.index('frozenRecord'))
        frozen = source[source.index('private func frozenRecord'):source.index('private func', source.index('private func frozenRecord') + 1)]
        self.assertNotIn('transports.count', frozen)
        self.assertIn('freezeSyncDelivery', frozen)
        self.assertIn('excludingTypes:', (ROOT / 'src/ios/Agent/Chat/ChatStore.swift').read_text())

    def test_failed_domain_sinks_cannot_report_success(self):
        source = (SYNC / 'ChatStoreSyncHydrators.swift').read_text()
        self.assertNotIn('try? await ArtifactRepository', source[source.index('private static func mergeArtifact'):source.index('private static func buildArtifactVersion')])
        self.assertIn('try await ChatStore.shared.mergeRemoteMessage', source)
        self.assertIn('try await db.upsertInstanceFromInbound', source)
        self.assertIn('try EnvVarStore.shared.applyRemoteItem', source)
        self.assertIn('try MCPStore.shared.applyRemoteServerItem', source)
        self.assertIn('try SoulStore.applyRemoteContent', source)
        self.assertIn('datedDeletionApplier:', source)
        self.assertIn('deleteSessionFile(id:', source)
        self.assertNotIn('if fm.fileExists(atPath: destURL.path) { try? fm.removeItem', source)
        skill = (ROOT / 'src/ios/Agent/Session/SkillStore.swift').read_text()
        inbound = skill[skill.index('func importSkillFromSyncWithAsset('):skill.index('/// Best-effort removal of a fakefs')]
        self.assertLess(inbound.index('Self.readZipEntries'), inbound.index('transaction.apply'))
        self.assertIn('commitSkillMetadataFromSync', inbound)
        self.assertIn('SkillSyncTreeTransaction', inbound)
        self.assertIn('if !isSkillStable(skillId) { throw', inbound)
        self.assertNotIn('try?', inbound)


if __name__ == '__main__':
    unittest.main(argv=[__file__] + rest)
