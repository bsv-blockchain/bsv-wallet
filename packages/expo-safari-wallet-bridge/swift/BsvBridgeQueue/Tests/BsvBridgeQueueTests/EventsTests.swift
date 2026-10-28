import XCTest

@testable import BsvBridgeQueue

final class EventsTests: XCTestCase {
  func testEventsListedSortedBySeq() throws {
    let h = try Harness()
    for seq in [10, 2, 33, 4] { try h.store.writeEvent(seq: seq, bytes: utf8("e\(seq)"), nowMs: h.t) }
    let r = try h.store.readEventsAfter(seq: 0, nowMs: h.t)
    XCTAssertEqual(r.events.map { text($0) }, ["e2", "e4", "e10", "e33"])
    XCTAssertFalse(r.gap)
    XCTAssertEqual(try h.store.readEventsAfter(seq: 4, nowMs: h.t).events.map { text($0) }, ["e10", "e33"])
  }

  func testGapTrueWhenCursorOlderThanEvictedThrough() throws {
    let h = try Harness()
    for seq in 1...5 { try h.store.writeEvent(seq: seq, bytes: utf8("e\(seq)"), nowMs: h.t) }
    h.advance(25 * 3_600_000)
    try h.store.writeEvent(seq: 6, bytes: utf8("e6"), nowMs: h.t)
    try h.store.sweep(nowMs: h.t)
    XCTAssertEqual(h.store.evictedThrough, 5)
    let old = try h.store.readEventsAfter(seq: 2, nowMs: h.t)
    XCTAssertTrue(old.gap)
    XCTAssertEqual(old.events.map { text($0) }, ["e6"])
    XCTAssertFalse(try h.store.readEventsAfter(seq: 5, nowMs: h.t).gap)
    // A second process sees the persisted value.
    XCTAssertEqual(try h.restart().evictedThrough, 5)
  }

  func testRetentionCapsAt1024() throws {
    let h = try Harness()
    for seq in 1...1030 { try h.store.writeEvent(seq: seq, bytes: utf8("e"), nowMs: h.t) }
    try h.store.sweep(nowMs: h.t)
    XCTAssertEqual(h.store.evictedThrough, 6)
    let r = try h.store.readEventsAfter(seq: 6, nowMs: h.t)
    XCTAssertEqual(r.events.count, 1024)
    XCTAssertFalse(r.gap)
    XCTAssertTrue(try h.store.readEventsAfter(seq: 0, nowMs: h.t).gap)
  }

  func testUnopenableEventIsAGapNotASkip() throws {
    let h = try Harness()
    try h.store.writeEvent(seq: 1, bytes: utf8("a"), nowMs: h.t)
    try h.store.writeEvent(seq: 2, bytes: utf8("b"), nowMs: h.t)
    try Data("garbage".utf8).write(to: h.root.appendingPathComponent("events/000000000002"))
    let r = try h.store.readEventsAfter(seq: 0, nowMs: h.t)
    XCTAssertTrue(r.gap)
    XCTAssertEqual(r.events.map { text($0) }, ["a"])
  }

  func testEventsAreSealed() throws {
    let h = try Harness()
    try h.store.writeEvent(seq: 1, bytes: utf8(MARKER), nowMs: h.t)
    XCTAssertTrue(h.rawFiles().allSatisfy { !contains($0.bytes, MARKER) })
  }

  func testKeyMissingThrowsOnRead() throws {
    let h = try Harness()
    try h.store.writeEvent(seq: 1, bytes: utf8("a"), nowMs: h.t)
    let other = try BridgeStore(root: h.root, keys: UnavailableKeyProvider())
    XCTAssertThrowsError(try other.readEventsAfter(seq: 0, nowMs: h.t))
    XCTAssertThrowsError(try other.readMirror())
  }
}
