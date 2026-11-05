import Foundation

/// Requests/uploads and retained results have independent capacity: completing a request must not
/// compete with the still-pending request pool. Each pool counts encrypted bytes, not JSON estimates.
public let bridgeQueuePoolBytes = 5 * 1024 * 1024
public let bridgeQueuePoolRecords = 16
/// Header-only state and id tombstones also have a finite bound until their normal expiry.
let bridgeQueueMaxIds = 1024

enum QueuePool { case request, result }

extension BridgeStore {
  /// flock is shared across BridgeStore instances and processes. The sibling lock survives reset's
  /// removal of the container, so a reset cannot split writers between two different lock inodes.
  func withQueueLock<T>(_ body: () throws -> T) throws -> T {
    quotaSerial.lock()
    defer { quotaSerial.unlock() }
    if quotaDepth > 0 { return try body() }
    let url = layout.root.appendingPathExtension("queue-lock")
    let fd = open(url.path, O_CREAT | O_RDWR, 0o600)
    guard fd >= 0 else { throw BridgeError.io("queue lock open \(errno)") }
    defer { close(fd) }
    while flock(fd, LOCK_EX) != 0 {
      if errno != EINTR { throw BridgeError.io("queue lock \(errno)") }
    }
    quotaDepth = 1
    defer {
      quotaDepth = 0
      flock(fd, LOCK_UN)
    }
    // Tagged temporary files can only be created while holding this lock. Any left by the
    // previous owner are crash debris; a published hard link/renamed state file remains intact.
    for name in (try? FileManager.default.contentsOfDirectory(atPath: layout.dir(.tmp).path)) ?? [] {
      if name.hasPrefix("request-") || name.hasPrefix("result-") { Posix.unlink(layout.dir(.tmp).appendingPathComponent(name)) }
    }
    return try body()
  }

  func diskBytes(_ url: URL) throws -> Int {
    let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
    guard let number = attrs[.size] as? NSNumber, number.intValue >= 0 else { throw BridgeError.io("queue file size") }
    return number.intValue
  }

  func quotaNames(_ dir: Dir) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: layout.dir(dir).path).filter(Layout.validId)
  }

  func stageReservation(_ begin: StageBegin, sealedBeginBytes: Int) -> Int {
    // All encrypted chunks plus begin, and enough room to replace them with the final sealed
    // record without admitting a second request. stageEnd removes chunks before writing that record.
    begin.size + begin.parts * 28 + sealedBeginBytes + Self.maxHeaderBytes + 32
  }

  func queueUsage(_ pool: QueuePool) throws -> (bytes: Int, count: Int) {
    var bytes = 0
    var count = 0
    let dirs: [Dir] = pool == .request ? [.pending, .accepted, .claimed, .withdrawn] : [.results]
    for dir in dirs {
      for id in try quotaNames(dir) {
        let url = layout.file(dir, id)
        let size = try diskBytes(url)
        bytes += size
        if size > (readHeaderPart(url)?.count ?? 0) { count += 1 }
      }
    }
    if pool == .request {
      for id in try quotaNames(.stage) {
        let dir = stageDir(id)
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
        let actual = try files.reduce(0) { try $0 + diskBytes($1) }
        if let begin = try readBegin(id) {
          bytes += max(actual, stageReservation(begin, sealedBeginBytes: try diskBytes(dir.appendingPathComponent("begin"))))
        } else { bytes += actual }
        count += 1
      }
      // Legacy/unclassified crash debris is charged until the normal temporary-file sweep removes it.
      for name in try FileManager.default.contentsOfDirectory(atPath: layout.dir(.tmp).path) {
        let size = try diskBytes(layout.dir(.tmp).appendingPathComponent(name))
        bytes += size
        if size > 0 { count += 1 }
      }
    }
    return (bytes, count)
  }

  func requireQueueCapacity(_ pool: QueuePool, bytes: Int, newId: String? = nil) throws {
    let usage = try queueUsage(pool)
    guard bytes <= bridgeQueuePoolBytes - usage.bytes, usage.count < bridgeQueuePoolRecords else {
      throw BridgeError.quotaExceeded
    }
    if let id = newId {
      let ids = Set(try quotaNames(.ids) + quotaNames(.stage))
      if !ids.contains(id) && ids.count >= bridgeQueueMaxIds { throw BridgeError.quotaExceeded }
    }
  }
}
