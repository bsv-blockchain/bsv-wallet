import Foundation
import XCTest

@testable import BsvBridgeQueue

private struct Crash: Error {}

final class CrashTests: XCTestCase {
  func crash(_ h: Harness, after step: String) {
    h.store.faultAfter = { if $0 == step { throw Crash() } }
  }

  func testCrashBetweenLinkAndRenameLeavesAnUnusableTombstoneAndNoRecord() throws {
    let h = try Harness()
    crash(h, after: "linked")
    XCTAssertThrowsError(try h.create(1, "a")) { XCTAssertTrue($0 is Crash) }
    let next = try h.restart()
    XCTAssertNil(try next.stat(id: ID(1)))
    XCTAssertNil(try next.read(id: ID(1)))
    XCTAssertEqual(try next.list(.pending, nowMs: h.t), [])
    XCTAssertTrue(FileManager.default.fileExists(atPath: h.root.appendingPathComponent("ids/\(ID(1))").path))
    XCTAssertFalse(try h.create(1, "a"))
  }

  func testCrashBetweenClaimRenameAndRewriteIsRecoveredAsOtherBootWithArgumentsStripped() throws {
    let h = try Harness()
    let body = #"{"args":"\#(MARKER)"}"#
    _ = try h.create(1, body)
    _ = h.store.accept(id: ID(1))
    crash(h, after: "renamedClaimed")
    XCTAssertThrowsError(try h.claim(1, body)) { XCTAssertTrue($0 is Crash) }

    let next = try h.restart()
    // Claimed, never stamped, and the arguments are unreachable through the API.
    XCTAssertEqual(try next.stat(id: ID(1)), StatResult(size: body.utf8.count, state: .claimed, claimBootId: nil))
    XCTAssertNil(try next.read(id: ID(1)))
    let file = h.root.appendingPathComponent("claimed/\(ID(1))")
    let before = try Data(contentsOf: file).count
    XCTAssertEqual(next.recoverClaimed(), 1)
    XCTAssertEqual(next.recoverClaimed(), 0)
    XCTAssertEqual(try next.stat(id: ID(1)), StatResult(size: body.utf8.count, state: .claimed, claimBootId: nil))
    // The claimed file is now a bare header: the sealed payload (plaintext length + nonce + tag) is gone.
    XCTAssertEqual(before - (try Data(contentsOf: file).count), body.utf8.count + 12 + 16)
    XCTAssertEqual(try next.claim(id: ID(1), digest: digest(body), bootId: h.bootId, nowMs: h.t), .notAccepted)
  }

  func testCrashBetweenResultLinkAndPayloadDeleteReportsDone() throws {
    let h = try Harness()
    _ = try h.create(1, "args")
    crash(h, after: "resultLinked")
    XCTAssertThrowsError(try h.result(1, "r")) { XCTAssertTrue($0 is Crash) }
    let next = try h.restart()
    XCTAssertEqual(try next.stat(id: ID(1))?.state, .done)
    XCTAssertNil(try next.read(id: ID(1)))
    XCTAssertEqual(try h.readResult(1), .result(utf8("r")))
    XCTAssertFalse(try h.result(1, "again"))
    XCTAssertEqual(try next.list(.done, nowMs: h.t), [ID(1)])
  }

  func testCrashAfterRenamedPendingStillHasAUsableRecord() throws {
    let h = try Harness()
    crash(h, after: "renamedPending")
    XCTAssertThrowsError(try h.create(1, "a"))
    XCTAssertEqual(try h.restart().list(.pending, nowMs: h.t), [ID(1)])
  }
}
