#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/android-product-audit-results"
mkdir -p "$out"
cd "$root/src/android"

# Only Google-provided disposable emulator state is changed. No APK is released.
# The fixture runner intentionally avoids MinisApp, sandbox startup and accounts.
status=0
case "${AUDIT_FLAVOR:-}" in
  Standard|Power) flavors=("$AUDIT_FLAVOR");;
  *) echo "AUDIT_FLAVOR must select Standard or Power on a fresh AVD" >&2; exit 2;;
esac

capture_diagnostics() {
  python3 - "$1" <<'PY'
import pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
commands = {'services.txt': ['shell', 'service', 'list'],
            'boot.txt': ['shell', 'getprop', 'sys.boot_completed'],
            'logcat.txt': ['logcat', '-b', 'all', '-d', '-t', '5000']}
for name, args in commands.items():
    try:
        result = subprocess.run(['adb', *args], capture_output=True, timeout=20)
        (root / name).write_bytes(result.stdout + result.stderr)
    except subprocess.TimeoutExpired:
        (root / name).write_text('Diagnostic command timed out\n')
PY
}

check_device() {
  python3 - <<'PY'
import subprocess
def read(*args):
    return subprocess.check_output(['adb', 'shell', *args], text=True, timeout=20).strip()
assert read('getprop', 'sys.boot_completed') == '1', 'Android boot is incomplete'
for service in ('package', 'activity'):
    value = read('service', 'check', service)
    assert value.endswith(': found'), f'Android {service} service unavailable: {value}'
PY
}

audit_adb() {
  python3 - "$@" <<'PY'
import subprocess, sys
try:
    result = subprocess.run(['adb', *sys.argv[1:]], timeout=30)
    sys.exit(result.returncode)
except subprocess.TimeoutExpired:
    print('Android configuration command timed out; not continuing against unknown device state.', file=sys.stderr)
    sys.exit(124)
PY
}

case "${AUDIT_PROFILE:-}" in
  phone-light-normal|phone-dark-reduced-large|tablet-light-reduced|tablet-dark-normal-large) profiles=("$AUDIT_PROFILE");;
  *) echo "AUDIT_PROFILE must select one of the four documented fresh-AVD profiles" >&2; exit 2;;
esac
check_device || { capture_diagnostics "$out/${AUDIT_PROFILE:-all}/device-unhealthy"; exit 1; }
for profile in "${profiles[@]}"; do
  if [[ "$profile" == phone-* ]]; then size=1080x1728; else size=1768x2208; fi
  audit_adb shell wm size "$size"
  audit_adb shell wm density 420
  if [[ "$profile" == *-large ]]; then font=2.0; else font=1.0; fi
  if [[ "$profile" == *-reduced* ]]; then motion=0; else motion=1; fi
  if [[ "$profile" == *-dark-* ]]; then dark=true; else dark=false; fi
  audit_adb shell settings put system font_scale "$font"
  audit_adb shell settings put global window_animation_scale "$motion"
  audit_adb shell settings put global transition_animation_scale "$motion"
  audit_adb shell settings put global animator_duration_scale "$motion"
  mkdir -p "$out/$profile"
  python3 - "$out/$profile/device-state.json" "$size" "$font" "$motion" <<'PY'
import json, re, subprocess, sys
def read(*args):
    return subprocess.check_output(['adb', 'shell', *args], text=True, timeout=20).strip()
size = read('wm', 'size')
density = read('wm', 'density')
observed = {'wm_size': size, 'wm_density': density,
            'font_scale': read('settings', 'get', 'system', 'font_scale'),
            **{key: read('settings', 'get', 'global', key) for key in
               ('window_animation_scale', 'transition_animation_scale', 'animator_duration_scale')}}
