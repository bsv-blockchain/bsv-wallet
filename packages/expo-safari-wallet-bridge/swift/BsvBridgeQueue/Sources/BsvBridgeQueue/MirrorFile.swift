import Foundation

public enum MirrorRead: Equatable {
  case ok(Data)
  /// No mirror file: the app never wrote one, or it was reset.
  case absent
  /// Torn, truncated, sealed under another key, or garbage. Callers treat it exactly like `absent`
  /// (no announce, no local answers, epochs closed `lost`), never as a stale answer.
  case corrupt

  /// The plaintext, or nil for both `absent` and `corrupt`.
  public var usable: Data? {
    if case .ok(let d) = self { return d }
    return nil
  }
}

extension BridgeStore {
  static let mirrorId = "mirror"

  var mirrorURL: URL { layout.dir(.meta).appendingPathComponent("mirror.sealed") }

  /// Seals `meta/mirror.sealed` and replaces it atomically (`rename(2)` over the old file), so a
  /// concurrent reader sees the old file or the new one, never a mix.
  public func writeMirror(_ bytes: Data) throws {
    let sealed = try Sealing.seal(bytes, key: try key(), kind: .mirror, id: Self.mirrorId)
    let tmp = try writeTmp(sealed)
    if let err = Posix.rename(tmp, mirrorURL) {
      Posix.unlink(tmp)
      throw BridgeError.io("rename \(err)")
    }
  }

  /// Throws only when the key is unreadable (the extension answers `CONFIGURATION_ERROR`).
  public func readMirror() throws -> MirrorRead {
    let k = try key()
    guard Posix.exists(mirrorURL) else { return .absent }
    guard let file = try? Data(contentsOf: mirrorURL),
      let plain = try? Sealing.open(file, key: k, kind: .mirror, id: Self.mirrorId)
    else { return .corrupt }
    return .ok(plain)
  }
}
