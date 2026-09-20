export const ACCESSIBILITY_PANE_URLS = [
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
];

export function accessibilityPaneUrls() {
  return ACCESSIBILITY_PANE_URLS.slice();
}
