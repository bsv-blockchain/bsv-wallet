import Foundation
import XCTest

@testable import BsvBridgeQueue

final class MarkerTests: XCTestCase {
  func testNoFileUnderTheContainerContainsThePlaintextMarkerEveryState() throws {
    let h = try Harness()
    let body = #"{"args":"\#(MARKER)"}"#
    _ = try h.create(1, body)  // pending
    _ = try h.create(2, body)
    _ = h.store.accept(id: ID(2))  // accepted
    _ = try h.create(3, body)
    _ = h.store.accept(id: ID(3))
    _ = try h.claim(3, body)  // claimed
    _ = try h.create(4, body)
    _ = h.store.withdraw(id: ID(4))  // withdrawn
    _ = try h.create(5, body)
    _ = try h.result(5, #"{"result":"\#(MARKER)"}"#)  // done, payload present
    _ = try h.create(6, body)
    _ = try h.result(6, #"{"result":"\#(MARKER)"}"#)
    h.store.ack(id: ID(6))  // done, acknowledged

    let files = h.rawFiles()
    XCTAssertGreaterThanOrEqual(files.filter { !$0.bytes.isEmpty }.count, 6)
    let leaks = files.filter { contains($0.bytes, MARKER) }.map { $0.path }
    XCTAssertEqual(leaks, [])
    // The check can fail: it sees the marker when one is present.
    XCTAssertTrue(contains(utf8(body), MARKER))
    // File and directory names carry only ids.
    XCTAssertFalse(files.contains { $0.path.contains("PLAINTEXT") })
  }
}
