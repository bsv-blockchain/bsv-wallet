import CryptoKit
import Foundation

/// What a sealed blob is for. It is bound into the additional authenticated data, so a file cannot be
/// moved to another id or role.
public enum SealKind: Equatable {
  case record, result, event, mirror
  case chunk(Int)

  var label: String {
    switch self {
    case .record: return "record"
    case .result: return "result"
    case .event: return "event"
    case .mirror: return "mirror"
    case .chunk(let n): return "chunk:\(n)"
    }
  }
}

public enum Sealing {
  /// `"bsv-bridge/v1|" + kind + "|" + id`.
  public static func aad(kind: SealKind, id: String) -> Data {
    Data("bsv-bridge/v1|\(kind.label)|\(id)".utf8)
  }

  /// AES-256-GCM with a fresh random 96-bit nonce per call, stored `nonce || ciphertext || tag`.
  public static func seal(_ plaintext: Data, key: SymmetricKey, kind: SealKind, id: String) throws -> Data {
    let box = try AES.GCM.seal(plaintext, using: key, nonce: AES.GCM.Nonce(), authenticating: aad(kind: kind, id: id))
    guard let combined = box.combined else { throw BridgeError.io("seal") }
    return combined
  }

  /// Throws on a wrong key, id or kind, a flipped byte, or a truncated blob.
  public static func open(_ sealed: Data, key: SymmetricKey, kind: SealKind, id: String) throws -> Data {
    let box = try AES.GCM.SealedBox(combined: sealed)
    return try AES.GCM.open(box, using: key, authenticating: aad(kind: kind, id: id))
  }
}
