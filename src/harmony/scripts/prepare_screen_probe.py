#!/usr/bin/env python3
"""Overlay a private screen-test stage. Never edits the production app module."""
import argparse
import hashlib
import re
import json
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('stage')
parser.add_argument('--fixture-host', required=True)
args = parser.parse_args()
HOST = args.fixture_host.lower()
if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,240}\.ts\.net', HOST):
    raise SystemExit('Use the explicitly approved fixture certificate hostname')
STAGE = Path(args.stage).resolve()
APP = (HERE.parent / 'app').resolve()
if STAGE == APP or APP in STAGE.parents or STAGE == Path('/tmp/leo-harmony-app').resolve():
    raise SystemExit('Use an independent private diagnostic stage')
module_path = STAGE / 'entry/src/main/module.json5'
module = json.loads(module_path.read_text())
if json.loads((STAGE / 'AppScope/app.json5').read_text())['app']['bundleName'] != 'com.leoyuan.leophoneagent.harmony':
    raise SystemExit('Only the LeoBot test bundle can receive this overlay')
ets = STAGE / 'entry/src/main/ets'
(ets / 'debug').mkdir(exist_ok=True)
files = {
    HERE / 'fixtures/ScreenSessionProbeAbility.ets': ets / 'debug/ScreenSessionProbeAbility.ets',
    HERE / 'fixtures/ScreenProbeStatusPage.ets': ets / 'pages/ScreenProbeStatusPage.ets',
}
for relative in ['pages/ScreenSessionPage.ets', 'remote/ScreenSessionBridge.ets', 'remote/RemoteWorkspaceLaunch.ets', 'net/HarnessClient.ets']:
    files[APP / 'entry/src/main/ets' / relative] = ets / relative
files[APP / 'entry/src/main/resources/rawfile/remote_screen.html'] = STAGE / 'entry/src/main/resources/rawfile/remote_screen.html'
for source, destination in files.items():
    shutil.copy2(source, destination)
    if '__LEO_SCREEN_PROBE_HOST__' in destination.read_text():
        destination.write_text(destination.read_text().replace('__LEO_SCREEN_PROBE_HOST__', HOST))
# The private page makes the diagnostic mapping visible and removes it before terminating.
page = ets / 'pages/ScreenSessionPage.ets'
text = page.read_text()
text = "import { connection } from '@kit.NetworkKit';\nimport { ActionButton } from '../theme/Controls';\n" + text
text = text.replace("      NavBar({ title: 'Mac 视频屏幕' })", """      NavBar({ title: 'Mac 视频屏幕' })
      Row({ space: 12 }) {
        Text('诊断 App DNS · 固定证书域名 → 10.0.2.2').fontSize(12).fontColor(Tokens.secondary).layoutWeight(1)
        ActionButton({ label: '结束诊断', variant: 'secondary', fullWidth: false, onTap: () => { this.endProbe(); } })
      }.padding(12).width('100%')""")
text = text.replace('  private setControl(value: boolean): void {', """  private async endProbe(): Promise<void> {
    try {
      await ScreenSessionRegistry.suspend();
      await connection.removeCustomDnsRule('__LEO_SCREEN_PROBE_HOST__');
      console.info('LEOBOT_SCREEN_PROBE_DNS_REMOVED');
      await (getContext(this) as common.UIAbilityContext).terminateSelf();
    } catch (error) { this.error = '诊断清理失败 ' + (error as Error).message; }
  }

  private setControl(value: boolean): void {""")
page.write_text(text.replace('__LEO_SCREEN_PROBE_HOST__', HOST))
abilities = module['module']['abilities']
abilities[:] = [item for item in abilities if item['name'] != 'ScreenSessionProbeAbility']
abilities.append({'name': 'ScreenSessionProbeAbility', 'srcEntry': './ets/debug/ScreenSessionProbeAbility.ets',
                  'description': '$string:EntryAbility_desc', 'label': '$string:app_name', 'icon': '$media:app_icon',
                  'exported': True, 'launchType': 'singleton',
                  'startWindowIcon': '$media:app_icon', 'startWindowBackground': '$color:start_window_background'})
module_path.write_text(json.dumps(module, ensure_ascii=False, indent=2))
page_path = STAGE / 'entry/src/main/resources/base/profile/main_pages.json'
pages = json.loads(page_path.read_text())
if 'pages/ScreenProbeStatusPage' not in pages['src']:
    pages['src'].append('pages/ScreenProbeStatusPage')
page_path.write_text(json.dumps(pages, indent=2))
manifest = {'fixture': 'fixed-tailnet-host-to-emulator-host-only', 'dnsScope': 'current app',
            'dnsMapping': {HOST: ['10.0.2.2']},
            'certificateValidation': 'system CA and original hostname unchanged', 'productionModuleEdited': False, 'debugAbilityExported': True,
            'stagedScreenPageSha256': hashlib.sha256(page.read_bytes()).hexdigest(),
            'sources': {str(source.relative_to(HERE.parent)): hashlib.sha256(source.read_bytes()).hexdigest() for source in files}}
(STAGE / 'screen-probe-overlay-manifest.json').write_text(json.dumps(manifest, indent=2))
print('SCREEN_PROBE_PRIVATE_STAGE_READY')
