import CryptoKit
import Foundation

public struct StatResult: Equatable {
  /// Plaintext size of the record as staged. For `done` it is the size of the result.
  public let size: Int
  public let state: State
  public let claimBootId: String?
}

public enum ClaimOutcome: Equatable {
  case claimed, digestMismatch, notAccepted
}

public enum ResultRead: Equatable {
  /// No result has been written yet.
  case none
  case result(Data)
  /// Acknowledged or past its lifetime: the payload is gone, the id tombstone remains.
  case purged
}

/// The header every sealed file starts with. It survives deleting the payload.
struct Header: Codable, Equatable {
  var v: Int
  var id: String
  var size: Int
  var digest: String
  var createdAt: Int64
  var notAfter: Int64
  var claimBootId: String?
}

public let bridgeValidityMs: Int64 = 15 * 60_000
public let bridgeResultTtlMs: Int64 = 15 * 60_000

func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// The sealed App Group queue (spec 6.4): `<root>/{tmp,ids,pending,accepted,claimed,withdrawn,results,...}`.
///
/// A file is `u32be(headerLength) || sealedHeader || sealedPayload?`. State is the directory the file
/// is in; every transition is `rename(2)`, so exactly one caller wins any race, and ids are
/// create-exclusive through `link(2)` into `ids/`. The store holds no mutable state besides the cached
/// key, so any number of instances in any number of processes may share one root.
///
/// Operations that must unseal throw `BridgeError.keyMissing` when the key is unreadable; the
/// extension turns that into `CONFIGURATION_ERROR` / `not-sent`. Operations that only move or copy
/// files (`accept`, `release`, `ack`, `withdraw`) never need the key.
public final class BridgeStore {
  let layout: Layout
  private let keys: KeyProvider
  private let lock = NSLock()
  private var cachedKey: SymmetricKey?

  /// Test-only crash simulation: called after a named step (`linked`, `renamedPending`,
  /// `renamedClaimed`, `resultLinked`). Throwing leaves the disk exactly as a crash there would.
  public var faultAfter: ((String) throws -> Void)?

  public init(root: URL, keys: KeyProvider, protection: ProtectionClass = .untilFirstUserAuthentication) throws {
    self.layout = Layout(root: root, protection: protection)
    self.keys = keys
    try layout.createDirectories()
    layout.applyAttributesToTree()
  }

  // MARK: Key and file helpers

  func key() throws -> SymmetricKey {
    lock.lock()
    defer { lock.unlock() }
    if let cachedKey { return cachedKey }
    let k = try keys.sealingKey()
    cachedKey = k
    return k
  }

  private func fault(_ step: String) throws { try faultAfter?(step) }

  private static func be32(_ n: Int) -> Data {
    Data([UInt8((n >> 24) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)])
  }

  private static let maxHeaderBytes = 4096

  private func encode(_ header: Header, payload: Data?, kind: SealKind) throws -> Data {
    let k = try key()
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    let sealedHeader = try Sealing.seal(try enc.encode(header), key: k, kind: kind, id: header.id)
    var out = Self.be32(sealedHeader.count)
    out.append(sealedHeader)
    if let payload { out.append(try Sealing.seal(payload, key: k, kind: kind, id: header.id)) }
    return out
  }

  /// `(raw prefix + sealed header, sealed payload if any)`; the first part is a valid header-only file.
  private func split(_ file: Data) -> (headerOnly: Data, sealedHeader: Data, sealedPayload: Data?)? {
    guard file.count >= 4 else { return nil }
    let n = file.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
    guard n > 0, n <= Self.maxHeaderBytes, file.count >= 4 + n else { return nil }
    let start = file.startIndex
    let headerOnly = file.subdata(in: start..<(start + 4 + n))
    let sealedHeader = file.subdata(in: (start + 4)..<(start + 4 + n))
    let rest = file.count > 4 + n ? file.subdata(in: (start + 4 + n)..<file.endIndex) : nil
    return (headerOnly, sealedHeader, rest)
  }

