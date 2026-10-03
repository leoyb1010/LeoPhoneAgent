#!/usr/bin/env python3
"""Build a dependency-isolated iOS project from actual production Swift sources.

No production source is changed. --source-ref reads immutable git blobs; WORKTREE
reads the current checkout. SHA256 provenance is emitted beside each generated app.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
SOURCES = [
    'Providers/LLMTypes.swift', 'Providers/ThinkingTypes.swift',
    'Providers/ThinkingLevelCatalog.swift', 'Providers/ProviderTypes.swift',
    'Providers/ProviderInstance.swift', 'Providers/ModelEntry.swift',
    'Providers/ModelGroup.swift', 'Providers/ModelGroupRouter.swift',
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-ref', default='WORKTREE')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    out = pathlib.Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    production = out / 'Sources' / 'Production'
    production.mkdir(parents=True, exist_ok=True)
    manifest = {'source_ref': args.source_ref, 'sources': [], 'boundary':
                'Real production SwiftUI views and model logic; synthetic local store, credentials, voice/network adapters. Not full-app/iSH/Watch integration.'}
    for relative in SOURCES + OPTIONAL:
        path = 'src/ios/' + relative
        try:
            data = read_source(args.source_ref, path)
        except (FileNotFoundError, subprocess.CalledProcessError):
            if relative in OPTIONAL:
                continue
            raise
        (production / pathlib.Path(relative).name).write_bytes(data)
        manifest['sources'].append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'transformation': 'none'})
    if (production / 'ProviderModelCatalogView.swift').exists():
        (production / 'AuditProviderCatalog.swift').write_text('''import SwiftUI
struct AuditProviderCatalog: View {
    let instanceId: String
    var body: some View {
        ProviderModelCatalogView(instanceId: instanceId, onEdit: { _ in }, onAddCustom: {})
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
    for name in ['AuditApp.swift', 'FixtureStore.swift', 'FixtureAdapters.swift']:
        shutil.copyfile(HERE / name, out / 'Sources' / name)
    (out / 'UnitTests').mkdir(exist_ok=True)
    shutil.copyfile(HERE / 'AuditCodecTests.swift', out / 'UnitTests' / 'AuditCodecTests.swift')
    for test in ['ModelCatalogTests.swift']:
        path = 'src/ios/MinisTests/' + test
        try:
            data = read_source(args.source_ref, path)
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
        (out / 'UnitTests' / test).write_text('@testable import NativeModelAudit\n' + data.decode())
        manifest['sources'].append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'transformation': 'Add testable import NativeModelAudit to target production app module'})
    (out / 'UITests').mkdir(exist_ok=True)
    shutil.copyfile(HERE / 'NativeModelJourneys.swift', out / 'UITests' / 'NativeModelJourneys.swift')
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
    TARGETED_DEVICE_FAMILY: "1"
targets:
  NativeModelAudit:
    type: application
    platform: iOS
    sources: [Sources]
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
