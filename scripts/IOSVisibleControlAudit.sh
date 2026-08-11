#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
cd "$repo_root"

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
