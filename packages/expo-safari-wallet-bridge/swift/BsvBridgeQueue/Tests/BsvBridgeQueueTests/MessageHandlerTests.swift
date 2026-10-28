import CryptoKit
import XCTest

@testable import BsvBridgeQueue

final class MessageHandlerTests: XCTestCase {
  var h: Harness!
  var continuityKeys: InMemoryContinuityKeyStore!
  var nudges = 0

  override func setUpWithError() throws {
    h = try Harness()
    continuityKeys = InMemoryContinuityKeyStore()
    nudges = 0
  }

  func env(_ store: BridgeStore? = nil, keys: InMemoryContinuityKeyStore? = nil) -> BridgeEnv {
    BridgeEnv(
      store: store ?? h.store,
      continuity: Continuity(keychainGroup: "g", keys: keys ?? continuityKeys),
      clock: FixedClock(h.t),
      nudge: { self.nudges += 1 })
  }

  func send(_ r: [String: Any], _ e: BridgeEnv? = nil) -> [String: Any] {
    handleBridgeMessage(r, env: e ?? env())
  }

  func b64(_ s: String) -> String { utf8(s).base64EncodedString() }

  func json(_ o: Any) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), encoding: .utf8)!
  }

  // MARK: identity and sign

  func testIdentityIsStableAcrossHandlerInstancesAndContextSeparated() {
    let a = send(["op": "identity", "context": "safari"], env())
    let b = send(["op": "identity", "context": "safari"], env())
    let p = send(["op": "identity", "context": "safari-private"], env())
    XCTAssertEqual(a["ok"] as? Bool, true)
    XCTAssertEqual(a["instanceId"] as? String, b["instanceId"] as? String)
    XCTAssertEqual(a["continuityKey"] as? String, b["continuityKey"] as? String)
    XCTAssertNotEqual(a["instanceId"] as? String, p["instanceId"] as? String)
    XCTAssertNotEqual(a["continuityKey"] as? String, p["continuityKey"] as? String)
    // base64url, unpadded, 32 bytes.
    let k = a["continuityKey"] as! String
    XCTAssertEqual(k.count, 43)
    XCTAssertFalse(k.contains("=") || k.contains("+") || k.contains("/"))
  }

  func testPrivateBytesNeverAppearInAnyReply() throws {
    var replies = [
      send(["op": "identity", "context": "safari"]),
      send(["op": "sign", "context": "safari", "preimage": b64(continuityDescribePrefix + "{}")]),
      send(["op": "sign", "context": "safari", "preimage": b64("nope")]),
      send(["op": "sync", "cursor": 0, "nowMs": h.t]),
      send(["op": "bogus"])
    ]
    replies.append(send(["op": "identity", "context": "zzz"]))
    let seed = try XCTUnwrap(continuityKeys.snapshot["safari"]?.seed)
    let needles = [
      seed.base64EncodedString(), base64url(seed), seed.map { String(format: "%02x", $0) }.joined()
    ]
    for r in replies {
      let s = json(r)
      for n in needles { XCTAssertFalse(s.contains(n)) }
    }
  }

  func testSignRejectsBadPreimagesAndVerifies() throws {
    for bad in [
      b64("BRC-185 connect v1\n{}"), b64("{}"),
      (utf8(continuityDescribePrefix) + Data(repeating: 0x61, count: 16384 - 21)).base64EncodedString()
    ] {
      let r = send(["op": "sign", "context": "safari", "preimage": bad])
      XCTAssertEqual(r["ok"] as? Bool, false)
      XCTAssertEqual(r["code"] as? String, "BAD_PREIMAGE")
    }
    let pre = continuityDescribePrefix + "{\"x\":1}"
    let id = send(["op": "identity", "context": "safari"])
    let r = send(["op": "sign", "context": "safari", "preimage": b64(pre)])
    XCTAssertEqual(r["ok"] as? Bool, true)
    let sigB64u = r["signature"] as! String
    let sig = Data(base64Encoded: sigB64u.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "==")!
    let pubB64u = id["continuityKey"] as! String
    let pubData = Data(base64Encoded: pubB64u.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=")!
    let pub = try Curve25519.Signing.PublicKey(rawRepresentation: pubData)
    XCTAssertEqual(sig.count, 64)
    XCTAssertTrue(pub.isValidSignature(sig, for: utf8(pre)))
  }

  func testSmallOrderKeyRefusedThroughTheHandler() {
    let e = BridgeEnv(
      store: h.store,
      continuity: Continuity(keychainGroup: "g", keys: continuityKeys, strongCheck: { _ in false }),
      clock: FixedClock(h.t), nudge: {})
    let r = send(["op": "identity", "context": "safari"], e)
    XCTAssertEqual(r["ok"] as? Bool, false)
    XCTAssertNil(r["continuityKey"])
    XCTAssertTrue(continuityKeys.snapshot.isEmpty)
  }

  // MARK: key missing, unknown op

  func testUnreadableKeyRepliesKeyMissingForEveryOpIncludingIdentity() throws {
    // Wake before first unlock: the item exists but is not readable yet (not `errSecItemNotFound`).
    let locked = StaysMissingKeyProvider()
    locked.lockDevice()
    let dead = try Harness(keys: locked)
    let e = BridgeEnv(
      store: dead.store, continuity: Continuity(keychainGroup: "g", keys: InMemoryContinuityKeyStore()),
      clock: FixedClock(dead.t), nudge: { self.nudges += 1 })
    let requests: [[String: Any]] = [
      ["op": "sync", "cursor": 0],
      ["op": "identity", "context": "safari"],
      ["op": "sign", "context": "safari", "preimage": b64(continuityDescribePrefix)],
      ["op": "stage", "id": ID(1), "bytes": b64("x")],
      ["op": "stageBegin", "id": ID(1), "parts": 1, "size": 1, "digest": digest("x")],
      ["op": "stageChunk", "id": ID(1), "n": 0, "bytes": b64("x")],
      ["op": "stageEnd", "id": ID(1)],
      ["op": "withdraw", "id": ID(1)],
      ["op": "results", "ids": [["id": ID(1), "part": 0]]],
      ["op": "ack", "ids": [ID(1)]],
      ["op": "nudge"]
    ]
    for r in requests {
      let reply = handleBridgeMessage(r, env: e)
      XCTAssertEqual(reply["ok"] as? Bool, false, "\(r["op"]!)")
      XCTAssertEqual(reply["code"] as? String, "KEY_MISSING", "\(r["op"]!)")
    }
    XCTAssertEqual(nudges, 0)
  }

  func testUnknownOpRepliesBadRequest() {
    for r: [String: Any] in [["op": "frobnicate"], [:], ["op": 3]] {
      let reply = send(r)
      XCTAssertEqual(reply["ok"] as? Bool, false)
      XCTAssertEqual(reply["code"] as? String, "BAD_REQUEST")
    }
  }

  func testMalformedArgumentsReplyBadRequest() {
    XCTAssertEqual(send(["op": "stage", "id": ID(1), "bytes": "***"])["code"] as? String, "BAD_REQUEST")
    XCTAssertEqual(send(["op": "stage", "id": "../x", "bytes": b64("x")])["code"] as? String, "BAD_REQUEST")
    XCTAssertEqual(send(["op": "sync"])["code"] as? String, "BAD_REQUEST")
    XCTAssertEqual(send(["op": "ack", "ids": "nope"])["code"] as? String, "BAD_REQUEST")
  }

  // MARK: sync

  func testSyncReportsMirrorStatesAndEvents() throws {
    var r = send(["op": "sync", "cursor": 0, "nowMs": h.t])
    XCTAssertEqual(r["mirrorState"] as? String, "absent")
    XCTAssertNil(r["mirror"])
    XCTAssertEqual(r["gap"] as? Bool, false)

    try h.store.writeMirror(utf8(json(["v": 1, "connected": ["a"]])))
    try h.store.writeEvent(seq: 1, bytes: utf8(json(["closeSeq": 1])), nowMs: h.t)
    try h.store.writeEvent(seq: 2, bytes: utf8(json(["closeSeq": 2])), nowMs: h.t)
    r = send(["op": "sync", "cursor": 1, "nowMs": h.t])
    XCTAssertEqual(r["mirrorState"] as? String, "ok")
    XCTAssertEqual((r["mirror"] as? [String: Any])?["v"] as? Int, 1)
    let events = r["events"] as! [[String: Any]]
    XCTAssertEqual(events.map { $0["closeSeq"] as? Int }, [2])

    // A mirror file that is not sealed under this key is corrupt, never a stale answer.
    try Data("garbage".utf8).write(to: h.store.mirrorURL)
    r = send(["op": "sync", "cursor": 0, "nowMs": h.t])
    XCTAssertEqual(r["mirrorState"] as? String, "corrupt")
    XCTAssertNil(r["mirror"])
    // Sealed correctly but not JSON.
    try h.store.writeMirror(utf8("not json"))
    XCTAssertEqual(send(["op": "sync", "cursor": 0, "nowMs": h.t])["mirrorState"] as? String, "corrupt")
  }

  func testSyncAfterResetRepliesAbsent() throws {
    let keys = ResettableKeyProvider()
    let hh = try Harness(keys: keys)
    try hh.store.writeMirror(utf8(json(["v": 1])))
    let e = env(hh.store)
    XCTAssertEqual(send(["op": "sync", "cursor": 0], e)["mirrorState"] as? String, "ok")
    hh.store.reset()
    let r = send(["op": "sync", "cursor": 0], e)
    XCTAssertEqual(r["ok"] as? Bool, true)
    XCTAssertEqual(r["mirrorState"] as? String, "absent")
    XCTAssertEqual((r["events"] as? [Any])?.count, 0)
    // Writes are refused until the next init.
    XCTAssertEqual(send(["op": "stage", "id": ID(1), "bytes": b64("x")], e)["code"] as? String, "UNAVAILABLE")
  }

  func testReadOnlyOpsAfterResetWithAMissingKeyReplyAbsent() throws {
    let keys = StaysMissingKeyProvider()
    let hh = try Harness(keys: keys)
    try hh.store.writeMirror(utf8(json(["v": 1])))
    // The extension's own store (a new instance, no cached key) after the app reset.
    let ext = try BridgeStore(root: hh.root, keys: keys)
    hh.store.reset()
    let e = env(ext)
    let s = send(["op": "sync", "cursor": 4], e)
    XCTAssertEqual(s["ok"] as? Bool, true)
    XCTAssertEqual(s["mirrorState"] as? String, "absent")
    XCTAssertEqual((s["events"] as? [Any])?.count, 0)
    XCTAssertEqual(s["gap"] as? Bool, false)
    let r = send(["op": "results", "ids": [["id": ID(1)], ["id": ID(2)]]], e)
    XCTAssertEqual(r["ok"] as? Bool, true)
    XCTAssertEqual((r["results"] as? [[String: Any]])?.map { $0["state"] as? String }, ["none", "none"])
    XCTAssertEqual(send(["op": "ack", "ids": [ID(1)]], e)["ok"] as? Bool, true)
    // Staging cannot seal without a key: still a fault.
    XCTAssertEqual(send(["op": "stage", "id": ID(1), "bytes": b64("x")], e)["code"] as? String, "KEY_MISSING")
  }

  func testPreFirstUnlockKeychainStaysKeyMissing() throws {
    let keys = StaysMissingKeyProvider()
    let hh = try Harness(keys: keys)
    keys.lockDevice()
    let ext = try BridgeStore(root: hh.root, keys: keys)
    XCTAssertEqual(send(["op": "sync", "cursor": 0], env(ext))["code"] as? String, "KEY_MISSING")
  }

  func testSyncReportsWhereAGapEnds() throws {
    try h.store.writeEvent(seq: 3, bytes: utf8(json(["closeSeq": 3])), nowMs: h.t)
    try h.store.setEvictedThrough(9)
    let r = send(["op": "sync", "cursor": 0, "nowMs": h.t])
    XCTAssertEqual(r["gap"] as? Bool, true)
    XCTAssertEqual(r["gapThrough"] as? Int, 9)
    let after = send(["op": "sync", "cursor": 9, "nowMs": h.t])
    XCTAssertEqual(after["gap"] as? Bool, false)
  }

  // MARK: staging, withdraw, results, ack, nudge

  func record(_ n: Int, _ extra: String = "") -> String {
    json(["id": ID(n), "createdAt": h.t, "notAfter": h.t + 900_000, "pad": extra])
  }

  func testStageWithdrawAndExistsDifferent() throws {
    let rec = record(1)
    XCTAssertEqual(send(["op": "stage", "id": ID(1), "bytes": b64(rec)])["status"] as? String, "created")
    XCTAssertEqual(send(["op": "stage", "id": ID(1), "bytes": b64(rec)])["status"] as? String, "exists")
    let other = send(["op": "stage", "id": ID(1), "bytes": b64(record(1, "x"))])
    XCTAssertEqual(other["code"] as? String, "EXISTS_DIFFERENT")
    XCTAssertEqual(send(["op": "withdraw", "id": ID(1)])["won"] as? Bool, true)
    XCTAssertEqual(send(["op": "withdraw", "id": ID(1)])["won"] as? Bool, false)
    XCTAssertEqual(send(["op": "nudge"])["ok"] as? Bool, true)
    XCTAssertEqual(nudges, 1)
  }

  func testChunkedStageThroughTheHandler() throws {
    let rec = record(2, String(repeating: "q", count: 3000))
    let data = utf8(rec)
    let parts = [data.prefix(1500), data.dropFirst(1500).prefix(1500), data.dropFirst(3000)].map { Data($0) }
    XCTAssertEqual(
      send(["op": "stageBegin", "id": ID(2), "parts": 3, "size": data.count, "digest": digest(rec)])["ok"] as? Bool,
      true)
    for (n, p) in parts.enumerated() {
      XCTAssertEqual(
        send(["op": "stageChunk", "id": ID(2), "n": n, "bytes": p.base64EncodedString()])["ok"] as? Bool, true)
    }
    XCTAssertEqual(send(["op": "stageEnd", "id": ID(2)])["status"] as? String, "created")
    XCTAssertEqual(try h.store.list(.pending, nowMs: h.t), [ID(2)])
    // A bad digest is a typed error and leaves nothing.
    _ = send(["op": "stageBegin", "id": ID(3), "parts": 1, "size": 1, "digest": digest("y")])
    _ = send(["op": "stageChunk", "id": ID(3), "n": 0, "bytes": b64("z")])
    XCTAssertEqual(send(["op": "stageEnd", "id": ID(3)])["code"] as? String, "BAD_REQUEST")
    XCTAssertEqual(try h.store.list(.pending, nowMs: h.t), [ID(2)])
  }

  func testResultsOfA200KiBPayloadReturnInPartsThatRejoin() throws {
    XCTAssertTrue(try h.create(7, record(7)))
    var payload = Data()
    for i in 0..<(200 * 1024) { payload.append(UInt8(truncatingIfNeeded: i &* 31 &+ 7)) }
    XCTAssertTrue(try h.store.writeResult(id: ID(7), bytes: payload, nowMs: h.t))

    let maxPart = 48 * 1024
    var joined = Data()
    var part = 0
    var parts = 1
    repeat {
      let r = send(["op": "results", "ids": [["id": ID(7), "part": part]], "nowMs": h.t, "maxPartBytes": maxPart])
      XCTAssertEqual(r["ok"] as? Bool, true)
      let item = (r["results"] as! [[String: Any]])[0]
      XCTAssertEqual(item["state"] as? String, "result")
      parts = item["parts"] as! Int
      XCTAssertEqual(item["part"] as? Int, part)
      let bytes = Data(base64Encoded: item["bytes"] as! String)!
      XCTAssertLessThanOrEqual(bytes.count, maxPart)
      joined.append(bytes)
      part += 1
    } while part < parts
    XCTAssertEqual(parts, 5)
    XCTAssertEqual(joined, payload)

    // Out-of-range part, none, and purged after ack.
    XCTAssertEqual(
      send(["op": "results", "ids": [["id": ID(7), "part": 5]], "nowMs": h.t, "maxPartBytes": maxPart])["code"] as? String,
      "BAD_REQUEST")
    let none = send(["op": "results", "ids": [["id": ID(8), "part": 0]], "nowMs": h.t])
    XCTAssertEqual((none["results"] as! [[String: Any]])[0]["state"] as? String, "none")
    XCTAssertEqual(send(["op": "ack", "ids": [ID(7)]])["ok"] as? Bool, true)
    let purged = send(["op": "results", "ids": [["id": ID(7), "part": 0]], "nowMs": h.t])
    XCTAssertEqual((purged["results"] as! [[String: Any]])[0]["state"] as? String, "purged")
  }
}

struct FixedClock: Clock {
  let nowMs: Int64
  init(_ n: Int64) { nowMs = n }
}
