"""Execute the production session-list SQL against isolated fixture rows."""
import pathlib
import re
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class SessionListOriginTests(unittest.TestCase):
    def test_v2_source_name_and_unknown_legacy_are_loaded(self):
        source = (ROOT / 'src/ios/Agent/Chat/ChatStore.swift').read_text()
        section = source[source.index('func listSessions()'):source.index('/// Ordered, pre-compiled')]
        query = re.search(r'let sql = """(.*?)"""', section, re.S).group(1)
        query = query.replace(r'\(asstMask)', '3').replace(r'\(userMask)', '1')
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.executescript('''
          CREATE TABLE sessions(id TEXT, title TEXT, model_id TEXT, created_at REAL,
            updated_at REAL, category TEXT, source TEXT, last_synced_at REAL,
            remote_origin_device_id TEXT, pinned_at REAL, origin_device_id TEXT,
            last_writer_device_id TEXT);
          CREATE TABLE messages(session_id TEXT, role TEXT, parts_json TEXT, part_flags INT, sort_order INT);
          CREATE TABLE sync_devices(device_id TEXT, device_name TEXT);
          INSERT INTO sync_devices VALUES('ipad', 'Test iPad');
          INSERT INTO sessions(id, updated_at, origin_device_id,last_writer_device_id)
            VALUES ('v2',2,'ipad','iphone'),('legacy',1,NULL,NULL);
        ''')
        rows = db.execute(query).fetchall()
        self.assertEqual(rows[0][0], 'v2')
        self.assertEqual(rows[0][14:17], ('ipad', 'iphone', 'Test iPad'))
        self.assertEqual(rows[1][14:17], (None, None, None))

if __name__ == '__main__':
    unittest.main()
