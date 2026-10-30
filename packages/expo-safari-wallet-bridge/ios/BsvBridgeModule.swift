import BsvBridgeQueue
import ExpoModulesCore
import Foundation

/// App side of the bridge (spec 6.6): the sealed queue as an Expo module. Binary values cross as
/// base64 strings. Every async function except `reset` hops off the main thread; `reset` is
/// synchronous because logout teardown cannot await.
///
/// Errors carry a stable `code`: `ERR_NOT_FOUND` (nothing there), `ERR_KEY_MISSING`, `ERR_RESET`
/// (the queue was reset and `init` has not run since), `ERR_UNAVAILABLE` (anything else).
public class BsvBridgeModule: Module {
  private let lock = NSLock()
  private var store: BridgeStore?
  private var appGroup: String?
  private var root: URL?
  private var observation: BridgeNudge.Observation?
  private var wantsNudges = false
  private var isActive = true

  public func definition() -> ModuleDefinition {
    Name("BsvBridge")

    Events("onNudge")

    OnStartObserving("onNudge") { [weak self] in
      self?.setWantsNudges(true)
    }
    OnStopObserving("onNudge") { [weak self] in
      self?.setWantsNudges(false)
    }
    OnAppEntersForeground { [weak self] in
      self?.setActive(true)
    }
    OnAppEntersBackground { [weak self] in
      self?.setActive(false)
    }
    OnDestroy { [weak self] in
      self?.stopObserving()
    }

    // init({ nowMs }): create the key if absent, set directory attributes, start a boot, run the sweeps.
    AsyncFunction("init") { (opts: [String: Any]) -> [String: String] in
      let nowMs = try Self.int64(opts["nowMs"], "nowMs")
      let config = try Self.config()
      let s = try self.openStore(config)
      // Creating the key here (and only here) is what lets the extension, which never creates one, read it.
      do {
        _ = try KeychainKeyProvider(group: config.keychainGroup, createIfMissing: true).sealingKey()
      } catch {
        throw Self.map(error)
      }
      do {
        try s.reopen()
        let bootId = try s.startBoot()
        try s.sweep(nowMs: nowMs)
        s.recoverClaimed()
        self.lock.lock()
        self.appGroup = config.appGroup
        self.lock.unlock()
        self.refreshObservation()
        return ["bootId": bootId, "scheme": config.scheme]
      } catch {
        throw Self.map(error)
      }
    }

    AsyncFunction("create") { (id: String, bytes: String, nowMs: Double) -> Bool in
      try self.run { try $0.create(id: id, bytes: try Self.data(bytes), nowMs: Int64(nowMs)) }
    }

    AsyncFunction("stat") { (id: String) -> [String: Any]? in
      try self.run { s in
        guard let r = try s.stat(id: id) else { return nil }
        var out: [String: Any] = ["size": r.size, "state": r.state.rawValue]
        if let boot = r.claimBootId { out["claimBootId"] = boot }
        return out
      }
    }

    AsyncFunction("read") { (id: String) -> String? in
      try self.run { try $0.read(id: id)?.base64EncodedString() }
    }

    AsyncFunction("accept") { (id: String) -> Bool in
      try self.run { $0.accept(id: id) }
    }

    AsyncFunction("release") { (id: String) -> Bool in
      try self.run { $0.release(id: id) }
    }

    AsyncFunction("claim") { (id: String, digest: String, nowMs: Double) -> String in
      try self.run { s in
        let bootId = s.bootId ?? ""
        switch try s.claim(id: id, digest: digest, bootId: bootId, nowMs: Int64(nowMs)) {
        case .claimed: return "claimed"
        case .digestMismatch: return "digest-mismatch"
        case .notAccepted: return "not-accepted"
        }
      }
    }

    AsyncFunction("writeResult") { (id: String, bytes: String, nowMs: Double) -> Bool in
      try self.run { try $0.writeResult(id: id, bytes: try Self.data(bytes), nowMs: Int64(nowMs)) }
    }

    AsyncFunction("readResult") { (id: String, nowMs: Double) -> [String: Any] in
      try self.run { s in
        switch try s.readResult(id: id, nowMs: Int64(nowMs)) {
        case .none: return ["kind": "none"]
        case .purged: return ["kind": "purged"]
        case .result(let d): return ["kind": "result", "bytes": d.base64EncodedString()]
        }
      }
    }

    AsyncFunction("ack") { (id: String) in
      try self.run { $0.ack(id: id) }
    }

    AsyncFunction("list") { (state: String, nowMs: Double) -> [String] in
      guard let st = State(rawValue: state) else {
        throw Exception(name: "BadState", description: "unknown state \(state)", code: "ERR_UNAVAILABLE")
      }
      return try self.run { try $0.list(st, nowMs: Int64(nowMs)) }
    }

    AsyncFunction("writeEvent") { (seq: Int, event: String, nowMs: Double) in
      try self.run { try $0.writeEvent(seq: seq, bytes: Data(event.utf8), nowMs: Int64(nowMs)) }
    }

    AsyncFunction("readEventsAfter") { (seq: Int, nowMs: Double) -> [String: Any] in
      try self.run { s in
        let (raw, gap) = try s.readEventsAfter(seq: seq, nowMs: Int64(nowMs))
        let events = raw.compactMap { String(data: $0, encoding: .utf8) }
        // An event that is not text is a lost event: report a gap, never skip it silently.
        return ["events": events, "gap": gap || events.count != raw.count]
      }
    }

    AsyncFunction("writeMirror") { (bytes: String) in
      try self.run { try $0.writeMirror(try Self.data(bytes)) }
    }

    AsyncFunction("sweep") { (opts: [String: Any]) in
      let nowMs = try Self.int64(opts["nowMs"], "nowMs")
      try self.run { try $0.sweep(nowMs: nowMs) }
    }

    // Synchronous (logout teardown cannot await): deletes the key and the container, final until `init`.
    Function("reset") {
      self.lock.lock()
      let s = self.store
      self.lock.unlock()
      if let s {
        s.reset()  // also deletes the continuity keys through `onReset`
      } else if let config = try? Self.config() {
        // Logout in a process that never ran `init`: the keychain items outlive the process.
        Self.deleteContinuityKeys(group: config.keychainGroup)()
        KeychainKeyProvider(group: config.keychainGroup, createIfMissing: false).deleteKey()
      }
    }

    // Debug builds only: every stored file's raw bytes (base64), for the Simulator plaintext-marker test.
    AsyncFunction("rawBytes") { () -> [String] in
      #if DEBUG
        _ = try self.requireStore()
        self.lock.lock()
        let bridgeRoot = self.root
        self.lock.unlock()
        guard let bridgeRoot else { return [] }
        return Self.rawFiles(under: bridgeRoot).map { $0.base64EncodedString() }
      #else
        throw Exception(name: "NotAvailable", description: "rawBytes is debug-only", code: "ERR_UNAVAILABLE")
      #endif
    }
  }

