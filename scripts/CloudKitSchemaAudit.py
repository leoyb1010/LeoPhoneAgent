#!/usr/bin/env python3
"""Read-only CloudKit release gate. Never writes a container or reads credentials."""
import argparse
import json
import pathlib
import plistlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
SYNC = ROOT / 'src/ios/Agent/Sync/V2'

def manifest():
    source = (SYNC / 'SyncedTypes.swift').read_text()
    transport = (SYNC / 'ICloudSharedZoneTransport.swift').read_text()
    zones = dict(re.findall(r'static let (\w+ZoneName)\s*=\s*"([^"]+)"', transport))
    mappings = dict(re.findall(r'"(\w+)":\s+(\w+ZoneName)', transport))
    queries = dict(re.findall(r'\("(\w+)", "(createdAt|updatedAt)"\)', transport))
    registered = set(re.findall(r'r\.register\((\w+)\.self\)', source))
    result = {}
    kinds = {'string': 'STRING', 'int': 'INT64', 'date': 'TIMESTAMP'}
    for name, body in re.findall(r'struct (Synced\w+): Syncable \{(.*?)(?=\nstruct |\n// MARK: - Bootstrap|\nenum SyncedTypesBootstrap|\Z)', source, re.S):
        if name not in registered:
            continue
        record_type = re.search(r'recordType: "(\w+)"', body).group(1)
        fields = {}
        for method, key in re.findall(r'F\.(\w+)\("([^"]+)"', body):
            kind = method.removeprefix('optional').lower()
            if kind not in kinds:
                raise ValueError(f'Unsupported field descriptor: {method}')
            fields[key] = {'type': kinds[kind], 'optional': method.startswith('optional')}
        fields['syncSchemaVersion'] = {'type': 'INT64', 'optional': False}
        fields['syncMinimumCompatibleVersion'] = {'type': 'INT64', 'optional': True}
        indexes = {}
        if record_type in queries:
            indexes[queries[record_type]] = ['QUERYABLE', 'SORTABLE']
        if record_type in ('SessionV2', 'MessageV2', 'CompactMarkerV2'):
            indexes['sessionId'] = ['QUERYABLE']
        asset = {'SessionFileV2': 'asset', 'ArtifactVersionV2': 'asset', 'SkillV2': 'bundleAsset'}.get(record_type)
        if asset:
            for key, kind in ((asset, 'ASSET'), (asset + '_size', 'INT64'), (asset + '_mime', 'STRING')):
                fields[key] = {'type': kind, 'optional': True}
        result[record_type] = {'zone': zones[mappings[record_type]], 'version': int(re.search(r'\n\s+version: (\d+)\n', body).group(1)), 'fields': fields, 'indexes': indexes}
    if len(result) != len(registered):
        raise ValueError('Registry coverage incomplete')
    return {'formatVersion': 1, 'container': 'iCloud.com.leoyuan.leophoneagent', 'database': 'PRIVATE', 'types': result}

def audit(expected, observed, environment):
    errors = []
    for key, value in [('container', expected['container']), ('database', 'PRIVATE'), ('environment', environment)]:
        if observed.get(key) != value:
            errors.append(f'{key}: expected {value}, got {observed.get(key, "unknown")}')
    for name, spec in expected['types'].items():
        actual = observed.get('types', {}).get(name)
        if not actual:
            errors.append(f'missing type {name}')
            continue
        for field, definition in spec['fields'].items():
            actual_field = actual.get('fields', {}).get(field)
            if not actual_field or actual_field.get('type') != definition['type']:
                errors.append(f'{name}.{field}: missing or incompatible {definition["type"]}')
        for field, indexes in spec['indexes'].items():
            for index in indexes:
                if index not in actual.get('indexes', {}).get(field, []):
                    errors.append(f'{name}.{field}: missing {index} index')
    return errors

def signed_environment(app, expected_environment, container):
    output = subprocess.run(['codesign', '-d', '--entitlements', ':-', str(app)], capture_output=True, check=True)
    entitlements = plistlib.loads(output.stdout)
    errors = []
    actual = entitlements.get('com.apple.developer.icloud-container-environment')
    if actual != expected_environment:
        errors.append(f'signed environment: expected {expected_environment}, got {actual or "unknown"}')
    if container not in entitlements.get('com.apple.developer.icloud-container-identifiers', []):
        errors.append('signed app missing expected iCloud container')
    if 'CloudKit' not in entitlements.get('com.apple.developer.icloud-services', []):
        errors.append('signed app missing CloudKit service')
    return errors

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write-manifest', type=pathlib.Path)
    parser.add_argument('--observed-schema', type=pathlib.Path, help='Reviewed normalized Console export; see docs/specs/icloud-schema-environment.md')
    parser.add_argument('--environment', choices=['Development', 'Production'])
    parser.add_argument('--app', type=pathlib.Path)
    args = parser.parse_args()
    expected = manifest()
    if args.write_manifest:
        args.write_manifest.write_text(json.dumps(expected, indent=2, ensure_ascii=False) + '\n')
    if args.observed_schema or args.app:
        if not args.environment:
            parser.error('--environment required for verification')
        errors = []
        if args.observed_schema:
            errors += audit(expected, json.loads(args.observed_schema.read_text()), args.environment)
        else:
            errors.append('schema readiness unverified: --observed-schema is required')
        if args.app:
            errors += signed_environment(args.app, args.environment, expected['container'])
        else:
            errors.append('signed environment unverified: --app is required')
        for error in errors:
            print('HOLD:', error)
        if errors:
            return 1
        print('PASS: signed environment and all required schema fields/indexes verified against supplied evidence')
    elif not args.write_manifest:
        print(json.dumps(expected, indent=2))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
