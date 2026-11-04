import Foundation
import XCTest

@testable import BsvBridgeQueue

final class QuotaTests: XCTestCase {
  private let mib = 1024 * 1024

  func testRetainedPayloadsStayChargedAcrossStoresAndFailedWithdrawal() throws {
    let h = try Harness()
    let bytes = Data(repeating: 65, count: mib)
    for n in 1...4 { XCTAssertTrue(try h.store.create(id: ID(n), bytes: bytes, nowMs: h.t)) }
    XCTAssertThrowsError(try h.store.create(id: ID(5), bytes: bytes, nowMs: h.t)) {
      XCTAssertEqual($0 as? BridgeError, .quotaExceeded)
    }
    XCTAssertTrue(h.store.accept(id: ID(1)))
    XCTAssertFalse(h.store.withdraw(id: ID(1)))
    try h.restart()
    XCTAssertThrowsError(try h.store.create(id: ID(6), bytes: bytes, nowMs: h.t))
    XCTAssertTrue(h.store.withdraw(id: ID(2)))
    XCTAssertTrue(try h.store.create(id: ID(7), bytes: bytes, nowMs: h.t))
    XCTAssertFalse(h.store.withdraw(id: ID(2)))
    XCTAssertThrowsError(try h.store.create(id: ID(8), bytes: bytes, nowMs: h.t))
  }

  func testMultipartReservesCapacityAndTransfersItToPending() throws {
    let h = try Harness()
    let bytes = Data(repeating: 65, count: 2 * mib)
    try h.store.stageBegin(id: ID(1), parts: 2, size: bytes.count, digest: sha256Hex(bytes), nowMs: h.t)
    XCTAssertTrue(try h.store.create(id: ID(2), bytes: bytes, nowMs: h.t))
    XCTAssertThrowsError(try h.store.create(id: ID(3), bytes: bytes, nowMs: h.t))
    try h.store.stageChunk(id: ID(1), n: 0, bytes: Data(bytes.prefix(mib)), nowMs: h.t)
    try h.store.stageChunk(id: ID(1), n: 1, bytes: Data(bytes.suffix(mib)), nowMs: h.t)
    XCTAssertEqual(try h.store.stageEnd(id: ID(1), nowMs: h.t), .created)
    XCTAssertEqual(try h.store.read(id: ID(1)), bytes)
    XCTAssertThrowsError(try h.store.create(id: ID(4), bytes: bytes, nowMs: h.t))
  }

  func testChunksCannotExceedDeclaredReservation() throws {
    let h = try Harness()
    try h.store.stageBegin(id: ID(1), parts: 2, size: 1, digest: digest("a"), nowMs: h.t)
    try h.store.stageChunk(id: ID(1), n: 0, bytes: utf8("a"), nowMs: h.t)
    XCTAssertThrowsError(try h.store.stageChunk(id: ID(1), n: 1, bytes: utf8("b"), nowMs: h.t))
  }

  func testAdmissionExpiresPendingButNeverAcceptedRequests() throws {
    let h = try Harness()
    XCTAssertTrue(try h.create(1, "pending"))
    XCTAssertTrue(try h.create(2, "accepted"))
    XCTAssertTrue(h.store.accept(id: ID(2)))
    h.advance(bridgeValidityMs + 1)
    XCTAssertTrue(try h.create(3, "new admission wakes only native code"))
    XCTAssertEqual(try h.store.stat(id: ID(1))?.state, .withdrawn)
    XCTAssertFalse(h.store.accept(id: ID(1)))
    guard case .result(let reply) = try h.store.readResult(id: ID(1), nowMs: h.t),
          let object = try JSONSerialization.jsonObject(with: reply) as? [String: Any],
          let error = object["error"] as? [String: Any] else {
      return XCTFail("native expiry must finish the waiting page with an explicit not-sent result")
    }
    XCTAssertEqual(error["code"] as? String, "CONNECTION_CLOSED")
    XCTAssertEqual(error["delivery"] as? String, "not-sent")
    XCTAssertEqual(try h.store.stat(id: ID(2))?.state, .accepted)
    XCTAssertFalse(try h.create(1, "replay"))
  }

