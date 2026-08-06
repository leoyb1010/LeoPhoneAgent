import ExpoModulesCore
import StoreKit

/**
 Exposes the signed StoreKit app transaction environment to JavaScript.

 StoreKit 2 is authoritative for App Store versus TestFlight distribution:
 production means App Store, sandbox means TestFlight, and xcode means a local
 StoreKit/Xcode run. The receipt filename is used only if StoreKit cannot return
 an app transaction, so offline or temporarily unavailable StoreKit state does
 not accidentally hide updates from a TestFlight build.
 */
public class XdtIosAppDistributionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("XdtIosAppDistribution")

    AsyncFunction("getDistributionInfo") { () async -> [String: Any] in
      await self.getDistributionInfo()
    }
  }

  private func getDistributionInfo() async -> [String: Any] {
    do {
      let result = try await AppTransaction.shared
      switch result {
      case .verified(let transaction):
        return distributionInfo(for: transaction.environment, verification: "verified")
      case .unverified(let transaction, _):
        // The environment remains useful as a delivery-channel signal, while
        // verification is surfaced so security-sensitive callers never mistake
        // this result for a verified purchase assertion.
        return distributionInfo(for: transaction.environment, verification: "unverified")
      }
    } catch {
      return receiptFallbackInfo()
    }
  }

  private func distributionInfo(
    for environment: AppStore.Environment,
    verification: String
  ) -> [String: Any] {
    switch environment {
    case .production:
      return makeInfo(
        environment: "production",
        isTestFlight: false,
        source: "storekit2",
        verification: verification
      )
    case .sandbox:
      return makeInfo(
        environment: "sandbox",
        isTestFlight: true,
        source: "storekit2",
        verification: verification
      )
    case .xcode:
      return makeInfo(
        environment: "xcode",
        isTestFlight: false,
        source: "storekit2",
        verification: verification
      )
    // AppStore.Environment is a RawRepresentable struct, not an enum, so a
    // plain `default` (not `@unknown default`) is required to stay exhaustive.
    default:
      return makeInfo(
        environment: "unknown",
        isTestFlight: false,
        source: "storekit2",
        verification: verification
      )
    }
  }

  private func receiptFallbackInfo() -> [String: Any] {
    let receiptName = Bundle.main.appStoreReceiptURL?.lastPathComponent
    if receiptName == "sandboxReceipt" {
      return makeInfo(
        environment: "sandbox",
        isTestFlight: true,
        source: "receipt",
        verification: "unavailable"
      )
    }
    if receiptName == "receipt" {
      return makeInfo(
        environment: "production",
        isTestFlight: false,
        source: "receipt",
        verification: "unavailable"
      )
    }
    return makeInfo(
      environment: "unknown",
      isTestFlight: false,
      source: "unavailable",
      verification: "unavailable"
    )
  }

  private func makeInfo(
    environment: String,
    isTestFlight: Bool,
    source: String,
    verification: String
  ) -> [String: Any] {
    return [
      "environment": environment,
      "isTestFlight": isTestFlight,
      "source": source,
      "verification": verification
    ]
  }
}
