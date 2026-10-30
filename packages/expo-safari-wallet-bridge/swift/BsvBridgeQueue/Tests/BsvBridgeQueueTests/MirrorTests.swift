import CryptoKit
import XCTest

@testable import BsvBridgeQueue

final class MirrorTests: XCTestCase {
  func testAbsentThenOk() throws {
    let h = try Harness()
    XCTAssertEqual(try h.store.readMirror(), .absent)
    try h.store.writeMirror(utf8(MARKER))
    XCTAssertEqual(try h.store.readMirror(), .ok(utf8(MARKER)))
    XCTAssertTrue(h.rawFiles().allSatisfy { !contains($0.bytes, MARKER) })
  }

  func testCorruptMirrorSyncsAsAbsent() throws {
    let h = try Harness()
    try h.store.writeMirror(utf8(#"{"v":1}"#))
    let url = h.root.appendingPathComponent("meta/mirror.sealed")
    let good = try Data(contentsOf: url)

    // Truncated.
    try good.prefix(good.count - 5).write(to: url)
    XCTAssertEqual(try h.store.readMirror(), .corrupt)
    XCTAssertNil(try h.store.readMirror().usable)
    // Garbage.
    try Data("not a sealed file".utf8).write(to: url)
    XCTAssertEqual(try h.store.readMirror(), .corrupt)
    // Sealed under another key.
    let foreign = try Sealing.seal(utf8("x"), key: SymmetricKey(size: .bits256), kind: .mirror, id: "mirror")
    try foreign.write(to: url)
    XCTAssertEqual(try h.store.readMirror(), .corrupt)
    // Sealed for another role under the right key.
    let wrongRole = try Sealing.seal(utf8("x"), key: try h.store.key(), kind: .event, id: "mirror")
    try wrongRole.write(to: url)
    XCTAssertEqual(try h.store.readMirror(), .corrupt)
    // Empty file.
    try Data().write(to: url)
    XCTAssertEqual(try h.store.readMirror(), .corrupt)
  }

  func testMirrorReplaceIsAtomicUnderAConcurrentReader() throws {
    let h = try Harness()
    let a = utf8(String(repeating: "A", count: 200_000))
    let b = utf8(String(repeating: "B", count: 150_000))
    try h.store.writeMirror(a)
    let reader = try BridgeStore(root: h.root, keys: h.keys)
    let stop = NSLock()
    var done = false
    let seenBad = NSLock()
    var bad = 0
    var reads = 0
    let t = Thread {
      while true {
        stop.lock()
        let d = done
        stop.unlock()
        if d { break }
        let r = try? reader.readMirror()
        seenBad.lock()
        reads += 1
        if r != .ok(a) && r != .ok(b) { bad += 1 }
        seenBad.unlock()
      }
    }
    t.start()
    for i in 0..<300 { try h.store.writeMirror(i % 2 == 0 ? b : a) }
    stop.lock()
    done = true
    stop.unlock()
    while !t.isFinished { usleep(1000) }
    seenBad.lock()
    defer { seenBad.unlock() }
    XCTAssertGreaterThan(reads, 0)
    XCTAssertEqual(bad, 0)
  }

  func testBootIdPersists() throws {
    let h = try Harness()
    XCTAssertNil(h.store.bootId)
    let id = try h.store.startBoot()
    XCTAssertEqual(h.store.bootId, id)
    XCTAssertEqual(try h.restart().bootId, id)
    XCTAssertNotEqual(try h.store.startBoot(), id)
  }
}