with open(sys.argv[1], 'w') as f: json.dump(observed, f, indent=2)
assert re.findall(r'(?:Physical|Override) size:\s*(\d+x\d+)', size)[-1] == sys.argv[2], observed
assert re.findall(r'(?:Physical|Override) density:\s*(\d+)', density)[-1] == '420', observed
assert float(observed['font_scale']) == float(sys.argv[3]), observed
assert all(float(observed[k]) == float(sys.argv[4]) for k in observed if k.endswith('animation_scale') or k == 'animator_duration_scale'), observed
PY
  for flavor in "${flavors[@]}"; do
    name=$(printf '%s' "$flavor" | tr '[:upper:]' '[:lower:]')
    dest="$out/$profile/$name"
    mkdir -p "$dest"
    # Do not let an earlier profile's XML satisfy this profile's acceptance.
    if [[ -d app/build/outputs/androidTest-results ]]; then
      mv app/build/outputs/androidTest-results "$dest/prior-results"
    fi
    if [[ -d app/build/outputs/connected_android_test_additional_output ]]; then
      mv app/build/outputs/connected_android_test_additional_output "$dest/prior-additional-output"
    fi
    check_device || { capture_diagnostics "$dest/device-unhealthy"; exit 1; }
    package=com.leoyuan.leophoneagent
    [[ "$flavor" != Power ]] || package+=.power
    set +e
    python3 "$root/scripts/android-product-audit/run_timed.py" --seconds 900 --log "$dest/gradle.log" -- \
      ./gradlew --no-daemon --max-workers=1 -Dorg.gradle.jvmargs=-Xmx1536m ":app:connected${flavor}DebugAndroidTest" \
      -Pleophone.auditUiFixture=true \
      -Pkotlin.compiler.execution.strategy=in-process \
      -Pandroid.testInstrumentationRunnerArguments.class=com.leoyuan.leophoneagent.ui.chat.ModelPickerProductAuditTest \
      -Pandroid.testInstrumentationRunnerArguments.timeout_msec=60000 \
      "-Pandroid.testInstrumentationRunnerArguments.additionalTestOutputDir=/sdcard/Android/media/$package/additional_test_output" \
      "-Pandroid.testInstrumentationRunnerArguments.auditProfile=$profile" \
      "-Pandroid.testInstrumentationRunnerArguments.auditDark=$dark"
    result=$?
    set -e
    if [[ "$result" != 0 ]]; then
      # A host timeout can precede AGP's final collection/uninstall. Keep any
      # current screenshots as diagnostics only, never as acceptance evidence.
      python3 - "$dest" "$package" <<'PY_DIAGNOSTIC'
import pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1]) / 'partial-device-output'
root.mkdir(parents=True, exist_ok=True)
try:
    result = subprocess.run(['adb', 'pull',
        f'/sdcard/Android/media/{sys.argv[2]}/additional_test_output', str(root)],
        capture_output=True, timeout=20)
    (root / 'pull.log').write_bytes(result.stdout + result.stderr)
except subprocess.TimeoutExpired:
    (root / 'pull.log').write_text('Diagnostic screenshot pull timed out\n')
PY_DIAGNOSTIC
    fi
    if [[ -d app/build/outputs/connected_android_test_additional_output ]]; then
      cp -R app/build/outputs/connected_android_test_additional_output "$dest/screenshots"
    fi
    if [[ -d app/build/outputs/androidTest-results ]]; then
      cp -R app/build/outputs/androidTest-results "$dest/junit"
    fi
    python3 - "$dest" "$profile" <<'PY' || status=1
import pathlib, sys, xml.etree.ElementTree as ET
root = pathlib.Path(sys.argv[1])
cases = []
for source in (root / 'junit').rglob('*.xml'):
    tree = ET.parse(source)
    cases += [c for c in tree.iter('testcase') if c.get('classname', '').endswith('ModelPickerProductAuditTest')]
expected_cases = {'actualActiveModelAndIndependentGroupPreview',
    'searchShowsEveryMatchAndClearRestoresCollapsedState',
    'emptySearchDismissAndReopenHaveRecoverableState',
    'longGroupNamesAndSystemFontScaleRemainInspectable',
    'immediateRepositoryLoadPreservesEmptyAndExistingConfiguration',
    'expandCollapseControlsAreNamedAndUsable'}
assert len(cases) == 6 and {c.get('name') for c in cases} == expected_cases, f'Expected exact 6 fresh Android cases, found {[c.get("name") for c in cases]}'
assert all(not any(c.find(tag) is not None for tag in ('failure', 'error', 'skipped')) for c in cases), 'UI case failed or was skipped'
images = [p for p in (root / 'screenshots').rglob('*.png') if sys.argv[2] in p.parts]
expected_images = {'01-active-second-model.png', '02-group-transition.png',
    '03-search-all-provider-matches.png', '04-clear-restores-provider-summary.png',
    '05-empty-search.png', '06-reopened-selection-preserved.png', '07-large-font-long-group.png', '08-named-provider-control.png'}
assert len(images) == 8 and {p.name for p in images} == expected_images, f'Expected exact 8 Android screenshots, found {[p.name for p in images]}'
print('6 fresh Android cases and 8 Android screenshots verified')
PY
    printf '{"source":"%s","profile":"%s","flavor":"%s","font_scale":%s,"motion_scale":%s,"gradle_exit":%s,"scope":"production Compose sheet in isolated Application; not full app or PRoot"}\n' \
      "${GITHUB_SHA:-local}" "$profile" "$flavor" "$font" "$motion" "$result" > "$dest/provenance.json"
    [[ "$result" == 0 ]] || status=1
    if [[ "$result" != 0 ]]; then capture_diagnostics "$dest/diagnostics"; fi
    check_device || { capture_diagnostics "$dest/device-unhealthy"; exit 1; }
    if ! grep -R -q 'classname="com.leoyuan.leophoneagent.ui.chat.ModelPickerProductAuditTest"' "$dest/junit" 2>/dev/null; then
      echo 'No complete fresh JUnit result collected; partial execution logs are diagnostic only. Stopping the remaining profiles.'
      exit 1
    fi
  done
done
exit "$status"
