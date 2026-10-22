# iOS chat render fixture

Dev-only harness for screenshotting the chat renderer with a rich, deterministic
answer that goes through the app's real streaming path (SSE -> throttled flush ->
background parse -> `SelectableMarkdownView`). Nothing here ships: it drives a
DEBUG build's debug server (port 8321) on a simulator.

```sh
# simulator, DEBUG build installed, debug-server auth off for the sim:
xcrun simctl spawn <udid> defaults write com.leoyuan.leophoneagent debug.auth.required -bool NO
python3 fake_openai_sse.py --port 8799 --delay-file /tmp/render-delay.txt &
echo 0.004 > /tmp/render-delay.txt          # seconds per chunk; raise to slow a reply down
python3 rpc.py setup-fixture                # -> {"entryId": ...}
python3 rpc.py chat.prompt '{"prompt":"…","modelEntryId":"<entryId>","wait":true}'
python3 rpc.py chat.session.open '{"sessionId":"<sessionId>"}'
```

`fixture.md` covers headings, nested / ordered (10+) / task lists, nested quotes,
an aligned table, fenced code with and without a language, a long unbroken code
line, a rule, inline and block math.
