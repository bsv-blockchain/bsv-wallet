import Foundation
import XCTest

@testable import BsvBridgeQueue

/// Port of `inboxContract.ts` (the cases that exist before the events work of Task 9), same names.
final class ContractTests: XCTestCase {
  var h: Harness!
  override func setUpWithError() throws { h = try Harness() }

  func testStagesStatsAndReadsARecordWithoutChangingItsState() throws {
    XCTAssertTrue(try h.create(1, "hello"))
    XCTAssertEqual(try h.store.stat(id: ID(1)), StatResult(size: 5, state: .pending, claimBootId: nil))
    XCTAssertEqual(text(try h.store.read(id: ID(1))), "hello")
    XCTAssertEqual(try h.store.stat(id: ID(1))?.state, .pending)
    XCTAssertNil(try h.store.stat(id: ID(2)))
    XCTAssertEqual(try h.store.list(.pending, nowMs: h.t), [ID(1)])
  }

  func testReStageIsRefusedInEveryStateTombstonesIncluded() throws {
    _ = try h.create(1, "a")
    XCTAssertFalse(try h.create(1, "b"))
    XCTAssertTrue(h.store.accept(id: ID(1)))
    XCTAssertFalse(try h.create(1, "b"))
    _ = try h.claim(1, "a")
    XCTAssertFalse(try h.create(1, "b"))
    _ = try h.result(1, "r")
    XCTAssertFalse(try h.create(1, "b"))
    h.store.ack(id: ID(1))
    XCTAssertFalse(try h.create(1, "b"))
    XCTAssertEqual(try h.store.stat(id: ID(1))?.state, .done)
  }

  func testSizeIsAvailableFromStatWithoutReadingThePayload() throws {
    _ = try h.store.create(id: ID(1), bytes: Data(count: 1234), nowMs: h.t)
    XCTAssertEqual(try h.store.stat(id: ID(1))?.size, 1234)
  }

  func testAcceptMovesPendingToAcceptedOnce() throws {
    _ = try h.create(1, "a")
    XCTAssertTrue(h.store.accept(id: ID(1)))
    XCTAssertFalse(h.store.accept(id: ID(1)))
    XCTAssertFalse(h.store.accept(id: ID(9)))
  }

  func testClaimNeedsAnAcceptedRecord() throws {
    _ = try h.create(1, "a")
    XCTAssertEqual(try h.claim(1, "a"), .notAccepted)
  }

  func testConcurrentClaimSucceedsExactlyOnce() throws {
    _ = try h.create(1, "a")
    _ = h.store.accept(id: ID(1))
    let lock = NSLock()
    var outcomes: [ClaimOutcome] = []
    let d = digest("a")
    DispatchQueue.concurrentPerform(iterations: 8) { _ in
      let o = (try? h.store.claim(id: ID(1), digest: d, bootId: "boot-1", nowMs: h.t)) ?? .digestMismatch
      lock.lock()
      outcomes.append(o)
      lock.unlock()
    }
    XCTAssertEqual(outcomes.filter { $0 == .claimed }.count, 1)
    XCTAssertEqual(outcomes.filter { $0 == .notAccepted }.count, 7)
  }

  func testClaimFailsWhenTheDigestDoesNotMatchAndTheRecordStaysAccepted() throws {
    _ = try h.create(1, "a")
    _ = h.store.accept(id: ID(1))
    XCTAssertEqual(try h.claim(1, "changed"), .digestMismatch)
    XCTAssertEqual(try h.store.stat(id: ID(1))?.state, .accepted)
    XCTAssertEqual(try h.claim(1, "a"), .claimed)
  }

  func testClaimStampsTheBootIdAndDeletesTheArguments() throws {
    _ = try h.create(1, "a")
    _ = h.store.accept(id: ID(1))
    _ = try h.claim(1, "a")
    XCTAssertEqual(try h.store.stat(id: ID(1)), StatResult(size: 1, state: .claimed, claimBootId: h.bootId))
    XCTAssertNil(try h.store.read(id: ID(1)))
  }

  func testAResultIsWrittenOnceReadAndAcknowledgedWithoutLosingTheTombstone() throws {
    _ = try h.create(1, "a")
    XCTAssertEqual(try h.readResult(1), .none)
    XCTAssertTrue(try h.result(1, "r1"))
    XCTAssertFalse(try h.result(1, "r2"))
    XCTAssertEqual(try h.readResult(1), .result(utf8("r1")))
    XCTAssertNil(try h.store.read(id: ID(1)))
    h.store.ack(id: ID(1))
    h.store.ack(id: ID(1))
    XCTAssertEqual(try h.readResult(1), .purged)
    XCTAssertNotNil(try h.store.stat(id: ID(1)))
  }

