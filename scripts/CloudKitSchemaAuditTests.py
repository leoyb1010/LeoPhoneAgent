import copy
import unittest
from CloudKitSchemaAudit import audit, manifest

class SchemaAuditTests(unittest.TestCase):
    def setUp(self):
        self.expected = manifest()
        self.observed = copy.deepcopy(self.expected)
        self.observed['environment'] = 'Production'

    def test_registry_coverage_and_asset_fields(self):
        self.assertEqual(len(self.expected['types']), 19)
        self.assertEqual(self.expected['types']['SessionFileV2']['fields']['asset']['type'], 'ASSET')
        self.assertNotIn('title', self.expected['types']['SessionV2']['indexes'])

    def test_complete_schema(self):
        self.assertEqual(audit(self.expected, self.observed, 'Production'), [])

    def test_users_only_production_is_not_ready(self):
        self.observed['types'] = {'Users': {}}
        self.assertEqual(len(audit(self.expected, self.observed, 'Production')), 19)

    def test_missing_index_and_wrong_type_are_blocking(self):
        self.observed['types']['MessageV2']['indexes']['sessionId'] = []
        self.observed['types']['SessionV2']['fields']['createdAt']['type'] = 'STRING'
        self.assertEqual(len(audit(self.expected, self.observed, 'Production')), 2)

    def test_environment_mismatch(self):
        self.assertTrue(audit(self.expected, self.observed, 'Development'))

if __name__ == '__main__':
    unittest.main()
