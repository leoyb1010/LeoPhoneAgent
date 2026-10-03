#!/usr/bin/env python3
"""Build a dependency-isolated iOS project from actual production Swift sources.

Original repository production files are never changed. Generated copies may carry
explicit test-only observation instrumentation recorded with both source and output
SHA256. --source-ref reads immutable git blobs; WORKTREE reads the current checkout.
"""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
SOURCES = [
    'Providers/LLMTypes.swift', 'Providers/ThinkingTypes.swift',
    'Providers/ThinkingLevelCatalog.swift', 'Providers/ProviderTypes.swift',
    'Providers/ProviderInstance.swift', 'Providers/ModelEntry.swift',
    'Providers/ModelGroup.swift', 'Providers/ModelGroupRouter.swift', 'Providers/ProviderConfigDB.swift',
    'Providers/ModelSwitcher.swift', 'Providers/ModelPinStore.swift',
    'Views/Providers/UnifiedModelPicker.swift', 'Views/Providers/SessionModelPicker.swift',
    'Views/Providers/ModelDisplayTraits.swift', 'Views/Providers/ModelGroupsView.swift',
    'Views/Providers/ModelGroupDetailView.swift', 'Views/Providers/GroupSlotPicker.swift',
    'Views/Providers/GroupVoiceModelsView.swift', 'Views/Providers/AgentLoopModelsView.swift',
    'Views/Providers/OnboardingModelSelectionView.swift',
    'Views/Chat/QuickModelSwitchSheet.swift',
]
OPTIONAL = ['Providers/ModelCatalog.swift', 'Views/Providers/ProviderModelCatalogView.swift',
            'Views/Providers/ModelCatalogComponents.swift']


def read_source(ref, path):
    if ref == 'WORKTREE':
        return (ROOT / path).read_bytes()
    return subprocess.check_output(['git', 'show', f'{ref}:{path}'], cwd=ROOT, stderr=subprocess.DEVNULL)


