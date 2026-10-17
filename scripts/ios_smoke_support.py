"""Shared bits for the swiftc smoke scripts that compile slices of the iOS app.

WP-40 routed user-facing `String(localized:)` through `AppLocalized(...)`
(src/ios/Shared/AppLocalization.swift) so the in-app language switch applies
without a relaunch. Harnesses that paste production methods into a standalone
file need that symbol too: prepend APP_LOCALIZED_SHIM to the pasted text, or add
APP_LOCALIZATION_SOURCE to a multi-file swiftc command that compiles real sources.
"""
from pathlib import Path

APP_LOCALIZATION_SOURCE = Path(__file__).resolve().parents[1] / 'src/ios/Shared/AppLocalization.swift'

APP_LOCALIZED_SHIM = '''import Foundation
func AppLocalized(_ key: String.LocalizationValue, comment: StaticString? = nil) -> String { String(localized: key) }
func AppLocalized(resource: LocalizedStringResource) -> String { String(localized: resource) }
'''
