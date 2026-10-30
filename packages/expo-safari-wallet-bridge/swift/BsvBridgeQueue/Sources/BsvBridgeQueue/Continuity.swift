import CryptoKit
import Foundation
import Security

public enum ContinuityError: Error, Equatable {
  /// The preimage does not start with the describe prefix, or is over 16 KiB.
  case badPreimage
  /// Only `safari` and `safari-private` exist.
  case badContext
  /// The public key is small-order or non-canonical; nothing is persisted or returned.
  case weakKey
  case keychain(Int32)
  case corrupt
}

public let continuityContexts = ["safari", "safari-private"]
public let continuityDescribePrefix = "BRC-185 descriptor v1\n"
public let continuityMaxPreimageBytes = 16 * 1024

/// The persisted part of one context: the Ed25519 seed (never leaves Swift) and the provider instance id.
public struct ContinuityRecord: Equatable {
  public var seed: Data
  public var instanceId: String
  public init(seed: Data, instanceId: String) {
    self.seed = seed
    self.instanceId = instanceId
  }
}

public protocol ContinuityKeyStore {
  func load(context: String) throws -> ContinuityRecord?
  /// Adds the record unless one exists. True when added, false when another process won the race.
  func add(_ record: ContinuityRecord, context: String) throws -> Bool
  func deleteAll()
}

public final class InMemoryContinuityKeyStore: ContinuityKeyStore {
  private var records: [String: ContinuityRecord] = [:]
  private let lock = NSLock()
  public init() {}
  public func load(context: String) throws -> ContinuityRecord? {
    lock.lock()
    defer { lock.unlock() }
    return records[context]
  }
  public func add(_ record: ContinuityRecord, context: String) throws -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if records[context] != nil { return false }
    records[context] = record
    return true
  }
  public func deleteAll() {
    lock.lock()
    records = [:]
    lock.unlock()
  }
  /// Test inspection.
  public var snapshot: [String: ContinuityRecord] {
    lock.lock()
    defer { lock.unlock() }
    return records
  }
}

/// One generic-password item per context in the bridge keychain group, `AfterFirstUnlockThisDeviceOnly`,
/// not synchronised. Unlike the sealing key, the extension creates these on first `identity` (spec 6.9).
public struct KeychainContinuityKeyStore: ContinuityKeyStore {
  public static let service = "bsv-bridge/continuity/v1"
  public let group: String
  public init(group: String) { self.group = group }

  private func query(_ context: String?) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccessGroup as String: group,
      kSecAttrSynchronizable as String: false
    ]
    if let context { q[kSecAttrAccount as String] = context }
    return q
  }

  public func load(context: String) throws -> ContinuityRecord? {
    var q = query(context)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw ContinuityError.keychain(status) }
    guard let data = out as? Data,
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
      let seedB64 = obj["seed"], let seed = Data(base64Encoded: seedB64), seed.count == 32,
      let instanceId = obj["instanceId"]
    else { throw ContinuityError.corrupt }
    return ContinuityRecord(seed: seed, instanceId: instanceId)
  }

  public func add(_ record: ContinuityRecord, context: String) throws -> Bool {
    let json = try JSONSerialization.data(
      withJSONObject: ["seed": record.seed.base64EncodedString(), "instanceId": record.instanceId],
      options: [.sortedKeys])
    var q = query(context)
    q[kSecValueData as String] = json
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(q as CFDictionary, nil)
    if status == errSecSuccess { return true }
    if status == errSecDuplicateItem { return false }
    throw ContinuityError.keychain(status)
  }

  public func deleteAll() {
    SecItemDelete(query(nil) as CFDictionary)
  }
}

