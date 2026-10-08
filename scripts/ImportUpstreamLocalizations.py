#!/usr/bin/env python3
"""Import upstream (OpenMinis) String Catalog translations for new locales.

Read-only by default: prints per-locale coverage. With --apply it adds
translations ONLY for locales whose coverage of our user-visible keys reaches
--min-coverage, and only where: the key exists in both catalogs, the English
source is identical, we have no translation yet, placeholders match and the
text carries no upstream branding. Our serialization (json indent=2,
ensure_ascii=False, insertion order, trailing newline) is preserved, so the
diff contains only the added units. Registering a locale (knownRegions,
CFBundleLocalizations, <locale>.lproj/InfoPlist.strings) stays a manual step.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

NEW_LOCALES = ["es", "fil", "hr", "id", "ms", "pl", "pt-BR", "ro", "th", "tr"]
BRANDING = re.compile(r"minis|openminis", re.I)
PLACEHOLDER = re.compile(r"%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?(?:ll|l|h)?[@dDuUxXoOfeEgGcCsSpaA%]")


def source_of(entry, key):
    return entry.get("localizations", {}).get("en", {}).get("stringUnit", {}).get("value", key)


def placeholders(text):
    return sorted(re.sub(r"^%\d+\$", "%", p) for p in PLACEHOLDER.findall(text))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default="src/ios/Localizable.xcstrings")
    ap.add_argument("--upstream-ref", default="upstream/main:src/ios/Localizable.xcstrings")
    ap.add_argument("--min-coverage", type=float, default=60.0)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    path = Path(args.catalog)
    ours = json.loads(path.read_text(encoding="utf-8"))
    upstream = json.loads(subprocess.check_output(["git", "show", args.upstream_ref]))["strings"]
    strings = ours["strings"]
    visible = [k for k, v in strings.items()
               if k.strip() and v.get("extractionState") != "stale" and v.get("shouldTranslate") is not False]
    changed = 0
    for locale in NEW_LOCALES:
        picks = {}
        for key in visible:
            up = upstream.get(key)
            if not up or source_of(up, key) != source_of(strings[key], key):
                continue
            if locale in strings[key].get("localizations", {}):
                continue
            unit = up.get("localizations", {}).get(locale, {}).get("stringUnit")
            if not unit or unit.get("state") != "translated" or not unit.get("value"):
                continue
            value = unit["value"]
            if BRANDING.search(value) or placeholders(value) != placeholders(source_of(strings[key], key)):
                continue
            picks[key] = value
        coverage = 100.0 * len(picks) / max(1, len(visible))
        ok = coverage >= args.min_coverage
        print(f"{locale}: {len(picks)}/{len(visible)} user-visible keys = {coverage:.1f}% "
              f"→ {'import' if ok else 'below threshold, not imported'}")
        if args.apply and ok:
            for key, value in picks.items():
                strings[key].setdefault("localizations", {})[locale] = {
                    "stringUnit": {"state": "translated", "value": value}}
            changed += len(picks)
    if args.apply and changed:
        path.write_text(json.dumps(ours, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {changed} translations; register the imported locales manually")


if __name__ == "__main__":
    main()
