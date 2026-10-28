import CryptoKit
import Foundation
import XCTest

@testable import BsvBridgeQueue

final class SealingTests: XCTestCase {
  let key = SymmetricKey(size: .bits256)
  let plain = utf8("payload")

  func testRoundTrip() throws {
    let s = try Sealing.seal(plain, key: key, kind: .record, id: ID(1))
    XCTAssertEqual(try Sealing.open(s, key: key, kind: .record, id: ID(1)), plain)
  }

  func testWrongIdFailsToOpen() throws {
    let s = try Sealing.seal(plain, key: key, kind: .record, id: ID(1))
    XCTAssertThrowsError(try Sealing.open(s, key: key, kind: .record, id: ID(2)))
  }

  func testWrongKindFailsToOpen() throws {
    let s = try Sealing.seal(plain, key: key, kind: .record, id: ID(1))
    XCTAssertThrowsError(try Sealing.open(s, key: key, kind: .result, id: ID(1)))
    let c = try Sealing.seal(plain, key: key, kind: .chunk(1), id: ID(1))
    XCTAssertThrowsError(try Sealing.open(c, key: key, kind: .chunk(2), id: ID(1)))
    XCTAssertEqual(try Sealing.open(c, key: key, kind: .chunk(1), id: ID(1)), plain)
  }

  func testTamperedByteFails() throws {
    let s = try Sealing.seal(plain, key: key, kind: .record, id: ID(1))
    for i in [0, 12, s.count - 1] {
      var bad = s
      bad[i] ^= 0x01
      XCTAssertThrowsError(try Sealing.open(bad, key: key, kind: .record, id: ID(1)), "byte \(i)")
    }
  }

  func testTruncatedFileFails() throws {
    let s = try Sealing.seal(plain, key: key, kind: .record, id: ID(1))
    XCTAssertThrowsError(try Sealing.open(s.dropLast(), key: key, kind: .record, id: ID(1)))
    XCTAssertThrowsError(try Sealing.open(s.prefix(10), key: key, kind: .record, id: ID(1)))
    XCTAssertThrowsError(try Sealing.open(Data(), key: key, kind: .record, id: ID(1)))
  }

  func testNonceIsFreshPerFile() throws {
    var nonces = Set<Data>()
    for _ in 0..<64 { nonces.insert(try Sealing.seal(plain, key: key, kind: .record, id: ID(1)).prefix(12)) }
    XCTAssertEqual(nonces.count, 64)
  }

  func testSealedLayoutIsNonceCiphertextTag() throws {
    let s = try Sealing.seal(plain, key: key, kind: .record, id: ID(1))
    XCTAssertEqual(s.count, 12 + plain.count + 16)
  }

  func testAADIsExactlyBsvBridgeV1RecordId() throws {
    XCTAssertEqual(String(data: Sealing.aad(kind: .record, id: ID(1)), encoding: .utf8), "bsv-bridge/v1|record|\(ID(1))")
    XCTAssertEqual(String(data: Sealing.aad(kind: .chunk(3), id: "x"), encoding: .utf8), "bsv-bridge/v1|chunk:3|x")
    // A blob sealed independently with that AAD opens, so the AAD is what the implementation uses.
    let box = try AES.GCM.seal(plain, using: key, authenticating: utf8("bsv-bridge/v1|record|\(ID(1))"))
    XCTAssertEqual(try Sealing.open(box.combined!, key: key, kind: .record, id: ID(1)), plain)
    let s = try Sealing.seal(plain, key: key, kind: .record, id: ID(1))
    let reopened = try AES.GCM.open(try AES.GCM.SealedBox(combined: s), using: key, authenticating: utf8("bsv-bridge/v1|record|\(ID(1))"))
    XCTAssertEqual(reopened, plain)
  }
}