  /// Reads only the header from disk (never the payload).
  private func readHeaderPart(_ url: URL) -> Data? {
    guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? h.close() }
    guard let lenBytes = try? h.read(upToCount: 4), lenBytes.count == 4 else { return nil }
    let n = lenBytes.reduce(0) { ($0 << 8) | Int($1) }
    guard n > 0, n <= Self.maxHeaderBytes else { return nil }
    guard let body = try? h.read(upToCount: n), body.count == n else { return nil }
    return lenBytes + body
  }

  /// Unseals a header; nil for a corrupt or foreign one, throws only when the key is unreadable.
  private func openHeader(_ sealed: Data, id: String, kind: SealKind) throws -> Header? {
    let k = try key()
    guard let plain = try? Sealing.open(sealed, key: k, kind: kind, id: id),
      let h = try? JSONDecoder().decode(Header.self, from: plain), h.v == 1, h.id == id
    else { return nil }
    return h
  }

  private func headerOf(_ dir: Dir, _ id: String) throws -> Header? {
    let kind: SealKind = dir == .results ? .result : .record
    guard let part = readHeaderPart(layout.file(dir, id)), let s = split(part) else { return nil }
    return try openHeader(s.sealedHeader, id: id, kind: kind)
  }

  private func writeTmp(_ data: Data) throws -> URL {
    let tmp = layout.tmpFile()
    try Posix.writeExclusive(tmp, data)
    layout.applyAttributes(tmp)
    return tmp
  }

  private func requireId(_ id: String) throws {
    guard Layout.validId(id) else { throw BridgeError.invalidId }
  }

  // MARK: Contract

  /// Stages a record as `pending`. False when the id exists in any state, tombstones included.
  public func create(id: String, bytes: Data, nowMs: Int64) throws -> Bool {
    try requireId(id)
    var createdAt = nowMs
    var notAfter = nowMs + bridgeValidityMs
    if let obj = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
      if let c = (obj["createdAt"] as? NSNumber)?.int64Value, c >= 0 { createdAt = c }
      if let n = (obj["notAfter"] as? NSNumber)?.int64Value, n >= 0 { notAfter = n }
    }
    let header = Header(
      v: 1, id: id, size: bytes.count, digest: sha256Hex(bytes), createdAt: createdAt, notAfter: notAfter,
      claimBootId: nil)
    let record = try writeTmp(try encode(header, payload: bytes, kind: .record))
    // The tombstone is a separate zero-byte file so it stays zero-byte when the record is deleted.
    let marker = try writeTmp(Data())
    defer { Posix.unlink(marker) }
    if let err = Posix.link(marker, layout.file(.ids, id)) {
      Posix.unlink(record)
      if err == EEXIST { return false }
      throw BridgeError.io("link \(err)")
    }
    try fault("linked")
    if let err = Posix.rename(record, layout.file(.pending, id)) { throw BridgeError.io("rename \(err)") }
    try fault("renamedPending")
    return true
  }

  public func stat(id: String) throws -> StatResult? {
    guard Layout.validId(id) else { return nil }
    for _ in 0..<3 {
      if let h = try headerOf(.results, id) {
        return StatResult(size: h.size, state: .done, claimBootId: nil)
      }
      for (dir, state) in [(Dir.pending, State.pending), (.accepted, .accepted), (.claimed, .claimed), (.withdrawn, .withdrawn)] {
        if let h = try headerOf(dir, id) { return StatResult(size: h.size, state: state, claimBootId: h.claimBootId) }
      }
      // A file may have moved between two of the checks above; an orphan tombstone stays unseen.
      if !Posix.exists(layout.file(.ids, id)) { return nil }
    }
    return nil
  }

  /// The immutable bytes of a pending or accepted record. Undefined once the arguments are gone.
  public func read(id: String) throws -> Data? {
    guard Layout.validId(id), !Posix.exists(layout.file(.results, id)) else { return nil }
    for dir in [Dir.pending, .accepted] {
      guard let file = try? Data(contentsOf: layout.file(dir, id)), let s = split(file),
        let header = try openHeader(s.sealedHeader, id: id, kind: .record), let sealed = s.sealedPayload,
        let plain = try? Sealing.open(sealed, key: try key(), kind: .record, id: id),
        sha256Hex(plain) == header.digest
      else { continue }
      return plain
    }
    return nil
  }

  /// `pending -> accepted`. False when the record is not pending.
  public func accept(id: String) -> Bool { move(id, .pending, .accepted) }

  /// `accepted -> pending`: crash recovery for a record that was never dispatched.
  public func release(id: String) -> Bool { move(id, .accepted, .pending) }

  /// `pending -> withdrawn` (the extension's cancel; it loses to a prior accept).
  public func withdraw(id: String) -> Bool { move(id, .pending, .withdrawn) }

  private func move(_ id: String, _ from: Dir, _ to: Dir) -> Bool {
    guard Layout.validId(id) else { return false }
    return Posix.rename(layout.file(from, id), layout.file(to, id)) == nil
  }

  /// Atomic `accepted -> claimed` for exactly one caller, and only if the bytes still hash to `digest`.
  public func claim(id: String, digest: String, bootId: String, nowMs: Int64) throws -> ClaimOutcome {
    guard Layout.validId(id) else { return .notAccepted }
    let from = layout.file(.accepted, id)
    guard let file = try? Data(contentsOf: from), let s = split(file) else { return .notAccepted }
    guard var header = try openHeader(s.sealedHeader, id: id, kind: .record), let sealed = s.sealedPayload else {
      return .notAccepted
    }
    guard let plain = try? Sealing.open(sealed, key: try key(), kind: .record, id: id),
      sha256Hex(plain) == header.digest, header.digest == digest
    else { return .digestMismatch }
    // Exactly one caller wins the rename; the others see ENOENT.
    if Posix.rename(from, layout.file(.claimed, id)) != nil { return .notAccepted }
    try fault("renamedClaimed")
    header.claimBootId = bootId
    let rewritten = try writeTmp(try encode(header, payload: nil, kind: .record))
    if let err = Posix.rename(rewritten, layout.file(.claimed, id)) { throw BridgeError.io("rename \(err)") }
    return .claimed
  }

  /// Writes the result once, moves to `done` and deletes the arguments. False if one exists or the id
  /// is unknown. Allowed from `pending`, `accepted` or `claimed`.
  public func writeResult(id: String, bytes: Data, nowMs: Int64) throws -> Bool {
    try requireId(id)
    guard Posix.exists(layout.file(.ids, id)) else { return false }
    let header = Header(
      v: 1, id: id, size: bytes.count, digest: sha256Hex(bytes), createdAt: nowMs,
      notAfter: nowMs + bridgeResultTtlMs, claimBootId: nil)
    let tmp = try writeTmp(try encode(header, payload: bytes, kind: .result))
    defer { Posix.unlink(tmp) }
    if let err = Posix.link(tmp, layout.file(.results, id)) {
      if err == EEXIST { return false }
      throw BridgeError.io("link \(err)")
    }
    try fault("resultLinked")
    // Forward order covers a concurrent pending -> accepted -> claimed move.
    for dir in [Dir.pending, .accepted, .claimed] { Posix.unlink(layout.file(dir, id)) }
    return true
  }

  public func readResult(id: String, nowMs: Int64) throws -> ResultRead {
    guard Layout.validId(id) else { return .none }
    guard let file = try? Data(contentsOf: layout.file(.results, id)), let s = split(file) else { return .none }
    guard let header = try openHeader(s.sealedHeader, id: id, kind: .result) else { return .purged }
    guard let sealed = s.sealedPayload, nowMs - header.createdAt <= bridgeResultTtlMs else { return .purged }
    guard let plain = try? Sealing.open(sealed, key: try key(), kind: .result, id: id) else { return .purged }
    return .result(plain)
  }

  /// Drops the result payload but keeps the header, so the id still reads as `done`, then `purged`.
  /// Idempotent, a no-op unless the record is done, and needs no key (the sealed header is copied).
  public func ack(id: String) {
    guard Layout.validId(id) else { return }
    stripPayload(layout.file(.results, id))
  }

  /// Rewrites a sealed file as its header only, through `tmp` and an atomic replace.
  @discardableResult
  private func stripPayload(_ url: URL) -> Bool {
    guard let file = try? Data(contentsOf: url), let s = split(file), s.sealedPayload != nil,
      let tmp = try? writeTmp(s.headerOnly)
    else { return false }
    if Posix.rename(tmp, url) != nil {
      Posix.unlink(tmp)
      return false
    }
    return true
  }

  /// Claimed files that still hold arguments (a crash between the claim rename and the rewrite) are
  /// reduced to their header. They carry no `claimBootId`, so recovery sees them as another boot.
  @discardableResult
  public func recoverClaimed() -> Int {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: layout.dir(.claimed).path)) ?? []
    return names.filter { Layout.validId($0) && stripPayload(layout.file(.claimed, $0)) }.count
  }

  /// Ids in a state; `pending` is oldest first by `createdAt` (the processor accepts in that order).
  public func list(_ state: State, nowMs: Int64) throws -> [String] {
    _ = nowMs
    let dir: Dir
    switch state {
    case .pending: dir = .pending
    case .accepted: dir = .accepted
    case .claimed: dir = .claimed
    case .withdrawn: dir = .withdrawn
    case .done: dir = .results
    }
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: layout.dir(dir).path)) ?? [])
      .filter(Layout.validId)
    if state != .pending { return names.sorted() }
    let keyed = try names.compactMap { id -> (Int64, String)? in
      guard let h = try headerOf(.pending, id) else { return nil }
      return (h.createdAt, id)
    }
    return keyed.sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }.map { $0.1 }
  }
}
