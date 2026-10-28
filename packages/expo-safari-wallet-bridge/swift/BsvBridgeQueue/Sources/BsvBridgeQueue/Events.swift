import Foundation

public let bridgeMaxEvents = 1024
public let bridgeEventMaxAgeMs: Int64 = 24 * 3_600_000

extension BridgeStore {
  static func eventName(_ seq: Int) -> String { String(format: "%012d", seq) }

  /// The highest `closeSeq` the app has trimmed (0 when none). Persisted in `meta/evicted`.
  public var evictedThrough: Int {
    guard let d = try? Data(contentsOf: layout.dir(.meta).appendingPathComponent("evicted")),
      let s = String(data: d, encoding: .utf8), let n = Int(s)
    else { return 0 }
    return n
  }

  func setEvictedThrough(_ n: Int) throws {
    guard n > evictedThrough else { return }
    let tmp = try writeTmp(Data(String(n).utf8))
    if let err = Posix.rename(tmp, layout.dir(.meta).appendingPathComponent("evicted")) {
      Posix.unlink(tmp)
      throw BridgeError.io("rename \(err)")
    }
  }

  /// One sealed file per close event, named by its zero-padded `closeSeq`, written through `tmp` and
  /// renamed (so a reader never sees half an event). Rewriting a seq replaces the file.
  public func writeEvent(seq: Int, bytes: Data, nowMs: Int64) throws {
    guard seq >= 0 else { throw BridgeError.invalidId }
    let name = Self.eventName(seq)
    let header = Header(
      v: 1, id: name, size: bytes.count, digest: sha256Hex(bytes), createdAt: nowMs,
      notAfter: nowMs + bridgeEventMaxAgeMs, claimBootId: nil)
    let tmp = try writeTmp(try encode(header, payload: bytes, kind: .event))
    if let err = Posix.rename(tmp, layout.file(.events, name)) {
      Posix.unlink(tmp)
      throw BridgeError.io("rename \(err)")
    }
  }

  func eventSeqs() -> [Int] {
    ((try? FileManager.default.contentsOfDirectory(atPath: layout.dir(.events).path)) ?? [])
      .compactMap { name in name.count == 12 ? Int(name) : nil }
      .sorted()
  }

  private func openEvent(_ seq: Int) throws -> (header: Header, bytes: Data)? {
    let name = Self.eventName(seq)
    guard let file = try? Data(contentsOf: layout.file(.events, name)), let s = split(file),
      let header = try openHeader(s.sealedHeader, id: name, kind: .event), let sealed = s.sealedPayload,
      let plain = try? Sealing.open(sealed, key: try key(), kind: .event, id: name)
    else { return nil }
    return (header, plain)
  }

  /// Events with `seq` greater than the cursor, oldest first. `gap` is true when the cursor is older
  /// than `evictedThrough`, or when an event file cannot be opened (a lost event is a gap, never a
  /// silent skip); a reader that sees `gap` closes every epoch it holds. Throws only for a missing key.
  public func readEventsAfter(seq: Int, nowMs: Int64) throws -> (events: [Data], gap: Bool) {
    _ = nowMs
    var gap = seq < evictedThrough
    var out: [Data] = []
    for s in eventSeqs() where s > seq {
      if let e = try openEvent(s) { out.append(e.bytes) } else { gap = true }
    }
    return (out, gap)
  }

  /// Trims to at most `bridgeMaxEvents` and `bridgeEventMaxAgeMs`, whichever trims more, and records
  /// the highest trimmed seq.
  func sweepEvents(nowMs: Int64) throws {
    var seqs = eventSeqs()
    var highest = 0
    var drop: Set<Int> = []
    for s in seqs {
      let name = Self.eventName(s)
      // An event that cannot be opened (foreign key, torn) is dropped as old: nothing can use it.
      let createdAt = (try? headerOf(.events, name, kind: .event))?.createdAt
      if createdAt == nil || nowMs - createdAt! > bridgeEventMaxAgeMs { drop.insert(s) }
    }
    seqs = seqs.filter { !drop.contains($0) }
    if seqs.count > bridgeMaxEvents { seqs.prefix(seqs.count - bridgeMaxEvents).forEach { drop.insert($0) } }
    guard let top = drop.max() else { return }
    highest = top
    // Record first: a crash after this only over-reports a gap, never hides one.
    try setEvictedThrough(highest)
    for s in drop { Posix.unlink(layout.file(.events, Self.eventName(s))) }
  }
}