/// y-coordinates (little endian, sign bit cleared) of the small-order points of edwards25519: 0 (order 4),
/// 1 (identity), p - 1 (order 2) and the two order-8 values. The sign bit gives the other points.
private let smallOrderY: [[UInt8]] = [
  [UInt8](repeating: 0, count: 32),
  [0x01] + [UInt8](repeating: 0, count: 31),
  [0xec] + [UInt8](repeating: 0xff, count: 30) + [0x7f],
  hexBytes("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
  hexBytes("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05")
]

private func hexBytes(_ s: String) -> [UInt8] {
  var out: [UInt8] = []
  var i = s.startIndex
  while i < s.endIndex {
    let j = s.index(i, offsetBy: 2)
    out.append(UInt8(s[i..<j], radix: 16)!)
    i = j
  }
  out[out.count - 1] &= 0x7f
  return out
}

/// Port of P1's `isStrongEd25519Key`: 32 bytes, canonical y (< 2^255 - 19), and not one of the eight
/// small-order points (identity included). The key is always derived from a CryptoKit private key, so
/// being on the curve holds by construction; this guards a corrupted or substituted item.
public func isStrongEd25519Key(_ pub: Data) -> Bool {
  guard pub.count == 32 else { return false }
  var y = [UInt8](pub)
  y[31] &= 0x7f
  // y >= p = 2^255 - 19: compare from the top byte down.
  let p: [UInt8] = [0xed] + [UInt8](repeating: 0xff, count: 30) + [0x7f]
  for i in stride(from: 31, through: 0, by: -1) {
    if y[i] != p[i] {
      if y[i] > p[i] { return false }
      break
    }
    if i == 0 { return false }  // equal to p
  }
  return !smallOrderY.contains(y)
}

/// Ed25519 continuity keys per context (spec 6.9). Private bytes never leave this class.
public final class Continuity {
  public let keychainGroup: String
  private let keys: ContinuityKeyStore
  private let strong: (Data) -> Bool
  private let lock = NSLock()

  public init(keychainGroup: String, keys: ContinuityKeyStore) {
    self.keychainGroup = keychainGroup
    self.keys = keys
    self.strong = isStrongEd25519Key
  }

  /// Test seam: replaces the strong-key rule.
  init(keychainGroup: String, keys: ContinuityKeyStore, strongCheck: @escaping (Data) -> Bool) {
    self.keychainGroup = keychainGroup
    self.keys = keys
    self.strong = strongCheck
  }

  private func record(_ context: String, create: Bool) throws -> (ContinuityRecord, Data)? {
    guard continuityContexts.contains(context) else { throw ContinuityError.badContext }
    lock.lock()
    defer { lock.unlock() }
    var rec = try keys.load(context: context)
    if rec == nil {
      guard create else { return nil }
      let key = Curve25519.Signing.PrivateKey()
      guard strong(key.publicKey.rawRepresentation) else { throw ContinuityError.weakKey }
      let fresh = ContinuityRecord(seed: key.rawRepresentation, instanceId: UUID().uuidString.lowercased())
      // A concurrent creator in the other process wins; read theirs and never overwrite.
      if try !keys.add(fresh, context: context) { rec = try keys.load(context: context) } else { rec = fresh }
    }
    guard let rec, let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: rec.seed) else {
      throw ContinuityError.corrupt
    }
    let pub = key.publicKey.rawRepresentation
    guard strong(pub) else { throw ContinuityError.weakKey }
    return (rec, pub)
  }

  /// Creates the key and `instanceId` on first use.
  public func identity(context: String) throws -> (instanceId: String, publicKey: Data) {
    guard let (rec, pub) = try record(context, create: true) else { throw ContinuityError.corrupt }
    return (rec.instanceId, pub)
  }

  /// Signs a describe preimage only: prefix `BRC-185 descriptor v1\n`, at most 16 KiB.
  public func sign(context: String, preimage: Data) throws -> Data {
    guard preimage.count <= continuityMaxPreimageBytes,
      preimage.starts(with: Data(continuityDescribePrefix.utf8))
    else { throw ContinuityError.badPreimage }
    guard let (rec, _) = try record(context, create: true),
      let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: rec.seed)
    else { throw ContinuityError.corrupt }
    return try key.signature(for: preimage)
  }

  /// `reset()`: deletes every continuity key; the next `identity` makes a new provider identity.
  public func resetAll() {
    lock.lock()
    keys.deleteAll()
    lock.unlock()
  }
}
