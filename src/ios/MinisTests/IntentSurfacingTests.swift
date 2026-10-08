import XCTest

/// Upstream intent fixes: disabled providers' models are not offered in the
/// Shortcuts picker.
final class IntentSurfacingTests: XCTestCase {
    func testDisabledProviderModelsAreNotOffered() {
        XCTAssertTrue(ShortcutModelOffer.isOfferable(isHidden: false, providerEnabled: true))
        XCTAssertFalse(ShortcutModelOffer.isOfferable(isHidden: false, providerEnabled: false),
                       "a disabled provider's model must not be offered for a new automation")
        XCTAssertFalse(ShortcutModelOffer.isOfferable(isHidden: false, providerEnabled: nil),
                       "an entry whose provider instance is gone is not offerable")
        XCTAssertFalse(ShortcutModelOffer.isOfferable(isHidden: true, providerEnabled: true))
    }
}
