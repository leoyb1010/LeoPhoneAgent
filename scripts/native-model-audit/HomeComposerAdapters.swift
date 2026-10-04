// TEST ONLY: FullAuto's visual declarations are production source; these seams
// cannot authorize tools, call biometric services, or contact remote machines.
import SwiftUI
import UIKit

@MainActor final class FullAutoStore: ObservableObject {
    static let shared = FullAutoStore()
    @Published var mode: FullAutoGate.Mode = .ask
}

enum BiometricAuth {
    static func authorizeLoweringProtection(reason: String) async -> Bool { false }
}

extension LeoHaptics {
    static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {}
}
