import Foundation

/// What a native message needs: the queue, the continuity keys, a clock and the Darwin-notification
/// poster (`nudge`). The handler keeps no state of its own.
public struct BridgeEnv {
  public let store: BridgeStore
  public let continuity: Continuity
  public let clock: Clock
  public let nudge: () -> Void

  public init(store: BridgeStore, continuity: Continuity, clock: Clock = SystemClock(), nudge: @escaping () -> Void) {
    self.store = store
    self.continuity = continuity
    self.clock = clock
    self.nudge = nudge
  }
}

private struct HandlerError: Error {
  let code: String
  let message: String
  static func bad(_ message: String) -> HandlerError { HandlerError(code: "BAD_REQUEST", message: message) }
}

private let knownOps: Set<String> = [
  "sync", "identity", "sign", "stage", "stageBegin", "stageChunk", "stageEnd", "withdraw", "results", "ack", "nudge"
]

/// Default and bounds for a `results` part (the messaging channel's size is measured by spike S2).
private let defaultMaxPartBytes = 48 * 1024
private let minMaxPartBytes = 1024
private let hardMaxPartBytes = 1024 * 1024

func base64url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

/// One JSON request, one JSON reply. Every reply is `{ok:true, ...}` or `{ok:false, code, message}`.
/// An unreadable sealing key answers `KEY_MISSING` for every known op (wake before first unlock),
/// never a hang or a crash.
public func handleBridgeMessage(_ request: [String: Any], env: BridgeEnv) -> [String: Any] {
  guard let op = request["op"] as? String, knownOps.contains(op) else {
    return failure("BAD_REQUEST", "unknown op")
  }
  do {
    _ = try env.store.key()
    var reply = try dispatch(op, request, env)
    reply["ok"] = true
    return reply
  } catch {
    return map(error)
  }
}

private func failure(_ code: String, _ message: String) -> [String: Any] {
  ["ok": false, "code": code, "message": message]
}

private func map(_ error: Error) -> [String: Any] {
  switch error {
  case let e as HandlerError: return failure(e.code, e.message)
  case BridgeError.keyMissing: return failure("KEY_MISSING", "The sealing key is not available")
  case BridgeError.invalidId: return failure("BAD_REQUEST", "invalid id")
  case BridgeError.resetFinal: return failure("UNAVAILABLE", "The bridge was reset")
  case BridgeError.io(let m): return failure("UNAVAILABLE", m)
  case StageError.existsDifferent: return failure("EXISTS_DIFFERENT", "The id is taken by other bytes")
  case let e as StageError: return failure("BAD_REQUEST", "stage: \(e)")
  case ContinuityError.badPreimage: return failure("BAD_PREIMAGE", "Not a describe preimage")
  case ContinuityError.badContext: return failure("BAD_REQUEST", "unknown context")
  case ContinuityError.keychain(let status):
    // errSecInteractionNotAllowed: the device has not been unlocked since boot.
    return status == -25308 || status == -25300
      ? failure("KEY_MISSING", "The continuity key is not available")
      : failure("UNAVAILABLE", "keychain \(status)")
  case ContinuityError.weakKey, ContinuityError.corrupt: return failure("UNAVAILABLE", "continuity key unusable")
  default: return failure("UNAVAILABLE", "\(error)")
  }
}

private func string(_ r: [String: Any], _ key: String) throws -> String {
  guard let s = r[key] as? String else { throw HandlerError.bad("\(key) must be a string") }
  return s
}