  // MARK: Configuration and store

  private struct Config {
    let appGroup: String
    let keychainGroup: String
    let scheme: String
  }

  /// The plugin writes these three keys into the app's Info.plist (spec 6.2); nothing is hard-coded.
  private static func config() throws -> Config {
    func value(_ key: String) throws -> String {
      guard let v = Bundle.main.object(forInfoDictionaryKey: key) as? String, !v.isEmpty else {
        throw Exception(
          name: "MissingConfig", description: "Info.plist is missing \(key); run prebuild with the Safari bridge plugin",
          code: "ERR_UNAVAILABLE")
      }
      return v
    }
    return Config(
      appGroup: try value("BSVBridgeAppGroup"), keychainGroup: try value("BSVBridgeKeychainGroup"),
      scheme: try value("BSVBridgeScheme"))
  }

  private func openStore(_ config: Config) throws -> BridgeStore {
    lock.lock()
    defer { lock.unlock() }
    if let store { return store }
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: config.appGroup)
    else {
      throw Exception(
        name: "NoAppGroup", description: "App Group \(config.appGroup) is not available", code: "ERR_UNAVAILABLE")
    }
    do {
      let bridgeRoot = container.appendingPathComponent("bridge", isDirectory: true)
      let s = try BridgeStore(
        root: bridgeRoot, keys: KeychainKeyProvider(group: config.keychainGroup, createIfMissing: true))
      // reset() must also rotate the provider identity (spec 6.4, 6.9): old epochs then fail PROVIDER_CHANGED.
      s.onReset = Self.deleteContinuityKeys(group: config.keychainGroup)
      store = s
      root = bridgeRoot
      return s
    } catch {
      throw Self.map(error)
    }
  }

  private static func deleteContinuityKeys(group: String) -> () -> Void {
    { KeychainContinuityKeyStore(group: group).deleteAll() }
  }

  private func requireStore() throws -> BridgeStore {
    lock.lock()
    defer { lock.unlock() }
    guard let store else {
      throw Exception(name: "NotInitialised", description: "init has not run", code: "ERR_UNAVAILABLE")
    }
    return store
  }

  private func run<T>(_ body: (BridgeStore) throws -> T) throws -> T {
    let s = try requireStore()
    do {
      return try body(s)
    } catch {
      throw Self.map(error)
    }
  }

  private static func map(_ error: Error) -> Exception {
    if let e = error as? Exception { return e }
    switch error {
    case BridgeError.keyMissing:
      return Exception(name: "KeyMissing", description: "The sealing key is not available", code: "ERR_KEY_MISSING")
    case BridgeError.resetFinal:
      return Exception(name: "Reset", description: "The bridge was reset", code: "ERR_RESET")
    case BridgeError.invalidId:
      return Exception(name: "NotFound", description: "invalid id", code: "ERR_NOT_FOUND")
    default:
      return Exception(name: "Unavailable", description: "\(error)", code: "ERR_UNAVAILABLE")
    }
  }

  private static func data(_ base64: String) throws -> Data {
    guard let d = Data(base64Encoded: base64) else {
      throw Exception(name: "BadBase64", description: "value is not base64", code: "ERR_UNAVAILABLE")
    }
    return d
  }

  private static func int64(_ value: Any?, _ name: String) throws -> Int64 {
    guard let n = value as? NSNumber else {
      throw Exception(name: "BadArgument", description: "\(name) must be a number", code: "ERR_UNAVAILABLE")
    }
    return n.int64Value
  }

  #if DEBUG
    private static func rawFiles(under root: URL) -> [Data] {
      var out: [Data] = []
      let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])
      while let url = walker?.nextObject() as? URL {
        if (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
          let d = try? Data(contentsOf: url)
        {
          out.append(d)
        }
      }
      return out
    }
  #endif

  // MARK: Nudges (delivered only while the app is active)

  private func setWantsNudges(_ v: Bool) {
    lock.lock()
    wantsNudges = v
    lock.unlock()
    refreshObservation()
  }

  private func setActive(_ v: Bool) {
    lock.lock()
    isActive = v
    lock.unlock()
    refreshObservation()
  }

  private func stopObserving() {
    lock.lock()
    let o = observation
    observation = nil
    lock.unlock()
    o?.cancel()
  }

  private func refreshObservation() {
    lock.lock()
    let want = wantsNudges && isActive
    let group = appGroup
    let has = observation != nil
    lock.unlock()
    if want, !has, let group {
      let o = BridgeNudge.observe(appGroup: group) { [weak self] in
        self?.sendEvent("onNudge", [:])
      }
      lock.lock()
      observation = o
      lock.unlock()
    } else if !want, has {
      stopObserving()
    }
  }
}
