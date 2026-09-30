#!/usr/bin/env python3
"""Execute actual SkillStore import/SQLite methods and tree transaction on real files.

Only model/UI/stability adapters are replaced. The production ZIP parser,
path checks, both root swaps, journal recovery, SQL upsert/savepoint/commit marker,
fakefs SQLite metadata methods, and import orchestration are compiled unchanged. Crashes are child-process exits,
not caught exceptions. Requires Swift and SQLite3 (native on macOS).
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / 'src/ios/Agent/Sync/V2'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--swiftc', default=shutil.which('swiftc'))
parser.add_argument('--sqlite-module')
args = parser.parse_args()
if not args.swiftc:
    parser.error('swiftc is required')


def method(source, name):
    start = source.index('func ' + name + '(')
    start = source.rfind('\n', 0, start) + 1
    return source[start:source.index('\n    }', start) + 6]


support = r'''
import Foundation
import SQLite3
#if os(Linux)
import Glibc
#else
import Darwin
#endif
struct AppLogger { let category: String; func warning(_ message: String) {} }
actor ChatStore {
 static let shared = ChatStore()
 func markDirty(recordType: String, recordId: String, operation: String) {}
}
enum SkillImportSource { case file; var dbValue: String { "file" } }
struct Skill { let id: String; var name: String; var description: String; var version: String
 var importSource: SkillImportSource; var isEnabled: Bool; var installedAt: Date
 var updatedAt: Date; var body: String; var useCount: Double = 0 }
final class SkillStore {
 let fm = FileManager.default
 let skillsDir: URL, rootfsSkillsDir: URL
 let rootfsPath: URL
 var fakefsMetaDBPath: String { rootfsPath.appendingPathComponent("meta.db").path }
 static let SQLITE_TRANSIENT_PTR = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
 var db: OpaquePointer?
 var skills: [Skill] = []
 static let SQLITE_TRANSIENT_DB = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
 init(_ root: URL) throws {
  skillsDir = root.appendingPathComponent("library"); rootfsSkillsDir = root.appendingPathComponent("rootfs")
  rootfsPath = root
  try fm.createDirectory(at: root, withIntermediateDirectories: true)
  precondition(sqlite3_open(root.appendingPathComponent("metadata.sqlite").path, &db) == SQLITE_OK)
  createTables()
  var fake: OpaquePointer?
  precondition(sqlite3_open(fakefsMetaDBPath, &fake) == SQLITE_OK)
  defer { sqlite3_close(fake) }
  precondition(sqlite3_exec(fake, "CREATE TABLE IF NOT EXISTS stats(inode INTEGER PRIMARY KEY, stat BLOB); CREATE TABLE IF NOT EXISTS paths(path BLOB PRIMARY KEY, inode INTEGER)", nil, nil, nil) == SQLITE_OK)
 }
 deinit { sqlite3_close(db) }
 static func parse(skillMD: String) -> (name:String, description:String, version:String, body:String) {
  ("name", "description", "1", skillMD)
 }
 static func readZipEntries(data: Data) throws -> [SafeSkillArchive.Entry] { try SafeSkillArchive.read(data) }
 func isSkillStable(_ id: String) -> Bool { true }
 func removeFakefsPathIfPresent(_ path: String) { removeFakefsPath(path) }
 func seedGuest(_ path: String) {
  let guest = "/var/minis/skills/skill/" + path
  ensureParentDirsInMetaDB(for: guest)
  ensureFakefsMetadata(for: guest, isDirectory: false)
 }
 func guestType(_ path: String) -> UInt32? {
  var fake: OpaquePointer?; precondition(sqlite3_open(fakefsMetaDBPath, &fake) == SQLITE_OK)
  defer { sqlite3_close(fake) }
  var statement: OpaquePointer?; defer { sqlite3_finalize(statement) }
  precondition(sqlite3_prepare_v2(fake, "SELECT stat FROM stats JOIN paths USING(inode) WHERE path = ?", -1, &statement, nil) == SQLITE_OK)
  bindPathBlob(statement!, index: 1, path: "/var/minis/skills/skill/" + path)
  guard sqlite3_step(statement) == SQLITE_ROW, let bytes = sqlite3_column_blob(statement, 0) else { return nil }
  let data = Data(bytes:bytes, count:Int(sqlite3_column_bytes(statement, 0)))
  return (UInt32(data[0]) | UInt32(data[1]) << 8 | UInt32(data[2]) << 16 | UInt32(data[3]) << 24) & 0o170000
 }
 func sql(_ text: String) { precondition(sqlite3_exec(db, text, nil, nil, nil) == SQLITE_OK, String(cString: sqlite3_errmsg(db))) }
 func timestamp() -> Double {
  var statement: OpaquePointer?; defer { sqlite3_finalize(statement) }
  precondition(sqlite3_prepare_v2(db, "SELECT updated_at FROM skills WHERE id = 'skill'", -1, &statement, nil) == SQLITE_OK)
  return sqlite3_step(statement) == SQLITE_ROW ? sqlite3_column_double(statement, 0) : -1
 }
 func recover() throws {
  try SkillSyncTreeTransaction(roots: [skillsDir, rootfsSkillsDir]).recover(isCommitted: skillSyncCommitted)
 }
 func applyDirect(_ zip: Data, checkpoint: @escaping (String) throws -> Void) throws {
  let transaction = SkillSyncTreeTransaction(roots: [skillsDir, rootfsSkillsDir], checkpoint: checkpoint)
  try transaction.apply(skillID: "skill", content: "new markdown", entries: SafeSkillArchive.read(zip), updatedAt: Date(timeIntervalSince1970: 10),
   isCommitted: skillSyncCommitted, commitMetadata: { token in
    _ = try self.commitSkillMetadataFromSync(skillId:"skill", content:"new markdown", source:.file,
      isEnabled:true, installedAt:Date(timeIntervalSince1970:1), updatedAt:Date(timeIntervalSince1970:10), token:token)
   })
 }
 func applyDomain(_ zip: Data?) throws {
  try importSkillFromSyncWithAsset(skillId:"skill", content:"new markdown", zipData:zip, source:.file,
   isEnabled:true, installedAt:Date(timeIntervalSince1970:1), updatedAt:Date(timeIntervalSince1970:10))
 }
 func seed() {
  precondition(dbInsertSkill(id:"skill", name:"old", description:"old", version:"0", importSource:.file,
    isEnabled:true, installedAt:Date(timeIntervalSince1970:1), updatedAt:Date(timeIntervalSince1970:1)))
 }
'''

source = (ROOT / 'src/ios/Agent/Session/SkillStore.swift').read_text()
names = ['createTables', 'migrateAddUseCount', 'dbInsertSkill', 'collectRelativePaths',
         'skillSyncCommitted', 'commitSkillMetadataFromSync', 'importSkillFromSyncWithAsset',
         'bindPathBlob', 'ensureFakefsMetadata', 'ensureParentDirsInMetaDB', 'deleteSkill', 'dbDeleteSkill']
with tempfile.TemporaryDirectory(prefix='skill-tree-tests-') as temp:
    work = Path(temp)
    generated = work / 'SkillStoreProbe.swift'
    generated.write_text(support + '\n'.join(method(source, name) for name in names) + '\n' +
                         method((ROOT / 'src/ios/iSH/RootfsManager.swift').read_text(), 'removeFakefsPath') + '\n}\n')
    for name, entry in [('to-dir', 'foo/bar.txt'), ('to-file', 'foo'), ('control', 'foo')]:
        with zipfile.ZipFile(work / (name + '.zip'), 'w', compression=zipfile.ZIP_STORED) as archive:
            archive.writestr('SKILL.md', '# Skill')
            archive.writestr(entry, 'new bytes')
    binary = work / 'skill-tests'
    command = [args.swiftc, '-module-cache-path', str(work / 'modules'), '-parse-as-library',
               '-swift-version', '6', '-strict-concurrency=complete']
    if args.sqlite_module:
        command += ['-I', args.sqlite_module, '-L', args.sqlite_module]
    command += [str(SYNC / name) for name in ['SyncFileSafety.swift', 'SafeSkillArchive.swift', 'SkillSyncTreeTransaction.swift']]
    command += [str(generated), str(ROOT / 'scripts/SkillTreeTransactionSmoke.swift'), '-o', str(binary)]
    subprocess.run(command, check=True)
    subprocess.run([str(binary), 'ordinary', str(work)], check=True)
    # Every boundary is a real abrupt exit, followed by a fresh process and
    # rebased container path. Covers interrupted staging/swaps/SQLite commit.
    stages = ['staged-0', 'staged-1', 'prepared', 'backed-up-0', 'installed-0',
              'backed-up-1', 'installed-1', 'committed']
    for topology in ['to-dir', 'to-file']:
        for stage in stages:
            home = work / (topology + '-' + stage)
            result = subprocess.run([str(binary), 'crash', str(home), str(work / (topology + '.zip')), topology, stage])
            if result.returncode != 73:
                raise RuntimeError(f'expected crash exit 73, got {result.returncode}: {topology}/{stage}')
            moved = home.with_name(home.name + '-container-moved')
            home.rename(moved)
            subprocess.run([str(binary), 'recover', str(moved), str(work / (topology + '.zip')), topology, stage], check=True)
    for poison in ['unsafe-id', 'wrong-root-count', 'symlink-manifest']:
        home = work / poison
        result = subprocess.run([str(binary), 'crash', str(home), str(work / 'to-dir.zip'), 'to-dir', 'prepared'])
        if result.returncode != 73:
            raise RuntimeError('prepared crash was not reached')
        manifest = next((home / '.library-sync-transactions').glob('*/manifest.json'))
        payload = json.loads(manifest.read_text())
        if poison == 'unsafe-id':
            payload['skillID'] = '../outside'
            manifest.write_text(json.dumps(payload))
        elif poison == 'wrong-root-count':
            payload['hadOriginal'] = [True]
            manifest.write_text(json.dumps(payload))
        else:
            outside = work / 'outside-manifest.json'
            outside.write_text(json.dumps(payload))
            manifest.unlink()
            manifest.symlink_to(outside)
        subprocess.run([str(binary), 'reject-recover', str(home)], check=True)
    # Exact production local deletion must consume a retained committed
    # transaction before removing its destination, and defer on recovery error.
    home = work / 'committed-local-delete'
    result = subprocess.run([str(binary), 'crash', str(home), str(work / 'to-dir.zip'), 'to-dir', 'committed'])
    if result.returncode != 73:
        raise RuntimeError('committed crash was not reached')
    subprocess.run([str(binary), 'delete', str(home)], check=True)
    subprocess.run([str(binary), 'reject-delete', str(work / 'unsafe-id')], check=True)
    print('Skill production imports, failure rollback, SQLite marker, 16 process-crash/rebased restarts, 3 corrupt journals and retained-journal local deletion PASS')
