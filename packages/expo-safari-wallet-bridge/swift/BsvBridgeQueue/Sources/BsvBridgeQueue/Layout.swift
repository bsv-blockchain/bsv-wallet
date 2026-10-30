import Foundation

/// File protection applied to the container directory and every file in it, at every launch of
/// either process. The default is `completeUntilFirstUserAuthentication`, so a handler woken before
/// the first unlock fails cleanly instead of reading garbage. `.none` exists for hosts that cannot
/// set a protection class.
public enum ProtectionClass {
  case untilFirstUserAuthentication
  case none
}

/// The record states. State is where the file is (spec 6.4).
public enum State: String, CaseIterable {
  case pending, accepted, claimed, withdrawn, done
}

enum Dir: String, CaseIterable {
  case tmp, ids, pending, accepted, claimed, withdrawn, results, events, meta, stage
}

enum Posix {
  /// `errno` of a failed call, or nil on success.
  static func link(_ from: URL, _ to: URL) -> Int32? {
    Foundation.link(from.path, to.path) == 0 ? nil : errno
  }

  static func rename(_ from: URL, _ to: URL) -> Int32? {
    Foundation.rename(from.path, to.path) == 0 ? nil : errno
  }

  @discardableResult
  static func unlink(_ url: URL) -> Int32? {
    Foundation.unlink(url.path) == 0 ? nil : errno
  }

  static func exists(_ url: URL) -> Bool {
    var st = stat()
    return lstat(url.path, &st) == 0
  }

  /// `O_CREAT|O_EXCL` write with `fsync`, mode 0600.
  static func writeExclusive(_ url: URL, _ data: Data) throws {
    let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard fd >= 0 else { throw BridgeError.io("open \(errno)") }
    defer { close(fd) }
    var offset = 0
    try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
      while offset < data.count {
        let n = write(fd, buf.baseAddress!.advanced(by: offset), data.count - offset)
        if n < 0 {
          if errno == EINTR { continue }
          throw BridgeError.io("write \(errno)")
        }
        offset += n
      }
    }
    guard fsync(fd) == 0 else { throw BridgeError.io("fsync \(errno)") }
  }
}

struct Layout {
  let root: URL
  let protection: ProtectionClass

  func dir(_ d: Dir) -> URL { root.appendingPathComponent(d.rawValue, isDirectory: true) }
  func file(_ d: Dir, _ id: String) -> URL { dir(d).appendingPathComponent(id, isDirectory: false) }
  func tmpFile() -> URL { dir(.tmp).appendingPathComponent(UUID().uuidString, isDirectory: false) }

  /// Ids become file names: no separators, no dots, bounded length.
  static func validId(_ id: String) -> Bool {
    guard !id.isEmpty, id.utf8.count <= 64 else { return false }
    return id.utf8.allSatisfy { c in
      (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x2D || c == 0x5F
    }
  }

  func createDirectories() throws {
    let fm = FileManager.default
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    for d in Dir.allCases { try fm.createDirectory(at: dir(d), withIntermediateDirectories: true) }
    applyAttributes(root)
    for d in Dir.allCases { applyAttributes(dir(d)) }
  }

  /// Re-applies the attributes to everything already on disk (both processes do this at every open).
  func applyAttributesToTree() {
    applyAttributes(root)
    guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return }
    for case let url as URL in e { applyAttributes(url) }
  }

  /// `isExcludedFromBackup` and the protection class. Failures are ignored: a file must still work on
  /// a volume that does not support them.
  func applyAttributes(_ url: URL) {
    var u = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? u.setResourceValues(values)
    #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
      if protection == .untilFirstUserAuthentication {
        try? FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
      }
    #endif
  }
}
