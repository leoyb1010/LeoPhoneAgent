#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
cd "$repo_root"

# [T-gate-on-real-path] 这条闸门靠 ripgrep。本机 PATH 里没有 rg 时,下面的 `|| true` 会让检查
# 永远是空的:可见控件审计「通过」,动效审计误报 —— 两种都是假结果。没有 rg 就直接红,别假装检查过。
command -v rg >/dev/null 2>&1 || { print -u2 "$0: 需要 ripgrep(brew install ripgrep)"; exit 2; }

# SwiftUI requires every Button to declare an action. Empty actions are only
# legitimate for alert dismissal buttons; everything else is a visible no-op.
empty_buttons="$(rg -n -U 'Button\([^\n]*\)\s*\{\s*\}' src/ios --glob '*.swift' || true)"
unexpected_empty="$(print -r -- "$empty_buttons" | rg -v 'role: \.cancel|Button\("OK"(, role: \.cancel)?\)' || true)"

if [[ -n "$unexpected_empty" ]]; then
    print -u2 "Visible SwiftUI buttons with empty actions:"
    print -u2 -- "$unexpected_empty"
    exit 1
fi

if rg -n -U 'Button\s*\{\s*\}\s*label|Button\(action:\s*\{\s*\}\)' src/ios --glob '*.swift'; then
    print -u2 "Visible SwiftUI button uses an empty trailing/action closure"
    exit 1
fi

if rg -n -U 'onTapGesture\s*\{\s*\}' src/ios --glob '*.swift'; then
    print -u2 "Visible SwiftUI tap target uses an empty gesture"
    exit 1
fi

dismissal_count="$(print -r -- "$empty_buttons" | rg -c '.' || true)"
print "IOSVisibleControlAudit: no no-op controls; $dismissal_count empty actions are alert dismissal buttons"