  func testAnUnacknowledgedResultIsPurgedAfter15Minutes() throws {
    _ = try h.create(1, "a")
    _ = try h.result(1, "r")
    h.advance(14 * 60_000)
    XCTAssertEqual(try h.readResult(1), .result(utf8("r")))
    h.advance(2 * 60_000)
    XCTAssertEqual(try h.readResult(1), .purged)
    XCTAssertFalse(try h.create(1, "b"))
  }

  func testStateSurvivesARestartUnderANewBootId() throws {
    _ = try h.create(1, "a")
    _ = h.store.accept(id: ID(1))
    let first = h.bootId
    _ = try h.claim(1, "a")
    _ = try h.create(2, "b")
    _ = h.store.accept(id: ID(2))
    let next = try h.restart()
    XCTAssertNotEqual(h.bootId, first)
    XCTAssertEqual(try next.stat(id: ID(1)), StatResult(size: 1, state: .claimed, claimBootId: first))
    XCTAssertEqual(try next.list(.accepted, nowMs: h.t), [ID(2)])
    XCTAssertTrue(next.release(id: ID(2)))
    XCTAssertEqual(try next.list(.pending, nowMs: h.t), [ID(2)])
    XCTAssertFalse(next.release(id: ID(2)))
  }

  // Beyond the ported contract.

  func testPendingIsListedOldestFirstByCreatedAtFromTheRecord() throws {
    _ = try h.store.create(id: ID(3), bytes: utf8(#"{"createdAt":300}"#), nowMs: h.t)
    _ = try h.store.create(id: ID(1), bytes: utf8(#"{"createdAt":100}"#), nowMs: h.t)
    _ = try h.store.create(id: ID(2), bytes: utf8(#"{"createdAt":200}"#), nowMs: h.t)
    XCTAssertEqual(try h.store.list(.pending, nowMs: h.t), [ID(1), ID(2), ID(3)])
  }

  func testIdsThatCouldEscapeTheContainerAreRefused() throws {
    for bad in ["../x", "a/b", "", ".", "..", String(repeating: "a", count: 65)] {
      XCTAssertThrowsError(try h.store.create(id: bad, bytes: utf8("x"), nowMs: h.t), bad) {
        XCTAssertEqual($0 as? BridgeError, .invalidId)
      }
      XCTAssertNil(try h.store.stat(id: bad))
      XCTAssertFalse(h.store.accept(id: bad))
    }
  }

  func testAnUnreadableKeyThrowsKeyMissingFromEveryOperationThatUnseals() throws {
    _ = try h.create(1, "a")
    let blind = try BridgeStore(root: h.root, keys: UnavailableKeyProvider())
    func isKeyMissing(_ e: Error) -> Bool { if case .keyMissing = e as? BridgeError { return true } else { return false } }
    XCTAssertThrowsError(try blind.create(id: ID(2), bytes: utf8("x"), nowMs: h.t)) { XCTAssertTrue(isKeyMissing($0)) }
    XCTAssertThrowsError(try blind.stat(id: ID(1))) { XCTAssertTrue(isKeyMissing($0)) }
    XCTAssertThrowsError(try blind.read(id: ID(1))) { XCTAssertTrue(isKeyMissing($0)) }
    XCTAssertThrowsError(try blind.list(.pending, nowMs: h.t)) { XCTAssertTrue(isKeyMissing($0)) }
    // The failed create left no tombstone behind.
    XCTAssertTrue(try h.create(2, "x"))
  }

  func testAFileSealedUnderAnotherKeyReadsAsAbsent() throws {
    _ = try h.create(1, "a")
    let foreign = try BridgeStore(root: h.root, keys: InMemoryKeyProvider())
    XCTAssertNil(try foreign.stat(id: ID(1)))
    XCTAssertNil(try foreign.read(id: ID(1)))
    XCTAssertEqual(try foreign.list(.pending, nowMs: h.t), [])
  }

  func testTheKeychainProviderFailsCleanlyWithoutTheEntitlementOrKey() {
    let p = KeychainKeyProvider(group: "TESTTEAM.org.example.bridge", createIfMissing: false)
    XCTAssertThrowsError(try p.sealingKey()) { XCTAssertTrue($0 is BridgeError) }
  }
}
