import XCTest

@testable import BsvBridgeQueue

final class StagingTests: XCTestCase {
  private func record(_ n: Int, pad: Int = 0) -> String {
    #"{"args":"\#(MARKER)\#(String(repeating: "x", count: pad))","n":\#(n)}"#
  }

  func testChunkedStageOf3ChunksEqualsOneStage() throws {
    let h = try Harness()
    let bytes = utf8(record(1, pad: 90))
    let third = bytes.count / 3
    let parts = [bytes.prefix(third), bytes.dropFirst(third).prefix(third), bytes.dropFirst(2 * third)].map { Data($0) }
    try h.store.stageBegin(id: ID(1), parts: 3, size: bytes.count, digest: sha256Hex(bytes), nowMs: h.t)
    for (i, p) in parts.enumerated() { try h.store.stageChunk(id: ID(1), n: i, bytes: p, nowMs: h.t) }
    XCTAssertEqual(try h.store.stageEnd(id: ID(1), nowMs: h.t), .created)

    XCTAssertEqual(try h.store.stage(id: ID(2), bytes: bytes, nowMs: h.t), .created)
    XCTAssertEqual(try h.store.read(id: ID(1)), try h.store.read(id: ID(2)))
    XCTAssertEqual(try h.store.stat(id: ID(1)), try h.store.stat(id: ID(2)))
    XCTAssertEqual(try h.store.list(.pending, nowMs: h.t), [ID(1), ID(2)])
    XCTAssertFalse(FileManager.default.fileExists(atPath: h.root.appendingPathComponent("stage/\(ID(1))").path))
    // No plaintext on disk at any point.
    XCTAssertTrue(h.rawFiles().allSatisfy { !contains($0.bytes, MARKER) })
    // A lost callback: stageEnd again is exists.
    XCTAssertEqual(try h.store.stageEnd(id: ID(1), nowMs: h.t), .exists)
  }

  func testChunksAreSealedOnArrival() throws {
    let h = try Harness()
    let bytes = utf8(record(1))
    try h.store.stageBegin(id: ID(1), parts: 1, size: bytes.count, digest: sha256Hex(bytes), nowMs: h.t)
    try h.store.stageChunk(id: ID(1), n: 0, bytes: bytes, nowMs: h.t)
    XCTAssertFalse(h.rawFiles().isEmpty)
    XCTAssertTrue(h.rawFiles().allSatisfy { !contains($0.bytes, MARKER) })
  }

  func testRepeatChunkIsIdempotent() throws {
    let h = try Harness()
    let bytes = utf8(record(1))
    try h.store.stageBegin(id: ID(1), parts: 2, size: bytes.count, digest: sha256Hex(bytes), nowMs: h.t)
    try h.store.stageBegin(id: ID(1), parts: 2, size: bytes.count, digest: sha256Hex(bytes), nowMs: h.t)
    let a = Data(bytes.prefix(10)), b = Data(bytes.dropFirst(10))
    try h.store.stageChunk(id: ID(1), n: 0, bytes: a, nowMs: h.t)
    try h.store.stageChunk(id: ID(1), n: 0, bytes: a, nowMs: h.t)
    try h.store.stageChunk(id: ID(1), n: 1, bytes: b, nowMs: h.t)
    try h.store.stageChunk(id: ID(1), n: 1, bytes: b, nowMs: h.t)
    XCTAssertEqual(try h.store.stageEnd(id: ID(1), nowMs: h.t), .created)
    XCTAssertEqual(try h.store.read(id: ID(1)), bytes)
  }

