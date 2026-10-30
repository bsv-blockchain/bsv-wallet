import CryptoKit
import XCTest

@testable import BsvBridgeQueue

final class ContinuityTests: XCTestCase {
  let group = "TEAM.org.example.bridge"

  func testIdentityIsStableAndContextSeparated() throws {
    let store = InMemoryContinuityKeyStore()
    let a = try Continuity(keychainGroup: group, keys: store).identity(context: "safari")
    let again = try Continuity(keychainGroup: group, keys: store).identity(context: "safari")
    let priv = try Continuity(keychainGroup: group, keys: store).identity(context: "safari-private")
    XCTAssertEqual(a.instanceId, again.instanceId)
    XCTAssertEqual(a.publicKey, again.publicKey)
    XCTAssertEqual(a.publicKey.count, 32)
    XCTAssertNotEqual(a.instanceId, priv.instanceId)
    XCTAssertNotEqual(a.publicKey, priv.publicKey)
    // Lowercase UUIDv4.
    XCTAssertEqual(a.instanceId, a.instanceId.lowercased())
    XCTAssertEqual(UUID(uuidString: a.instanceId)?.uuidString.lowercased(), a.instanceId)
    XCTAssertEqual(Array(a.instanceId)[14], "4")
  }

  func testUnknownContextIsRefusedAndNothingIsCreated() {
    let store = InMemoryContinuityKeyStore()
    let c = Continuity(keychainGroup: group, keys: store)
    XCTAssertThrowsError(try c.identity(context: "other")) { XCTAssertEqual($0 as? ContinuityError, .badContext) }
    XCTAssertTrue(store.snapshot.isEmpty)
  }

  func testSignRejectsConnectUnprefixedAndOversizedPreimages() throws {
    let c = Continuity(keychainGroup: group, keys: InMemoryContinuityKeyStore())
    func rejects(_ d: Data, _ line: UInt = #line) {
      XCTAssertThrowsError(try c.sign(context: "safari", preimage: d), line: line) {
        XCTAssertEqual($0 as? ContinuityError, .badPreimage, line: line)
      }
    }
    rejects(utf8("BRC-185 connect v1\n{}"))
    rejects(utf8("{\"origin\":\"https://a.example\"}"))
    rejects(utf8("BRC-185 descriptor v1"))  // no newline
    rejects(utf8(continuityDescribePrefix) + Data(repeating: 0x61, count: 16 * 1024 - 21))  // 16385 bytes
    XCTAssertEqual((utf8(continuityDescribePrefix) + Data(repeating: 0x61, count: 16 * 1024 - 21)).count, 16385)
    // Exactly 16 KiB is accepted.
    let ok = utf8(continuityDescribePrefix) + Data(repeating: 0x61, count: 16 * 1024 - 22)
    XCTAssertEqual(ok.count, 16384)
    XCTAssertEqual(try c.sign(context: "safari", preimage: ok).count, 64)
  }

  func testSignatureVerifiesWithTheReturnedPublicKey() throws {
    let c = Continuity(keychainGroup: group, keys: InMemoryContinuityKeyStore())
    let id = try c.identity(context: "safari")
    let pre = utf8(continuityDescribePrefix + "{\"origin\":\"https://a.example\"}")
    let sig = try c.sign(context: "safari", preimage: pre)
    let pub = try Curve25519.Signing.PublicKey(rawRepresentation: id.publicKey)
    XCTAssertTrue(pub.isValidSignature(sig, for: pre))
    XCTAssertFalse(pub.isValidSignature(sig, for: pre + utf8("x")))
    // The other context's key does not verify it.
    let other = try Curve25519.Signing.PublicKey(rawRepresentation: try c.identity(context: "safari-private").publicKey)
    XCTAssertFalse(other.isValidSignature(sig, for: pre))
  }

  func testSmallOrderPublicKeyIsRefusedBeforeFirstUse() throws {
    func hex(_ s: String) -> Data {
      var d = Data()
      var i = s.startIndex
      while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        d.append(UInt8(s[i..<j], radix: 16)!)
        i = j
      }
      return d
    }
    let weak: [String] = [
      "01" + String(repeating: "00", count: 31),  // identity
      String(repeating: "00", count: 32),  // y = 0
      String(repeating: "00", count: 31) + "80",
      "ec" + String(repeating: "ff", count: 30) + "7f",  // y = -1
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
      "ed" + String(repeating: "ff", count: 30) + "7f",  // y = p, non-canonical
      String(repeating: "ff", count: 32)
    ]
    for w in weak { XCTAssertFalse(isStrongEd25519Key(hex(w)), w) }
    XCTAssertFalse(isStrongEd25519Key(Data(count: 31)))
    XCTAssertTrue(isStrongEd25519Key(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation))

    // A generator that yields a weak key creates nothing and returns nothing.
    let store = InMemoryContinuityKeyStore()
    let c = Continuity(keychainGroup: group, keys: store, strongCheck: { _ in false })
    XCTAssertThrowsError(try c.identity(context: "safari")) { XCTAssertEqual($0 as? ContinuityError, .weakKey) }
    XCTAssertThrowsError(try c.sign(context: "safari", preimage: utf8(continuityDescribePrefix)))
    XCTAssertTrue(store.snapshot.isEmpty)
  }

  func testResetAllMakesANewProviderIdentity() throws {
    let store = InMemoryContinuityKeyStore()
    let c = Continuity(keychainGroup: group, keys: store)
    let before = try c.identity(context: "safari")
    c.resetAll()
    let after = try c.identity(context: "safari")
    XCTAssertNotEqual(before.instanceId, after.instanceId)
    XCTAssertNotEqual(before.publicKey, after.publicKey)
  }
}
