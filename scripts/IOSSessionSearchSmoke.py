#!/usr/bin/env python3
"""Run the production search method against isolated SQLite fixtures."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit_generator', root / 'scripts/native-model-audit/generate.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
method = generator.extract_swift_method((root / 'src/ios/Agent/Chat/ChatStore.swift').read_text(), 'searchSessions')
source = r'''
import Foundation
import SQLite3
let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
struct ChatSession {
 let id: String; let title: String?; let category: String?; let modelId: String
 let createdAt: Date; let updatedAt: Date; let lastMessage: String?
}
struct SearchResult { let session: ChatSession; let matchSnippet: String?; let titleMatched: Bool }
final class SearchHarness {
 var db: OpaquePointer?
 func extractTextFromPartsJSON(_ value: String) -> String? { value }
''' + method + r'''
}
let harness = SearchHarness()
precondition(sqlite3_open(":memory:", &harness.db) == SQLITE_OK)
defer { sqlite3_close(harness.db) }
let sql = #"""
CREATE TABLE sessions (id TEXT, title TEXT, model_id TEXT, created_at REAL, updated_at REAL, category TEXT, parent_session_id TEXT);
CREATE TABLE messages (session_id TEXT, parts_json TEXT, sort_order INT);
INSERT INTO sessions VALUES ('percent', '100% ready', 'm', 0, 0, NULL, NULL), ('number', '1000 ready', 'm', 0, 0, NULL, NULL),
 ('underscore', 'a_b', 'm', 0, 0, NULL, NULL), ('letter', 'axb', 'm', 0, 0, NULL, NULL),
 ('slash', 'a\b', 'm', 0, 0, NULL, NULL), ('message', 'body match', 'm', 0, 0, NULL, NULL),
 ('hiddenchild', '100% sub agent', 'm', 0, 0, NULL, 'percent');
INSERT INTO messages VALUES ('message', 'literal 50% and x_y and a\b and O''Reilly', 1);
"""#
precondition(sqlite3_exec(harness.db, sql, nil, nil, nil) == SQLITE_OK)
func check(_ query: String, _ ids: Set<String>) {
 let actual = Set(harness.searchSessions(query: query).map { $0.session.id })
 if actual != ids { print("FAIL query=\(query) actual=\(actual) expected=\(ids)"); exit(1) }
}
check("100%", ["percent"])
check("a_b", ["underscore"])
check("%", ["percent", "message"])
check("_", ["underscore", "message"])
check(#"a\b"#, ["slash", "message"])
check("O'Reilly", ["message"])
check("%' OR 1=1 --", [])
check("", [])
print("PASS production session search: literal wildcards, backslash, message matches, quotes, empty query, hidden sub agent sessions excluded")
'''
with tempfile.TemporaryDirectory(prefix='leo-session-search-') as folder:
    swift = Path(folder) / 'Search.swift'
    binary = Path(folder) / 'search'
    swift.write_text(source)
    subprocess.run(['xcrun', 'swiftc', str(swift), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
