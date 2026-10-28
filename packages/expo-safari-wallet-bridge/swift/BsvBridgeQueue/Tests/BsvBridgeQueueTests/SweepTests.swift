import XCTest

@testable import BsvBridgeQueue

final class SweepTests: XCTestCase {
  private let min: Int64 = 60_000

  func testSweepPurgesResultsAt15MinButKeepsTheTombstoneUntil40Min() throws {
    let h = try Harness()
    _ = try h.create(1, "a")
    XCTAssertTrue(try h.result(1, MARKER))
    try h.store.sweep(nowMs: h.t + 14 * min)
    XCTAssertEqual(try h.store.readResult(id: ID(1), nowMs: h.t + 14 * min), .result(utf8(MARKER)))

    h.advance(15 * min + 1)
    try h.store.sweep(nowMs: h.t)
    XCTAssertEqual(try h.readResult(1), .purged)
    XCTAssertEqual(try h.store.stat(id: ID(1))?.state, .done)
    XCTAssertFalse(try h.create(1, "a"))

    h.advance(24 * min)  // 39 min 59 s... plus 1 ms: still inside 40 min
    try h.store.sweep(nowMs: h.t)
    XCTAssertFalse(try h.create(1, "a"))

    h.advance(2 * min)
    try h.store.sweep(nowMs: h.t)
    XCTAssertNil(try h.store.stat(id: ID(1)))
    XCTAssertTrue(try h.create(1, "a"))
  }

  func testSweepDeletesStaleArgumentsOfADoneRecord() throws {
    let h = try Harness()
    _ = try h.create(1, MARKER)
    h.store.faultAfter = { if $0 == "resultLinked" { throw NSError(domain: "crash", code: 1) } }
    XCTAssertThrowsError(try h.result(1, "r"))
    h.store.faultAfter = nil
    XCTAssertTrue(Posix.exists(pendingFile(h, 1)))
    XCTAssertEqual(try h.store.stat(id: ID(1))?.state, .done)
    try h.store.sweep(nowMs: h.t)
    XCTAssertFalse(Posix.exists(pendingFile(h, 1)))
    XCTAssertTrue(h.rawFiles().allSatisfy { !contains($0.bytes, MARKER) })
  }

  func testSweepRemovesOrphanTombstonesAndOldChunksAndKeepsLiveRecords() throws {
    let h = try Harness()
    h.store.faultAfter = { if $0 == "linked" { throw NSError(domain: "crash", code: 1) } }
    XCTAssertThrowsError(try h.create(1, "a"))
    h.store.faultAfter = nil
    _ = try h.create(2, "live")
    try h.store.stageBegin(id: ID(3), parts: 2, size: 4, digest: digest("abcd"), nowMs: h.t)
    try h.store.stageChunk(id: ID(3), n: 0, bytes: utf8("ab"), nowMs: h.t)

    try h.store.sweep(nowMs: h.t + 14 * min)
    XCTAssertTrue(Posix.exists(h.root.appendingPathComponent("stage/\(ID(3))")))

    try h.store.sweep(nowMs: h.t + 16 * min)
    XCTAssertFalse(Posix.exists(h.root.appendingPathComponent("stage/\(ID(3))")))
    XCTAssertTrue(Posix.exists(h.root.appendingPathComponent("ids/\(ID(1))")))

    try h.store.sweep(nowMs: h.t + 41 * min)
    XCTAssertFalse(Posix.exists(h.root.appendingPathComponent("ids/\(ID(1))")))
    // A record nobody resolved yet is the processor's to expire; its tombstone stays.
    XCTAssertTrue(Posix.exists(h.root.appendingPathComponent("ids/\(ID(2))")))
    XCTAssertEqual(try h.store.stat(id: ID(2))?.state, .pending)
  }

  func testSweepStripsAWithdrawnFileLeftWithArguments() throws {
    let h = try Harness()
    _ = try h.create(1, MARKER)
    try FileManager.default.moveItem(at: pendingFile(h, 1), to: h.root.appendingPathComponent("withdrawn/\(ID(1))"))
    try h.store.sweep(nowMs: h.t)
    XCTAssertTrue(h.rawFiles().allSatisfy { !contains($0.bytes, MARKER) })
    XCTAssertEqual(try h.store.stat(id: ID(1))?.state, .withdrawn)
  }
}
