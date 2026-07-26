#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
cd "$repo_root"

raw_haptics="$(rg -l 'UIImpactFeedbackGenerator|UISelectionFeedbackGenerator|UINotificationFeedbackGenerator' src/ios --glob '*.swift' || true)"
if [[ "$raw_haptics" != "src/ios/Shared/LeoDesignSystem.swift" ]]; then
    print -u2 "Unexpected raw haptic generator outside LeoDesignSystem:"
    print -u2 -- "$raw_haptics"
    exit 1
fi

motion_failure=0
while IFS= read -r source_file; do
    [[ -z "$source_file" ]] && continue
    if ! rg -q 'accessibilityReduceMotion|isReduceMotionEnabled' "$source_file"; then
        print -u2 "Repeating animation lacks a Reduce Motion gate: $source_file"
        motion_failure=1
    fi
done < <(rg -l 'repeatForever' src/ios --glob '*.swift' | sort)

if (( motion_failure != 0 )); then
    exit 1
fi

print "IOSAccessibilityMotionAudit: centralized haptics and repeating-motion gates passed"
