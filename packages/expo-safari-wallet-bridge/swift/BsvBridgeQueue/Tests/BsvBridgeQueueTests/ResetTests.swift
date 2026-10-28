import XCTest

@testable import BsvBridgeQueue

final class ResetTests: XCTestCase {
  func testResetRemovesEverythingAndLaterWritesThrowResetFinal() throws {
    let keys = ResettableKeyProvider()
    let h = try Harness(keys: keys)
    _ = try h.create(1, MARKER)
    try h.store.writeEvent(seq: 1, bytes: utf8("e"), nowMs: h.t)
    try h.store.writeMirror(utf8("m"))
    _ = try h.store.startBoot()
    h.store.reset()

    XCTAssertFalse(FileManager.default.fileExists(atPath: h.root.path))
    func final(_ f: () throws -> Void, _ line: UInt = #line) {
      XCTAssertThrowsError(try f(), line: line) { XCTAssertEqual($0 as? BridgeError, .resetFinal, line: line) }
    }
    final { _ = try h.create(2, "x") }
    final { try h.store.writeMirror(utf8("m")) }
    final { try h.store.writeEvent(seq: 2, bytes: utf8("e"), nowMs: h.t) }
    final { _ = try h.result(1, "r") }
    final { _ = try h.store.stage(id: ID(5), bytes: utf8("x"), nowMs: h.t) }
    final { try h.store.stageBegin(id: ID(6), parts: 1, size: 1, digest: digest("x"), nowMs: h.t) }
    final { _ = try h.store.startBoot() }
    final { try h.store.sweep(nowMs: h.t) }
    XCTAssertFalse(h.store.accept(id: ID(1)))
    XCTAssertFalse(FileManager.default.fileExists(atPath: h.root.path), "nothing was recreated")

    // The next init lifts it.
    try h.store.reopen()
    XCTAssertTrue(try h.create(1, "fresh"))
  }

  func testAFreshInitAfterResetCreatesANewKeyAndOldFilesAreUnreadableNoise() throws {
    let keys = ResettableKeyProvider()
    let h = try Harness(keys: keys)
    _ = try h.create(1, MARKER)
    try h.store.writeMirror(utf8("m"))
    try h.store.writeEvent(seq: 1, bytes: utf8("e"), nowMs: h.t)
    let oldRecord = try Data(contentsOf: pendingFile(h, 1))
    let oldMirror = try Data(contentsOf: h.root.appendingPathComponent("meta/mirror.sealed"))
    let oldEvent = try Data(contentsOf: h.root.appendingPathComponent("events/000000000001"))
    h.store.reset()

    let fresh = try BridgeStore(root: h.root, keys: keys)
    // A file that survived (or was put back) is noise under the new key.
    try oldRecord.write(to: pendingFile(h, 1))
    try oldMirror.write(to: h.root.appendingPathComponent("meta/mirror.sealed"))
    try oldEvent.write(to: h.root.appendingPathComponent("events/000000000001"))
    XCTAssertNil(try fresh.stat(id: ID(1)))
    XCTAssertNil(try fresh.read(id: ID(1)))
    XCTAssertEqual(try fresh.list(.pending, nowMs: h.t), [])
    XCTAssertEqual(try fresh.readMirror(), .corrupt)
    XCTAssertTrue(try fresh.readEventsAfter(seq: 0, nowMs: h.t).gap)
    XCTAssertTrue(try fresh.create(id: ID(1), bytes: utf8("new"), nowMs: h.t))
  }
}
