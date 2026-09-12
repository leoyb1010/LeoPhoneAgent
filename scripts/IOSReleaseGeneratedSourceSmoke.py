#!/usr/bin/env python3
"""Run the actual Release generation phase and verify content/mtime stability."""
from pathlib import Path
import json, os, re, subprocess, tempfile
repo = Path(__file__).resolve().parents[1]
project = (repo / 'src/ios/LeoPhoneAgent.xcodeproj/project.pbxproj').read_text()
phase = project[project.index('E54000AD0 /* Generate Debug Skill */ = {'):]
match = re.search(r'shellScript = ("(?:\\.|[^"\\])*");', phase)
assert match
script = json.loads(match.group(1))
with tempfile.TemporaryDirectory(prefix='leophone-release-generation-') as folder:
    root = Path(folder)
    env = dict(os.environ, SRCROOT=str(root), CONFIGURATION='Release')
    def run(): subprocess.run(['/bin/bash', '-c', script], env=env, check=True)
    output = root / 'Generated/DebugSkillGenerated.swift'
    run()
    expected = output.read_bytes()
    assert b'enum DebugSkillGenerated' in expected and b'#if DEBUG' in expected
    stamp = 1_000_000_000
    os.utime(output, ns=(stamp, stamp))
    run()
    assert output.read_bytes() == expected
    assert output.stat().st_mtime_ns == stamp, 'Release rewrote unchanged generated Swift source'
    output.write_text('stale generated source')
    run()
    assert output.read_bytes() == expected, 'Changed content did not regenerate'
    assert [p.name for p in output.parent.iterdir()] == [output.name], 'Temporary files leaked'
print('PASS actual Release phase: stable content and mtime, changed-content replacement, no temporary files')