  func testResultCapacityIsSeparateAndBounded() throws {
    let h = try Harness()
    let bytes = Data(repeating: 65, count: mib)
    for n in 1...4 {
      XCTAssertTrue(try h.create(n, "request"))
      XCTAssertTrue(try h.store.writeResult(id: ID(n), bytes: bytes, nowMs: h.t))
    }
    XCTAssertTrue(try h.store.create(id: ID(5), bytes: Data(repeating: 66, count: 4 * mib), nowMs: h.t))
    XCTAssertThrowsError(try h.store.writeResult(id: ID(5), bytes: bytes, nowMs: h.t))
    h.store.ack(id: ID(1))
    XCTAssertTrue(try h.store.writeResult(id: ID(5), bytes: bytes, nowMs: h.t))
  }

  func testActiveRecordCountIncludesUnfinishedUploads() throws {
    let h = try Harness()
    for n in 1...15 { XCTAssertTrue(try h.create(n, "tiny")) }
    try h.store.stageBegin(id: ID(16), parts: 1, size: 1, digest: digest("a"), nowMs: h.t)
    XCTAssertThrowsError(try h.create(17, "tiny"))
    XCTAssertThrowsError(try h.store.stageBegin(id: ID(18), parts: 1, size: 1, digest: digest("a"), nowMs: h.t))
  }
  func testHeaderOnlyTombstonesAlsoHaveAFiniteCountLimit() throws {
    let h = try Harness()
    for n in 1...bridgeQueueMaxIds { try Posix.writeExclusive(h.root.appendingPathComponent("ids/\(ID(n))"), Data()) }
    XCTAssertThrowsError(try h.create(bridgeQueueMaxIds + 1, "new")) {
      XCTAssertEqual($0 as? BridgeError, .quotaExceeded)
    }
  }

  func testMalformedUploadMetadataStillChargesActualEncryptedFiles() throws {
    let h = try Harness()
    let dir = h.store.stageDir(ID(1))
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try Data(repeating: 0, count: 4 * mib).write(to: dir.appendingPathComponent("begin"))
    XCTAssertThrowsError(try h.store.create(id: ID(2), bytes: Data(repeating: 65, count: 2 * mib), nowMs: h.t))
    XCTAssertEqual(try h.store.queueUsage(.request).count, 1)
  }

  func testFailedResultRemovalKeepsBytesCharged() throws {
    let h = try Harness()
    let payload = Data(repeating: 65, count: 4 * mib)
    XCTAssertTrue(try h.create(1, "request"))
    XCTAssertTrue(try h.store.writeResult(id: ID(1), bytes: payload, nowMs: h.t))
    let results = h.root.appendingPathComponent("results")
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: results.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: results.path) }
    h.store.ack(id: ID(1))
    XCTAssertEqual(try h.store.readResult(id: ID(1), nowMs: h.t), .result(payload))
    XCTAssertGreaterThan(try h.store.queueUsage(.result).bytes, payload.count)
  }

  func testMalformedAndCorruptedMultipartMessagesFailClosed() throws {
    let h = try Harness()
    XCTAssertThrowsError(try h.store.stageBegin(id: ID(1), parts: 0, size: 1, digest: digest("a"), nowMs: h.t))
    XCTAssertThrowsError(try h.store.stageEnd(id: ID(1), nowMs: h.t))
    try h.store.stageBegin(id: ID(2), parts: 1, size: 1, digest: digest("a"), nowMs: h.t)
    try h.store.stageChunk(id: ID(2), n: 0, bytes: utf8("a"), nowMs: h.t)
    try Data([0]).write(to: h.store.stageDir(ID(2)).appendingPathComponent("0"))
    XCTAssertThrowsError(try h.store.stageEnd(id: ID(2), nowMs: h.t)) {
      XCTAssertEqual($0 as? StageError, .badDigest)
    }
    XCTAssertFalse(Posix.exists(h.store.stageDir(ID(2))))
  }
}