  func testStageEndWithABadDigestThrowsAndLeavesNothingPending() throws {
    let h = try Harness()
    let bytes = utf8(record(1))
    try h.store.stageBegin(id: ID(1), parts: 1, size: bytes.count, digest: sha256Hex(utf8("other")), nowMs: h.t)
    try h.store.stageChunk(id: ID(1), n: 0, bytes: bytes, nowMs: h.t)
    XCTAssertThrowsError(try h.store.stageEnd(id: ID(1), nowMs: h.t)) {
      XCTAssertEqual($0 as? StageError, .badDigest)
    }
    XCTAssertEqual(try h.store.list(.pending, nowMs: h.t), [])
    XCTAssertNil(try h.store.stat(id: ID(1)))
    XCTAssertFalse(Posix.exists(h.root.appendingPathComponent("ids/\(ID(1))")))
    // Wrong length and a missing chunk.
    try h.store.stageBegin(id: ID(2), parts: 1, size: bytes.count + 1, digest: sha256Hex(bytes), nowMs: h.t)
    try h.store.stageChunk(id: ID(2), n: 0, bytes: bytes, nowMs: h.t)
    XCTAssertThrowsError(try h.store.stageEnd(id: ID(2), nowMs: h.t)) { XCTAssertEqual($0 as? StageError, .badLength) }
    try h.store.stageBegin(id: ID(3), parts: 2, size: bytes.count, digest: sha256Hex(bytes), nowMs: h.t)
    XCTAssertThrowsError(try h.store.stageEnd(id: ID(3), nowMs: h.t)) {
      XCTAssertEqual($0 as? StageError, .missingChunk(0))
    }
    XCTAssertThrowsError(try h.store.stageChunk(id: ID(4), n: 0, bytes: bytes, nowMs: h.t)) {
      XCTAssertEqual($0 as? StageError, .notBegun)
    }
  }

  func testRepeatStageSameDigestIsExistsOtherDigestThrows() throws {
    let h = try Harness()
    XCTAssertEqual(try h.store.stage(id: ID(1), bytes: utf8("a"), nowMs: h.t), .created)
    XCTAssertEqual(try h.store.stage(id: ID(1), bytes: utf8("a"), nowMs: h.t), .exists)
    XCTAssertThrowsError(try h.store.stage(id: ID(1), bytes: utf8("b"), nowMs: h.t)) {
      XCTAssertEqual($0 as? StageError, .existsDifferent)
    }
    // Still the same after the app accepted and claimed it.
    _ = h.store.accept(id: ID(1))
    XCTAssertEqual(try h.store.stage(id: ID(1), bytes: utf8("a"), nowMs: h.t), .exists)
    XCTAssertEqual(try h.claim(1, "a"), .claimed)
    XCTAssertEqual(try h.store.stage(id: ID(1), bytes: utf8("a"), nowMs: h.t), .exists)
    XCTAssertThrowsError(try h.store.stage(id: ID(1), bytes: utf8("b"), nowMs: h.t))
  }

  func testWithdrawLosesToAPriorAcceptAndWinsAgainstAPendingRecord() throws {
    let h = try Harness()
    _ = try h.create(1, MARKER)
    _ = try h.create(2, MARKER)
    XCTAssertTrue(h.store.accept(id: ID(1)))
    XCTAssertFalse(h.store.withdraw(id: ID(1)))
    XCTAssertEqual(try h.store.stat(id: ID(1))?.state, .accepted)
    XCTAssertTrue(h.store.withdraw(id: ID(2)))
    XCTAssertFalse(h.store.accept(id: ID(2)))
    XCTAssertEqual(try h.store.stat(id: ID(2))?.state, .withdrawn)
    XCTAssertEqual(try h.store.list(.withdrawn, nowMs: h.t), [ID(2)])
    // Header only: the arguments are gone, the size is still known.
    XCTAssertTrue(h.rawFiles().filter { $0.path.hasPrefix("/withdrawn/") }.allSatisfy { !contains($0.bytes, MARKER) })
    XCTAssertEqual(try h.store.stat(id: ID(2))?.size, MARKER.utf8.count)
    XCTAssertNil(try h.store.read(id: ID(2)))
    // The id stays used.
    XCTAssertFalse(try h.create(2, "again"))
  }
}
