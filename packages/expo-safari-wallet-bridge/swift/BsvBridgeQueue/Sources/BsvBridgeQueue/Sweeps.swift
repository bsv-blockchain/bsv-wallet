import Foundation

public let bridgeTombstoneMs: Int64 = 40 * 60_000

extension BridgeStore {
  /// The `bootId` the app generated at its start (`meta/boot`), nil before `startBoot()`.
  public var bootId: String? {
    guard let d = try? Data(contentsOf: layout.dir(.meta).appendingPathComponent("boot")),
      let s = String(data: d, encoding: .utf8), !s.isEmpty
    else { return nil }
    return s
  }

  /// App only, once per process start: a fresh random UUID, kept in `meta/boot`.
  @discardableResult
  public func startBoot() throws -> String {
    let id = UUID().uuidString.lowercased()
    let tmp = try writeTmp(Data(id.utf8))
    if let err = Posix.rename(tmp, layout.dir(.meta).appendingPathComponent("boot")) {
      Posix.unlink(tmp)
      throw BridgeError.io("rename \(err)")
    }
    return id
  }

  private func names(_ dir: Dir) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: layout.dir(dir).path)) ?? []).filter(Layout.validId)
  }

  private func mtimeMs(_ url: URL) -> Int64? {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date)?.epochMs
  }

  /// App only (on init and on each drain). Throws `keyMissing` when the key is unreadable and
  /// `resetFinal` after `reset()`.
  ///
  /// - results older than 15 min lose their payload (the header stays, so the id still reads as done
  ///   and `readResult` says `purged`); stale arguments of done records are deleted;
  /// - withdrawn files lose any payload left by a crash;
  /// - an id tombstone older than 40 min from its creation is removed with everything left for that
  ///   id (results header, withdrawn header, upload), unless a live record (pending, accepted,
  ///   claimed) still exists, which the processor must resolve first. Orphan tombstones (crash
  ///   between link and rename) go by the same rule;
  /// - upload chunks older than 15 min; events past 1024 or 24 h; stale `tmp` files.
  public func sweep(nowMs: Int64) throws {
    try checkWritable()
    _ = try key()

    for id in names(.results) {
      for dir in [Dir.pending, .accepted, .claimed] { Posix.unlink(layout.file(dir, id)) }
      if let h = try headerOf(.results, id), nowMs - h.createdAt > bridgeResultTtlMs {
        stripPayload(layout.file(.results, id))
      }
    }
    for id in names(.withdrawn) { stripPayload(layout.file(.withdrawn, id)) }

    for id in names(.ids) {
      guard let created = mtimeMs(layout.file(.ids, id)), nowMs - created > bridgeTombstoneMs else { continue }
      if [Dir.pending, .accepted, .claimed].contains(where: { Posix.exists(layout.file($0, id)) }) { continue }
      Posix.unlink(layout.file(.results, id))
      Posix.unlink(layout.file(.withdrawn, id))
      removeStage(id)
      Posix.unlink(layout.file(.ids, id))
    }

    sweepStage(nowMs: nowMs)
    try sweepEvents(nowMs: nowMs)
    sweepTmp()
  }

  private func sweepStage(nowMs: Int64) {
    let fm = FileManager.default
    for id in names(.stage) {
      let dir = stageDir(id)
      let files = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
      let newest = files.compactMap { mtimeMs(dir.appendingPathComponent($0)) }.max()
      if let newest {
        if nowMs - newest > stageChunkTtlMs { removeStage(id) }
      } else if let dirMs = mtimeMs(dir), Date().epochMs - dirMs > stageChunkTtlMs {
        // An empty upload directory is only judged by the real clock: it has no timestamped file.
        removeStage(id)
      }
    }
  }

  /// Files a crashed writer left in `tmp` (real clock: they were never given a bridge time).
  private func sweepTmp() {
    let fm = FileManager.default
    let cutoff = Date().epochMs - 60 * 60_000
    for name in (try? fm.contentsOfDirectory(atPath: layout.dir(.tmp).path)) ?? [] {
      let url = layout.dir(.tmp).appendingPathComponent(name)
      if let m = mtimeMs(url), m < cutoff { Posix.unlink(url) }
    }
  }
}
