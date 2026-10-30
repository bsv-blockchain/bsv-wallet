import BsvBridgeQueue
import Foundation
import SafariServices

/// One native message in, one reply out. All the logic lives in `handleBridgeMessage`; this class only
/// finds the container and the groups the plugin wrote into Info.plist (nothing is hard-coded).
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
  func beginRequest(with context: NSExtensionContext) {
    let item = context.inputItems.first as? NSExtensionItem
    let request = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
    let reply = Self.respond(to: request)
    let response = NSExtensionItem()
    response.userInfo = [SFExtensionMessageKey: reply]
    context.completeRequest(returningItems: [response], completionHandler: nil)
  }

  private static func respond(to request: [String: Any]) -> [String: Any] {
    func value(_ key: String) -> String? {
      Bundle.main.object(forInfoDictionaryKey: key) as? String
    }
    guard let appGroup = value("BSVBridgeAppGroup"), let keychainGroup = value("BSVBridgeKeychainGroup"),
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else {
      return ["ok": false, "code": "UNAVAILABLE", "message": "The bridge is not configured"]
    }
    do {
      // The extension never creates the sealing key (createIfMissing: false).
      let store = try BridgeStore(
        root: container.appendingPathComponent("bridge", isDirectory: true),
        keys: KeychainKeyProvider(group: keychainGroup, createIfMissing: false))
      let env = BridgeEnv(
        store: store,
        continuity: Continuity(keychainGroup: keychainGroup, keys: KeychainContinuityKeyStore(group: keychainGroup)),
        nudge: { BridgeNudge.post(appGroup: appGroup) })
      return handleBridgeMessage(request, env: env)
    } catch {
      return ["ok": false, "code": "UNAVAILABLE", "message": "\(error)"]
    }
  }
}
