import Foundation

public enum StageStatus: Equatable { case created, exists }

public enum StageError: Error, Equatable {
  /// The id is taken by a record (or an upload) with another digest.
  case existsDifferent
  case notBegun
  case missingChunk(Int)
  case badLength
  case badDigest
  case badArguments
}

public let stageMaxParts = 1024
public let stageMaxBytes = 8 * 1024 * 1024
public let stageMaxChunkBytes = 1024 * 1024
public let stageChunkTtlMs: Int64 = 15 * 60_000

private struct StageBegin: Codable, Equatable {
  var parts: Int
  var size: Int
  var digest: String
}

extension BridgeStore {
  func stageDir(_ id: String) -> URL { layout.dir(.stage).appendingPathComponent(id, isDirectory: true) }

  /// Writes one record. `exists` for a repeat of the same id and digest; a different digest throws.
  /// When the original is already gone (done) the digest is unknown and a repeat reads as `exists`.
  public func stage(id: String, bytes: Data, nowMs: Int64) throws -> StageStatus {
    try requireId(id)
    if try create(id: id, bytes: bytes, nowMs: nowMs) { return .created }
    let digest = sha256Hex(bytes)
    for dir in [Dir.pending, .accepted, .claimed, .withdrawn] {
      if let h = try headerOf(dir, id) {
        if h.digest != digest { throw StageError.existsDifferent }
        break
      }
    }
    return .exists
  }

  public func stageBegin(id: String, parts: Int, size: Int, digest: String, nowMs: Int64 = SystemClock().nowMs) throws {
    try requireId(id)
    try checkWritable()
    guard parts >= 1, parts <= stageMaxParts, size >= 0, size <= stageMaxBytes, digest.count == 64 else {
      throw StageError.badArguments
    }
    let begin = StageBegin(parts: parts, size: size, digest: digest)
    let dir = stageDir(id)
    if let existing = try readBegin(id) {
      if existing != begin { throw StageError.existsDifferent }
      return
    }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    layout.applyAttributes(dir)
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    let sealed = try Sealing.seal(try enc.encode(begin), key: try key(), kind: .chunk(-1), id: id)
    try linkStageFile(sealed, to: dir.appendingPathComponent("begin"), nowMs: nowMs)
  }

  /// Sealed on arrival (no plaintext touches disk); idempotent by `(id, n)`.
  public func stageChunk(id: String, n: Int, bytes: Data, nowMs: Int64 = SystemClock().nowMs) throws {
    try requireId(id)
    try checkWritable()
    guard let begin = try readBegin(id) else { throw StageError.notBegun }
    guard n >= 0, n < begin.parts, bytes.count <= stageMaxChunkBytes else { throw StageError.badArguments }
    let sealed = try Sealing.seal(bytes, key: try key(), kind: .chunk(n), id: id)
    try linkStageFile(sealed, to: stageDir(id).appendingPathComponent(String(n)), nowMs: nowMs)
  }

  /// Unseals and joins the chunks, checks length and digest, re-seals as a record and runs `create`.
  /// A failed check removes the upload and creates nothing. A repeat after success (no upload left,
  /// the id already used) is `exists`.
  public func stageEnd(id: String, nowMs: Int64) throws -> StageStatus {
    try requireId(id)
    try checkWritable()
    guard let begin = try readBegin(id) else {
      if Posix.exists(layout.file(.ids, id)) { return .exists }
      throw StageError.notBegun
    }
    let k = try key()
    var joined = Data()
    for n in 0..<begin.parts {
      guard let file = try? Data(contentsOf: stageDir(id).appendingPathComponent(String(n))) else {
        throw StageError.missingChunk(n)
      }
      guard let plain = try? Sealing.open(file, key: k, kind: .chunk(n), id: id) else {
        removeStage(id)
        throw StageError.badDigest
      }
      joined.append(plain)
    }
    guard joined.count == begin.size else {
      removeStage(id)
      throw StageError.badLength
    }
    guard sha256Hex(joined) == begin.digest else {
      removeStage(id)
      throw StageError.badDigest
    }
    let status = try stage(id: id, bytes: joined, nowMs: nowMs)
    removeStage(id)
    return status
  }

  func removeStage(_ id: String) { try? FileManager.default.removeItem(at: stageDir(id)) }

  private func readBegin(_ id: String) throws -> StageBegin? {
    guard let file = try? Data(contentsOf: stageDir(id).appendingPathComponent("begin")) else { return nil }
    guard let plain = try? Sealing.open(file, key: try key(), kind: .chunk(-1), id: id),
      let begin = try? JSONDecoder().decode(StageBegin.self, from: plain)
    else { return nil }
    return begin
  }

  /// `tmp` write, modification time set to the caller's clock (the sweep ages chunks by it), then an
  /// exclusive `link`; an existing file means an earlier identical call won.
  private func linkStageFile(_ sealed: Data, to dest: URL, nowMs: Int64) throws {
    let tmp = try writeTmp(sealed)
    defer { Posix.unlink(tmp) }
    try? FileManager.default.setAttributes([.modificationDate: Date.fromMs(nowMs)], ofItemAtPath: tmp.path)
    if let err = Posix.link(tmp, dest), err != EEXIST { throw BridgeError.io("link \(err)") }
  }
}
