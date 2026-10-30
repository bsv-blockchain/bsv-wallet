#if os(macOS)
  import CryptoKit
  import XCTest

  @testable import BsvBridgeQueue

  /// Real processes racing on one container (iOS has no `Process`, so `XC` skips this file).
  final class RaceTests: XCTestCase {
    private func helperURL() -> URL {
      Bundle(for: RaceTests.self).bundleURL.deletingLastPathComponent().appendingPathComponent("bridge-race-helper")
    }

    private func hex(_ k: SymmetricKey) -> String { k.withUnsafeBytes { $0.map { String(format: "%02x", $0) }.joined() } }

    /// Starts one helper per `ops` entry at a shared time and returns each one's output.
    private func race(_ h: Harness, key: SymmetricKey, _ ops: [(String, String, String)]) throws -> [String] {
      let startAt = SystemClock().nowMs + 1500
      let procs: [(Process, Pipe)] = try ops.map { op, id, extra in
        let p = Process()
        p.executableURL = helperURL()
        p.arguments = [h.root.path, hex(key), String(startAt), op, id, extra]
        let pipe = Pipe()
        p.standardOutput = pipe
        try p.run()
        return (p, pipe)
      }
      return procs.map { p, pipe in
        let out = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: out, encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
      }
    }

    private func harness() throws -> (Harness, SymmetricKey) {
      let key = SymmetricKey(size: .bits256)
      return (try Harness(keys: InMemoryKeyProvider(key: key)), key)
    }

    func testRacingCreateOfOneIdHasExactlyOneWinner() throws {
      let (h, key) = try harness()
      let out = try race(h, key: key, (0..<6).map { ("create", ID(1), String($0)) })
      XCTAssertEqual(out.filter { $0 == "true" }.count, 1, "\(out)")
      XCTAssertEqual(out.filter { $0 == "false" }.count, 5, "\(out)")
      XCTAssertEqual(try h.store.list(.pending, nowMs: h.t), [ID(1)])
      XCTAssertNotNil(try h.store.read(id: ID(1)))
    }

    func testRacingClaimOfOneRecordHasExactlyOneWinner() throws {
      let (h, key) = try harness()
      XCTAssertTrue(try h.create(1, "args"))
      XCTAssertTrue(h.store.accept(id: ID(1)))
      let out = try race(h, key: key, (0..<6).map { _ in ("claim", ID(1), "args") })
      XCTAssertEqual(out.filter { $0 == "claimed" }.count, 1, "\(out)")
      XCTAssertEqual(try h.store.stat(id: ID(1))?.state, .claimed)
      XCTAssertNotNil(try h.store.stat(id: ID(1))?.claimBootId)
      XCTAssertTrue(h.rawFiles().allSatisfy { !contains($0.bytes, "args") })
    }

    func testRacingAcceptAndWithdrawHaveExactlyOneWinner() throws {
      let (h, key) = try harness()
      for n in 1...5 { XCTAssertTrue(try h.create(n, "a")) }
      var ops: [(String, String, String)] = []
      for n in 1...5 { ops += [("accept", ID(n), ""), ("withdraw", ID(n), "")] }
      let out = try race(h, key: key, ops)
      for n in 0..<5 {
        let accept = out[2 * n], withdraw = out[2 * n + 1]
        XCTAssertNotEqual(accept, withdraw, "id \(n + 1): accept \(accept) withdraw \(withdraw)")
        let state = try h.store.stat(id: ID(n + 1))?.state
        XCTAssertEqual(state, accept == "true" ? .accepted : .withdrawn)
      }
    }

    func testRacingAckAndPurgeLeaveTheIdDone() throws {
      let (h, key) = try harness()
      XCTAssertTrue(try h.create(1, "a"))
      XCTAssertTrue(try h.result(1, MARKER))
      let late = String(h.t + 16 * 60_000)
      let out = try race(
        h, key: key, [("ack", ID(1), ""), ("sweep", ID(1), late), ("ack", ID(1), ""), ("sweep", ID(1), late)])
      XCTAssertEqual(out, ["done", "done", "done", "done"])
      XCTAssertEqual(try h.store.stat(id: ID(1))?.state, .done)
      XCTAssertEqual(try h.readResult(1), .purged)
      XCTAssertTrue(h.rawFiles().allSatisfy { !contains($0.bytes, MARKER) })
    }
  }
#endif