private func int(_ r: [String: Any], _ key: String) throws -> Int {
  guard let n = r[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == Double(n.intValue)
  else { throw HandlerError.bad("\(key) must be an integer") }
  return n.intValue
}

private func bytes(_ r: [String: Any], _ key: String) throws -> Data {
  guard let s = r[key] as? String, let d = Data(base64Encoded: s) else {
    throw HandlerError.bad("\(key) must be base64")
  }
  return d
}

private func nowMs(_ r: [String: Any], _ env: BridgeEnv) -> Int64 {
  if let n = r["nowMs"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n.int64Value }
  return env.clock.nowMs
}

private func object(_ data: Data) -> [String: Any]? {
  (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

private func stageReply(_ status: StageStatus) -> [String: Any] {
  ["status": status == .created ? "created" : "exists"]
}

private func dispatch(_ op: String, _ r: [String: Any], _ env: BridgeEnv) throws -> [String: Any] {
  let store = env.store
  switch op {
  case "sync":
    let cursor = try int(r, "cursor")
    var reply: [String: Any] = [:]
    switch try store.readMirror() {
    case .ok(let d):
      if let m = object(d) {
        reply["mirrorState"] = "ok"
        reply["mirror"] = m
      } else {
        reply["mirrorState"] = "corrupt"
      }
    case .absent: reply["mirrorState"] = "absent"
    case .corrupt: reply["mirrorState"] = "corrupt"
    }
    let (raw, gap) = try store.readEventsAfter(seq: cursor, nowMs: nowMs(r, env))
    let events = raw.compactMap(object)
    reply["events"] = events
    // An event that does not parse is a lost event: a gap, never a silent skip.
    reply["gap"] = gap || events.count != raw.count
    return reply

  case "identity":
    let id = try env.continuity.identity(context: try string(r, "context"))
    return ["instanceId": id.instanceId, "continuityKey": base64url(id.publicKey)]

  case "sign":
    let sig = try env.continuity.sign(context: try string(r, "context"), preimage: try bytes(r, "preimage"))
    return ["signature": base64url(sig)]

  case "stage":
    return stageReply(try store.stage(id: try string(r, "id"), bytes: try bytes(r, "bytes"), nowMs: nowMs(r, env)))

  case "stageBegin":
    try store.stageBegin(
      id: try string(r, "id"), parts: try int(r, "parts"), size: try int(r, "size"),
      digest: try string(r, "digest"), nowMs: nowMs(r, env))
    return [:]

  case "stageChunk":
    try store.stageChunk(
      id: try string(r, "id"), n: try int(r, "n"), bytes: try bytes(r, "bytes"), nowMs: nowMs(r, env))
    return [:]

  case "stageEnd":
    return stageReply(try store.stageEnd(id: try string(r, "id"), nowMs: nowMs(r, env)))

  case "withdraw":
    return ["won": store.withdraw(id: try string(r, "id"))]

  case "results":
    guard let items = r["ids"] as? [[String: Any]] else { throw HandlerError.bad("ids must be a list") }
    var maxPart = defaultMaxPartBytes
    if r["maxPartBytes"] != nil { maxPart = try int(r, "maxPartBytes") }
    maxPart = min(max(maxPart, minMaxPartBytes), hardMaxPartBytes)
    let now = nowMs(r, env)
    var out: [[String: Any]] = []
    for item in items {
      let id = try string(item, "id")
      let part = item["part"] == nil ? 0 : try int(item, "part")
      guard part >= 0 else { throw HandlerError.bad("part must not be negative") }
      switch try store.readResult(id: id, nowMs: now) {
      case .none: out.append(["id": id, "state": "none"])
      case .purged: out.append(["id": id, "state": "purged"])
      case .result(let data):
        let parts = max(1, (data.count + maxPart - 1) / maxPart)
        guard part < parts else { throw HandlerError.bad("part out of range") }
        let slice = data.subdata(in: (part * maxPart)..<min(data.count, (part + 1) * maxPart))
        out.append(["id": id, "state": "result", "part": part, "parts": parts, "bytes": slice.base64EncodedString()])
      }
    }
    return ["results": out]

  case "ack":
    guard let ids = r["ids"] as? [String] else { throw HandlerError.bad("ids must be a list of strings") }
    ids.forEach { store.ack(id: $0) }
    return [:]

  default:  // nudge
    env.nudge()
    return [:]
  }
}
