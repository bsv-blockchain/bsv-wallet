import CryptoKit
import Foundation
import Security

public enum BridgeError: Error, Equatable {
  /// The sealing key cannot be read (not created yet, or the device has not been unlocked since boot).
  case keyMissing(Int32)
  case invalidId
  /// `reset()` has run and no `init` has followed (Task 9).
  case resetFinal
  case io(String)
}

/// Where the container key comes from. The keychain stays behind this protocol so tests can use a
/// fixed key.
public protocol KeyProvider {
  func sealingKey() throws -> SymmetricKey
  /// Removes the stored key (`reset()`); a no-op for providers that hold no persistent item.
  func deleteKey()
}

extension KeyProvider {
  public func deleteKey() {}
}

public struct InMemoryKeyProvider: KeyProvider {
  private let key: SymmetricKey
  public init(key: SymmetricKey = SymmetricKey(size: .bits256)) { self.key = key }
  public func sealingKey() throws -> SymmetricKey { key }
}

/// A provider that always fails: models a wake before first unlock or a key that was never created.
public struct UnavailableKeyProvider: KeyProvider {
  public init() {}
  public func sealingKey() throws -> SymmetricKey { throw BridgeError.keyMissing(errSecItemNotFound) }
}

/// The 32-byte container key as a generic-password item in the bridge keychain group (spec 6.4).
/// The app passes `createIfMissing: true` (add-or-read; on a duplicate it reads again). The extension
/// passes false and gets `keyMissing` instead of ever creating a key.
public struct KeychainKeyProvider: KeyProvider {
  public static let service = "bsv-bridge/v1"
  public static let account = "sealing-key"

  public let group: String
  public let createIfMissing: Bool

  public init(group: String, createIfMissing: Bool) {
    self.group = group
    self.createIfMissing = createIfMissing
  }

  private var baseQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: Self.account,
      kSecAttrAccessGroup as String: group,
      kSecAttrSynchronizable as String: false
    ]
  }

  private func read() -> (SymmetricKey?, OSStatus) {
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    guard status == errSecSuccess, let data = out as? Data, data.count == 32 else { return (nil, status) }
    return (SymmetricKey(data: data), status)
  }

  public func sealingKey() throws -> SymmetricKey {
    let (key, status) = read()
    if let key { return key }
    guard createIfMissing, status == errSecItemNotFound else { throw BridgeError.keyMissing(status) }

    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw BridgeError.keyMissing(errSecAllocate)
    }
    var add = baseQuery
    add[kSecValueData as String] = Data(bytes)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let added = SecItemAdd(add as CFDictionary, nil)
    if added == errSecSuccess || added == errSecDuplicateItem {
      // On a duplicate another process created it first: read theirs, never overwrite.
      let (again, againStatus) = read()
      if let again { return again }
      throw BridgeError.keyMissing(againStatus)
    }
    throw BridgeError.keyMissing(added)
  }

  /// Deletes the item (used by `reset()` in Task 9).
  public func deleteKey() {
    SecItemDelete(baseQuery as CFDictionary)
  }
}