def extract_swift_method(source, name):
    """Copy one complete declaration, balancing Swift strings/comments/braces."""
    match = re.search(r'^    (?:(?:private|fileprivate|static|nonisolated)\s+)*func ' + re.escape(name) + r'(?:[<(])', source, re.M)
    if not match:
        raise ValueError('Production method not found: ' + name)

    def skip_string(index):
        delimiter = '"""' if source.startswith('"""', index) else '"'
        index += len(delimiter)
        while index < len(source):
            if source.startswith(delimiter, index):
                return index + len(delimiter)
            if source[index] == "\\":
                if source.startswith("\\(", index):
                    index = skip_balanced(index + 1, '(', ')')
                else:
                    index += 2
            else:
                index += 1
        raise ValueError('Unterminated Swift string in ' + name)

    def skip_balanced(index, opening, closing):
        depth = 1
        index += 1
        while index < len(source):
            if source.startswith('//', index):
                end = source.find('\n', index)
                index = len(source) if end < 0 else end + 1
            elif source.startswith('/*', index):
                comment_depth = 1
                index += 2
                while comment_depth:
                    if source.startswith('/*', index):
                        comment_depth += 1; index += 2
                    elif source.startswith('*/', index):
                        comment_depth -= 1; index += 2
                    else:
                        index += 1
                    if index >= len(source):
                        raise ValueError('Unterminated Swift comment in ' + name)
            elif source[index] == '"':
                index = skip_string(index)
            else:
                if source[index] == opening: depth += 1
                elif source[index] == closing:
                    depth -= 1
                    if depth == 0: return index + 1
                index += 1
        raise ValueError('Unbalanced production method: ' + name)

    start = match.start()
    while start > 0:
        prior = source.rfind('\n', 0, start - 1) + 1
        if not source[prior:start].strip().startswith('@'): break
        start = prior
    return source[start:skip_balanced(source.index('{', match.end()), '{', '}')]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-ref', default='WORKTREE')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    out = pathlib.Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    # Ref switching must never leave a current-only Swift file in the baseline.
    # Remove only files enumerated by this generator's previous manifest.
    previous_manifest = out / 'source-manifest.json'
    if previous_manifest.exists():
        previous = json.loads(previous_manifest.read_text())
        for row in previous.get('sources', []):
            name = pathlib.Path(row.get('generated_file', row['path'])).name
            for directory in ['Sources/Production', 'UnitTests', 'Resources']:
                candidate = out / directory / name
                if candidate.is_file():
                    candidate.unlink()
    production = out / 'Sources' / 'Production'
    production.mkdir(parents=True, exist_ok=True)
    manifest = {'source_ref': args.source_ref, 'device_families': [1, 2], 'sources': [], 'boundary':
                'Real production SwiftUI views and model logic; synthetic local store, credentials, voice/network adapters. Not full-app/iSH/Watch integration.'}
    manifest['harness_sources'] = [
        {'path': 'scripts/native-model-audit/' + name,
         'sha256': hashlib.sha256((HERE / name).read_bytes()).hexdigest()}
        for name in ['AuditApp.swift', 'FixtureStore.swift', 'FixtureAdapters.swift',
                     'NativeModelJourneys.swift', 'generate.py', 'run.sh']
    ]
    for relative in SOURCES + OPTIONAL:
        path = 'src/ios/' + relative
        try:
            data = read_source(args.source_ref, path)
        except (FileNotFoundError, subprocess.CalledProcessError):
            if relative in OPTIONAL:
                continue
            raise
        transformation = 'none'
        generated = data
        if relative == 'Providers/ModelPinStore.swift':
            # Test-only, non-observable callback trace. Never changes production
            # callbacks or reorder mapping and never enters the product binary.
            source = data.decode().replace('final class ModelPinStore: ObservableObject {',
                'final class ModelPinStore: ObservableObject {\n    static var auditLastMove = "not invoked"')
            method = """    func move(visibleKeys: [String], from source: IndexSet, to destination: Int) {
        ModelSwitcher.movePinned(visibleKeys: visibleKeys, from: source, to: destination)
        keys = ModelSwitcher.pinnedKeys
    }"""
            if 'func move(visibleKeys:' in source:
                if method not in source:
                    raise ValueError('ModelPinStore.move changed; review observation instrumentation')
                traced = method.replace('        ModelSwitcher.movePinned',
                    '        Self.auditLastMove = "from=\\(Array(source)) to=\\(destination) visible=\\(visibleKeys.joined(separator: "|")) before=\\(keys.joined(separator: "|"))"\n'
                    '        ModelSwitcher.movePinned').replace('        keys = ModelSwitcher.pinnedKeys',
                    '        keys = ModelSwitcher.pinnedKeys\n'
                    '        Self.auditLastMove += " after=\\(keys.joined(separator: "|")) stored=\\(ModelSwitcher.pinnedKeys.joined(separator: "|"))"')
                source = source.replace(method, traced)
            generated = source.encode()
            transformation = 'Add audit-only static non-observable onMove invocation trace; keep production mapping/storage/view behavior unchanged. No instrumentation is published in the product.'
        (production / pathlib.Path(relative).name).write_bytes(generated)
        manifest['sources'].append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(),
                                    'generated_sha256': hashlib.sha256(generated).hexdigest(), 'transformation': transformation})
    path = 'src/ios/Providers/ProviderConfigStore.swift'
    data = read_source(args.source_ref, path)
    source = data.decode()
    start = source.index('// MARK: - Persisted Config')
    end = source.index('// MARK: - ProviderConfigStore', start)
    (production / 'ProviderConfig.swift').write_text('import Foundation\n\n' + source[start:end])
    manifest['sources'].append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(),
                                'transformation': 'Extract unchanged ProviderConfig and ProviderConfigTombstone value declarations between persisted-config/store markers; prepend Foundation import. Production singleton store remains replaced by fixture.'})
    template = HERE / 'ProductionProviderPersistence.template.swift'
    if template.exists() and 'func recoverPendingDatabaseSnapshot(' in source:
        names = ['load', 'save', 'reloadFromDisk', 'loadModelArchiveAliases', 'recoverPendingDatabaseSnapshot',
                 'persistLegacyUuidMap', 'setBinding', 'setEntriesHidden', 'replaceEntries',
                 'removeEntry', 'addGroup', 'updateGroup', 'removeGroup', 'reorderGroups', 'repointDefaults',
                 'ensureVoiceTemplateModels', 'commitImportedMetadata', 'addEntry', 'updateEntry',
                 'recordTombstone', 'emitV3MarkDirty', 'dictByIdLastWins']
        methods = '\n\n'.join(extract_swift_method(source, name) for name in names)
        generated = template.read_text().replace('    // INSERT_PRODUCTION_METHODS', methods)
        (production / 'ProductionProviderPersistence.swift').write_text(generated)
        manifest['sources'].append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(),
                                    'generated_file': 'ProductionProviderPersistence.swift',
                                    'methods': names,
                                    'transformation': 'Extract listed unchanged production method declarations into dedicated persistence-test host. Only app startup, voice templates, and external dirty notifications use explicit adapters; real JSON/journal/archive/SQLite bodies execute.'})
    if (production / 'ProviderModelCatalogView.swift').exists():
        (production / 'AuditProviderCatalog.swift').write_text('''import SwiftUI
struct AuditProviderCatalog: View {
    let instanceId: String
    @State private var editingEntry: ModelEntry?
    var body: some View {
        ProviderModelCatalogView(instanceId: instanceId, onEdit: { editingEntry = $0 }, onAddCustom: {})
            .sheet(item: $editingEntry) { ModelEntryDetailSheet(entry: $0) }
    }
}
''')
    else:
        # Provider detail contains sign-in/network actions unrelated to catalog rendering.
        # Copy the production catalog method bodies verbatim into a fixture wrapper.
        # This is a native rendering of these exact methods, not a rewritten mockup.
        path = 'src/ios/Views/Providers/ProviderInstanceDetailView.swift'
        data = read_source(args.source_ref, path)
        source = data.decode()
        start = source.index('    private func modelListSection(')
        end = source.index('    // MARK: - Actions', start)
        methods = source[start:end]
        wrapper = '''import SwiftUI
    struct AuditProviderCatalog: View {
        let instanceId: String
        @ObservedObject private var store = ProviderConfigStore.shared
        @State private var showAddCustomModel = false
        @State private var pendingDeleteModelEntry: ModelEntry?
        @State private var editingModelEntry: ModelEntry?
        var body: some View {
            List {
                if let instance = store.instance(for: instanceId) {
                    Section("Models") { modelListSection(instance) }
                }
            }
            .navigationTitle(store.instance(for: instanceId)?.label ?? "Provider")
            .navigationBarTitleDisplayMode(.inline)
        }
        @ViewBuilder
    '''
        (production / 'AuditProviderCatalog.swift').write_text(wrapper + methods + '\n}\n')
        manifest['sources'].append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(),
                                    'transformation': 'Extract unchanged modelListSection, modelEntryRow and modalityIcons methods into AuditProviderCatalog; omit sign-in/settings/network chrome.'})
    # The entire production editor is dependency-light; only Quick Test's
    # external execution remains an adapter. Keep the struct body unchanged.
    path = 'src/ios/Views/Providers/ProviderInstanceDetailView.swift'
    data = read_source(args.source_ref, path)
    source = data.decode()
    start = source.index('struct ModelEntryDetailSheet: View {')
    end = source.index('// MARK: - Share Sheet', start)
    (production / 'ModelEntryDetailSheet.swift').write_text('import SwiftUI\n\n' + source[start:end])
    manifest['sources'].append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(),
                                'generated_file': 'ModelEntryDetailSheet.swift',
                                'transformation': 'Extract entire unchanged ModelEntryDetailSheet struct before Share Sheet marker; prepend SwiftUI import. Quick Test execution remains an explicit no-network adapter.'})
    resources = out / 'Resources'
    resources.mkdir(exist_ok=True)
    path = 'src/ios/Localizable.xcstrings'
    data = read_source(args.source_ref, path)
    (resources / 'Localizable.xcstrings').write_bytes(data)
    manifest['sources'].append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'transformation': 'none'})
    for name in ['AuditApp.swift', 'FixtureStore.swift', 'FixtureAdapters.swift']:
        shutil.copyfile(HERE / name, out / 'Sources' / name)
    (out / 'UnitTests').mkdir(exist_ok=True)
    shutil.copyfile(HERE / 'AuditCodecTests.swift', out / 'UnitTests' / 'AuditCodecTests.swift')
    for test in ['ModelCatalogTests.swift', 'ProviderConfigDBTests.swift', 'ProductionProviderPersistenceTests.swift']:
        path = 'src/ios/MinisTests/' + test
        try:
            data = read_source(args.source_ref, path)
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
        (out / 'UnitTests' / test).write_text('@testable import NativeModelAudit\n' + data.decode())
        manifest['sources'].append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'transformation': 'Add testable import NativeModelAudit to target production app module'})
    (out / 'UITests').mkdir(exist_ok=True)
    shutil.copyfile(HERE / 'NativeModelJourneys.swift', out / 'UITests' / 'NativeModelJourneys.swift')
    is_baseline = args.source_ref == '3c053a7c9b112667a04cea9b12c7c16a03c5ce39'
    (out / 'UITests' / 'AuditSourceKind.swift').write_text(
        '// Explicit source role: current assertions must never skip due to missing UI.\n'
        'enum AuditSourceKind { static let isBaseline = ' + str(is_baseline).lower() + ' }\n')
    (out / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (out / 'project.yml').write_text('''name: NativeModelAudit
options:
  bundleIdPrefix: org.leophone.audit
  deploymentTarget:
    iOS: "26.0"
settings:
  base:
    SWIFT_VERSION: "5.0"
    CODE_SIGNING_ALLOWED: NO
    GENERATE_INFOPLIST_FILE: YES
    IPHONEOS_DEPLOYMENT_TARGET: "26.0"
    SWIFT_STRICT_CONCURRENCY: minimal
    STRING_CATALOG_GENERATE_SYMBOLS: NO
    SWIFT_EMIT_LOC_STRINGS: NO
    TARGETED_DEVICE_FAMILY: "1,2"
targets:
  NativeModelAudit:
    type: application
    platform: iOS
    sources: [Sources, Resources]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: org.leophone.audit.native-models
        INFOPLIST_KEY_UILaunchScreen_Generation: YES
        INFOPLIST_KEY_UIApplicationSceneManifest_Generation: YES
        INFOPLIST_KEY_CFBundleDisplayName: Native Model Audit
  NativeModelAuditTests:
    type: bundle.unit-test
    platform: iOS
    sources: [UnitTests]
    dependencies:
      - target: NativeModelAudit
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: org.leophone.audit.native-models.unit-tests
        SWIFT_ACTIVE_COMPILATION_CONDITIONS: "$(inherited) NATIVE_MODEL_AUDIT"
        TEST_HOST: "$(BUILT_PRODUCTS_DIR)/NativeModelAudit.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/NativeModelAudit"
        BUNDLE_LOADER: "$(TEST_HOST)"
  NativeModelAuditUITests:
    type: bundle.ui-testing
    platform: iOS
    sources: [UITests]
    dependencies:
      - target: NativeModelAudit
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: org.leophone.audit.native-models.tests
        TEST_TARGET_NAME: NativeModelAudit
schemes:
  NativeModelAudit:
    build:
      targets:
        NativeModelAudit: all
        NativeModelAuditUITests: [test]
        NativeModelAuditTests: [test]
    test:
      targets: [NativeModelAuditTests, NativeModelAuditUITests]
      gatherCoverageData: false
''')
    print(out)


if __name__ == '__main__':
    main()
