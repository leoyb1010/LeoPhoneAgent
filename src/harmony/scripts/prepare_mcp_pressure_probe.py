#!/usr/bin/env python3
"""Prepare an isolated native/ETS MCP pressure diagnostic stage, never the shared app stage."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
APP = HERE.parent / 'app'
STAGE = Path(sys.argv[1]).resolve()
if STAGE == APP.resolve() or APP.resolve() in STAGE.parents or STAGE == Path('/tmp/leo-harmony-app').resolve():
    raise SystemExit('Use an independent diagnostic stage')
cpp = STAGE / 'entry/src/main/cpp'
subprocess.run(['rsync', '-a', '--exclude', 'build', '--exclude', '.cxx', '--exclude', '.git', str(APP / 'entry/src/main/cpp') + '/', str(cpp) + '/'], check=True)
ets = STAGE / 'entry/src/main/ets'
(ets / 'debug').mkdir(exist_ok=True)
files = {
    HERE / 'fixtures/McpPressureProbeAbility.ets': ets / 'debug/McpPressureProbeAbility.ets',
    HERE / 'fixtures/McpPressureProbePage.ets': ets / 'pages/McpPressureProbePage.ets',
    HERE / 'fixtures/WorkspaceCreateProbeAbility.ets': ets / 'debug/WorkspaceCreateProbeAbility.ets',
    HERE / 'fixtures/WorkspaceCreateProbePage.ets': ets / 'pages/WorkspaceCreateProbePage.ets',
}
for relative in ['local/McpStdio.ets', 'local/LinuxRuntime.ets', 'local/AgentText.ets', 'pages/ScreenSessionPage.ets', 'remote/ScreenSessionBridge.ets', 'net/HarnessClient.ets']:
    files[APP / 'entry/src/main/ets' / relative] = ets / relative
for source, destination in files.items():
    shutil.copy2(source, destination)
# Observe the same NAPI module globals. No lifecycle pauses, fault injection or production API changes.
source = cpp / 'linux_napi.cpp'
text = source.read_text()
text = '#include <atomic>\n#include <fcntl.h>\n#include <unistd.h>\nstatic std::atomic_uint probe_zero_writes{0};\n' + text
needle = 'return integer(env, leo_linux_write(pid_arg(env, args[0]), bytes.data(), bytes.size()));'
if text.count(needle) != 1:
    raise SystemExit('Native write implementation changed; inspect the fixture observer before continuing')
text = text.replace(needle, '''const int result = leo_linux_write(pid_arg(env, args[0]), bytes.data(), bytes.size());
    if (result == 0) ++probe_zero_writes;
    return integer(env, result);''')
text = text.replace('static napi_value register_module(napi_env env, napi_value exports) {', '''static napi_value probe_scope_counts(napi_env env, napi_callback_info) {
    unsigned slots = 0, tasks = 0;
    leo_linux_scope_counts(&slots, &tasks);
    napi_value result; napi_create_object(env, &result);
    napi_set_named_property(env, result, "slots", integer(env, static_cast<int>(slots)));
    napi_set_named_property(env, result, "tasks", integer(env, static_cast<int>(tasks)));
    napi_set_named_property(env, result, "zeroWrites", integer(env, static_cast<int>(probe_zero_writes.load())));
    return result;
}
static napi_value register_module(napi_env env, napi_value exports) {''')
text = text.replace('napi_property_descriptor properties[] = {', 'napi_property_descriptor properties[] = {\n        {"scopeCounts", nullptr, probe_scope_counts, nullptr, nullptr, nullptr, napi_default, nullptr},')
# Capture just native initialization stderr in this private stage, without touching workspace contents.
import re
original = re.search(r'state->result = leo_linux_initialize\([\s\S]*?sizeof\(state->error\)\);', text)
if original is None:
    raise SystemExit('Native initialize call changed')
text = text[:original.start()] + 'probe_initialize(state);' + text[original.end():]
helper = """static void probe_initialize(Initialization *state) {
    const auto slash = state->root.find_last_of('/');
    const std::string report = state->root.substr(0, slash) + "/mcp-native-initialize.log";
    const int saved = dup(STDERR_FILENO);
    const int output = open(report.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
    if (output >= 0) dup2(output, STDERR_FILENO);
    state->result = leo_linux_initialize(state->root.c_str(), state->pack.c_str(), state->workspace.c_str(), state->error, sizeof(state->error));
    if (output >= 0) {
        fsync(output);
        if (saved >= 0) dup2(saved, STDERR_FILENO); else close(STDERR_FILENO);
        close(output);
    }
    if (saved >= 0) close(saved);
}
"""
text = text.replace('static napi_value initialize_common(', helper + 'static napi_value initialize_common(', 1)
source.write_text(text)
for declarations in [cpp / 'types/libleolinux/index.d.ts', STAGE / 'entry/oh_modules/libleolinux.so/index.d.ts']:
    if declarations.exists():
        resolved = declarations.resolve()
        if STAGE not in resolved.parents:
            raise SystemExit('Refuse to mutate a shared dependency cache')
        declaration = declarations.read_text()
        if 'scopeCounts' not in declaration:
            declarations.write_text(declaration + '\nexport interface ScopeCounts { slots: number; tasks: number; zeroWrites: number; }\nexport const scopeCounts: () => ScopeCounts;\n')
module_path = STAGE / 'entry/src/main/module.json5'
module = json.loads(module_path.read_text())
abilities = module['module']['abilities']
abilities[:] = [item for item in abilities if item['name'] not in ['ScreenSessionProbeAbility', 'McpPressureProbeAbility', 'WorkspaceCreateProbeAbility']]
abilities.append({'name': 'McpPressureProbeAbility', 'srcEntry': './ets/debug/McpPressureProbeAbility.ets',
                  'label': '$string:app_name', 'description': '$string:EntryAbility_desc', 'icon': '$media:app_icon',
                  'startWindowIcon': '$media:app_icon', 'startWindowBackground': '$color:start_window_background',
                  'exported': True, 'launchType': 'singleton'})
abilities.append({'name': 'WorkspaceCreateProbeAbility', 'srcEntry': './ets/debug/WorkspaceCreateProbeAbility.ets',
                  'label': '$string:app_name', 'description': '$string:EntryAbility_desc', 'icon': '$media:app_icon',
                  'startWindowIcon': '$media:app_icon', 'startWindowBackground': '$color:start_window_background',
                  'exported': True, 'launchType': 'singleton'})
module_path.write_text(json.dumps(module, indent=2))
page_path = STAGE / 'entry/src/main/resources/base/profile/main_pages.json'
pages = json.loads(page_path.read_text())
pages['src'] = [name for name in pages['src'] if name != 'pages/ScreenProbeStatusPage']
for relative in ['debug/ScreenSessionProbeAbility.ets', 'pages/ScreenProbeStatusPage.ets']:
    previous = ets / relative
    if previous.exists():
        previous.unlink()
if 'pages/McpPressureProbePage' not in pages['src']:
    pages['src'].append('pages/McpPressureProbePage')
if 'pages/WorkspaceCreateProbePage' not in pages['src']:
    pages['src'].append('pages/WorkspaceCreateProbePage')
page_path.write_text(json.dumps(pages, indent=2))
manifest = {'fixture': 'fixed-guest-jsonrpc-flood-with-unread-stdin', 'sameNapiInstance': True,
            'runtimeTransportReplaced': False, 'productionModuleEdited': False,
            'privateNapiObserver': ['scopeCounts', 'native write-zero count'],
            'sourceHashes': {str(path.relative_to(HERE.parent)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files},
            'nativeSources': {relative: hashlib.sha256((cpp / relative).read_bytes()).hexdigest() for relative in [
                'linux_core.c', 'linux_io.c', 'linux_platform.c', 'generated/ish/fs/fake.c',
                'generated/ish/kernel/task.c', 'generated/ish/kernel/fork.c', 'generated/ish/kernel/exit.c',
                'generated/ish/kernel/signal.c', 'generated/ish/kernel/libfakefs_redirect.c']},
            'nativeIoSha256': hashlib.sha256((cpp / 'linux_io.c').read_bytes()).hexdigest(),
            'stagedNapiSha256': hashlib.sha256(source.read_bytes()).hexdigest()}
(STAGE / 'mcp-pressure-overlay-manifest.json').write_text(json.dumps(manifest, indent=2))
print('MCP_PRESSURE_PRIVATE_STAGE_READY')
