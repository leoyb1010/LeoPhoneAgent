#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
cd "$repo_root"

# [T-gate-on-real-path] 这条闸门靠 ripgrep。本机 PATH 里没有 rg 时,下面的 `|| true` 会让检查
# 永远是空的:可见控件审计「通过」,动效审计误报 —— 两种都是假结果。没有 rg 就直接红,别假装检查过。
command -v rg >/dev/null 2>&1 || { print -u2 "$0: 需要 ripgrep(brew install ripgrep)"; exit 2; }

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
