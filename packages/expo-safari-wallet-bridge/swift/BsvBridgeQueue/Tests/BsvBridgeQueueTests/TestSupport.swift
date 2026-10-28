import CryptoKit
import Foundation
import XCTest

@testable import BsvBridgeQueue

let MARKER = "PLAINTEXT-MARKER-7f3a"

func ID(_ n: Int) -> String { "00000000-0000-4000-8000-" + String(format: "%012d", n) }

func utf8(_ s: String) -> Data { Data(s.utf8) }

func text(_ d: Data?) -> String? { d.flatMap { String(data: $0, encoding: .utf8) } }

func digest(_ s: String) -> String { sha256Hex(utf8(s)) }

func contains(_ haystack: Data, _ needle: String) -> Bool { haystack.range(of: utf8(needle)) != nil }

/// A store over a scratch directory with a manual clock and boot ids, standing in for one "process".
final class Harness {
  let root: URL
  let keys: KeyProvider
  var store: BridgeStore
  var t: Int64 = 1_000_000
  private(set) var boot = 1

  init(keys: KeyProvider = InMemoryKeyProvider()) throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("bridge-test-\(UUID().uuidString)")
    self.keys = keys
    store = try BridgeStore(root: root, keys: keys)
  }

  deinit { try? FileManager.default.removeItem(at: root) }

  var bootId: String { "boot-\(boot)" }

  func advance(_ ms: Int64) { t += ms }

  /// The same persisted state opened by a new process (new boot id).
  @discardableResult
  func restart() throws -> BridgeStore {
    boot += 1
    store = try BridgeStore(root: root, keys: keys)
    return store
  }

  func create(_ n: Int, _ s: String) throws -> Bool { try store.create(id: ID(n), bytes: utf8(s), nowMs: t) }
  func claim(_ n: Int, _ s: String) throws -> ClaimOutcome {
    try store.claim(id: ID(n), digest: digest(s), bootId: bootId, nowMs: t)
  }
  func result(_ n: Int, _ s: String) throws -> Bool { try store.writeResult(id: ID(n), bytes: utf8(s), nowMs: t) }
  func readResult(_ n: Int) throws -> ResultRead { try store.readResult(id: ID(n), nowMs: t) }

  /// Every file under the container, as stored.
  func rawFiles() -> [(path: String, bytes: Data)] {
    guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else {
      return []
    }
    return e.compactMap { item in
      guard let url = item as? URL, (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true,
        let d = try? Data(contentsOf: url)
      else { return nil }
      return (url.path.replacingOccurrences(of: root.path, with: ""), d)
    }
  }
}

/// A key that is generated on first use and forgotten by `deleteKey()`, like the keychain item.
final class ResettableKeyProvider: KeyProvider {
  private var key: SymmetricKey?
  private let lock = NSLock()
  func sealingKey() throws -> SymmetricKey {
    lock.lock()
    defer { lock.unlock() }
    if let key { return key }
    let k = SymmetricKey(size: .bits256)
    key = k
    return k
  }
  func deleteKey() {
    lock.lock()
    key = nil
    lock.unlock()
  }
}

func pendingFile(_ h: Harness, _ n: Int) -> URL { h.root.appendingPathComponent("pending/\(ID(n))") }

/// Like the extension's read-only keychain provider: once the key is deleted it stays missing.
final class StaysMissingKeyProvider: KeyProvider {
  private var key: SymmetricKey? = SymmetricKey(size: .bits256)
  private var status: Int32 = errSecItemNotFound
  private let lock = NSLock()
  func sealingKey() throws -> SymmetricKey {
    lock.lock()
    defer { lock.unlock() }
    guard let key else { throw BridgeError.keyMissing(status) }
    return key
  }
  func deleteKey() {
    lock.lock()
    key = nil
    lock.unlock()
  }
  /// Models a wake before first unlock instead of a deleted item.
  func lockDevice() {
    lock.lock()
    key = nil
    status = errSecInteractionNotAllowed
    lock.unlock()
  }
}
