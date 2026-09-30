#!/usr/bin/env python3
"""Compile/run the production Foundation inbox, plus CK integration source checks.

Usage: python3 scripts/CloudKitInboundDurabilityTests.py [--swiftc /path/to/swiftc]
This deliberately does not claim to typecheck CloudKit or run an Apple device.
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
args, remaining = parser.parse_known_args()
if not args.swiftc:
    parser.error('swiftc is required; these runtime checks must not silently skip')


class CloudKitInboundDurabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='cloudkit-inbox-test-')
        cls.work = Path(cls.tmp.name)
        cls.transport = (SYNC / 'ICloudSharedZoneTransport.swift').read_text()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_production_journal_runtime(self):
        binary = self.work / 'inbox-smoke'
        subprocess.run([args.swiftc, '-module-cache-path', str(self.work / 'module-cache'),
                        str(SYNC / 'PortableRecord.swift'), str(SYNC / 'CloudKitInboundJournal.swift'),
                        str(ROOT / 'scripts/CloudKitInboundDurabilitySmoke.swift'), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)

    def test_transport_syntax_without_claiming_sdk_typecheck(self):
        subprocess.run([args.swiftc, '-frontend', '-parse',
                        str(SYNC / 'ICloudSharedZoneTransport.swift')], check=True)

    def test_query_checkpoint_follows_durable_staging(self):
        text = self.transport
        branch = text[text.index('case .success(let rows):'):text.index('case .failure(let error):', text.index('case .success(let rows):'))]
        self.assertLess(branch.index('try stageInbound('), branch.index('UserDefaults.standard.set(now.timeIntervalSince1970'))
        self.assertIn('blockInboundCheckpoint(error)', branch)
        self.assertNotIn('h(SyncInboundBatch', text, 'observer must not receive unmanaged CKAsset URLs')

    def test_failed_staging_and_obsolete_engines_cannot_checkpoint(self):
        text = self.transport
        persist = text[text.index('private func persistState('):text.index('// MARK: - Incremental v1 deletion')]
        self.assertLess(persist.index('guard !inboundCheckpointBlocked'), persist.index('writeDurably'))
        self.assertLess(persist.index('writeDurably'), persist.index('self.stateSerialization = state'))
        self.assertIn('guard self.syncEngine === syncEngine else { return }', text)
        block = text[text.index('private func blockInboundCheckpoint('):text.index('private func stageInbound(')]
        self.assertIn('inboundCheckpointBlocked = true', block)
        self.assertIn('syncEngine = nil', block)
        self.assertIn('issuedInboundJournals[id] ?? inboundJournal', text)
        self.assertIn('guard generation == lifecycleGeneration', text)

    def test_failed_domain_application_releases_without_ack(self):
        text = self.transport
        negative = text[text.index('func deferInbound('):text.index('/// In-memory etag cache.')]
        self.assertIn('release(id)', negative)
        self.assertNotIn('.acknowledge(', negative)
        core = (SYNC / 'SyncCore.swift').read_text()
        self.assertGreaterEqual(core.count('deferInbound(batch)'), 3)
        self.assertIn('inboundDeliveryID: String? = nil', (SYNC / 'PortableRecord.swift').read_text())


if __name__ == '__main__':
    unittest.main(argv=[__file__] + remaining)
