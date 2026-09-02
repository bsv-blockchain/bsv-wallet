import CoreBluetooth
import Foundation
import os.log
#if canImport(CoreNFC)
import CoreNFC
#endif

/// One subsystem/category so Console.app can filter the whole rung with
/// `subsystem:org.bsvblockchain.wallet category:LocalPayBle` — the category the
/// Task 1 stub already logged under, and the same tag the Kotlin backend uses
/// for logcat, so every hardware checklist greps for one string.
private let bleLog = OSLog(subsystem: "org.bsvblockchain.wallet", category: "LocalPayBle")

/// LocalPayBleTransport over CoreBluetooth (design spec §2-§3, §7).
///
/// This class is only the Nitro-facing shell. `HybridLocalPayBleTransportSpec_base`
/// is a plain Swift class, not an `NSObject`, and every CoreBluetooth delegate
/// protocol requires `NSObjectProtocol`, so the state machine lives in
/// `BleEngine` below and this type forwards to it one-to-one.
final class HybridLocalPayBleTransport: HybridLocalPayBleTransportSpec {
  private let engine = BleEngine()

  func isSupported() throws -> Bool {
    engine.isSupported()
  }

  func bluetoothState() throws -> String {
    engine.bluetoothState()
  }

  func nfcAvailable() throws -> Bool {
    BleEngine.nfcAvailable()
  }

  func prepare(timeoutMs: Double) throws -> Promise<String> {
    engine.prepare(timeoutMs: timeoutMs)
  }

  func startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) throws -> Promise<Void> {
    engine.startListening(instanceName: instanceName, pskBase64: pskBase64, onFrame: onFrame, onError: onError)
  }

  func stopListening() throws -> Promise<Void> {
    engine.stopListening()
  }

  func confirmFrame(accepted: Bool, reason: String) throws -> Promise<Void> {
    engine.confirmFrame(accepted: accepted, reason: reason)
  }

  func sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ) throws -> Promise<String> {
    engine.sendFrame(
      instanceName: instanceName, pskBase64: pskBase64, frameBase64: frameBase64,
      timeoutMs: timeoutMs, connectTimeoutMs: connectTimeoutMs
    )
  }
}

// MARK: - Peripheral-side bookkeeping

/// Everything the payee holds between `startListening` and the ack. Confined
/// to `BleEngine.queue`.
private final class ListenSession {
  let instanceName: String
  let psk: Data
  let serviceUuid: CBUUID
  let onFrame: (String) -> Void
  let onError: (String) -> Void
  /// Outstanding until `peripheralManagerDidStartAdvertising` (or a failure).
  var startPromise: Promise<Void>?
  var service: CBMutableService?
  var frameChar: CBMutableCharacteristic?
  var ackChar: CBMutableCharacteristic?
  var centrals: [UUID: InboundCentral] = [:]
  /// First-success-wins latch, mirroring `HybridLocalPayTransport.hasAccepted`
  /// and the Kotlin backend's field of the same name: set the instant a FRAME
  /// from a bound central is validated, before `onFrame` and before any ack.
  var hasAccepted = false
  /// The central whose FRAME went to JS and has not been acknowledged. Held
  /// -- deliberately un-acked -- until JS calls `confirmFrame`.
  var pendingAck: InboundCentral?
  var pendingAckTimeout: DispatchWorkItem?
  /// Set by `confirmFrame` until the last ACK chunk has been queued.
  var ackPromise: Promise<Void>?
  var ackTarget: InboundCentral?
  /// True once the ack is queued: writes are refused and the service goes
  /// away when the payer leaves or the grace period ends.
  var closing = false
  var closeTimeout: DispatchWorkItem?

  init(instanceName: String, psk: Data, serviceUuid: CBUUID,
       onFrame: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
    self.instanceName = instanceName
    self.psk = psk
    self.serviceUuid = serviceUuid
    self.onFrame = onFrame
    self.onError = onError
  }
}

/// One connected central as the peripheral sees it.
private final class InboundCentral {
  enum Stage { case awaitingHello, bound }
  let central: CBCentral
  var stage: Stage = .awaitingHello
  /// Subscribed to the ACK characteristic. Without this HELLO_B/ACK have no
  /// route back, so HELLO_A from an unsubscribed central is refused.
  var subscribed = false
  var reassembler = BleGattProfile.Reassembler()
  var idleReaper: DispatchWorkItem?

  init(central: CBCentral) { self.central = central }
}

/// A queued indication chunk. `completion` fires when CoreBluetooth accepts
/// the chunk into its own transmit queue (`updateValue` returned true).
private struct Indication {
  let central: CBCentral
  let chunk: Data
  let completion: (() -> Void)?
}

private struct PrepareWaiter {
  let promise: Promise<String>
  let timeout: DispatchWorkItem
}

// MARK: - Engine

/// Owns both CoreBluetooth managers and every piece of mutable state.
///
/// Threading, verbatim from the AWDL backend's discipline: both managers are
/// created with `queue` as their delegate queue, so every delegate callback in
/// this file (and every `OutboundSend` peripheral-delegate callback) already
/// runs on `queue` and touches state directly. The public entry points are
/// called from the JS-bridge thread, never from `queue`, and wrap their
/// mutations in `queue.sync`. `dispatchPrecondition` makes the confinement an
/// enforced invariant rather than an accident of wiring.
final class BleEngine: NSObject {
  fileprivate let queue = DispatchQueue(label: "org.bsvassociation.localpay.ble")

  fileprivate var peripheralManager: CBPeripheralManager?
  fileprivate var centralManager: CBCentralManager?
  /// Latest state either manager reported. Read by the prompt-free probes.
  private var lastKnownState: CBManagerState = .unknown
  private var prepareWaiters: [PrepareWaiter] = []

  private var listening: ListenSession?
  /// Indication chunks waiting for `updateValue` to accept them. Drained by
  /// `flushIndications`, resumed by `peripheralManagerIsReady(toUpdateSubscribers:)`.
  private var indicationQueue: [Indication] = []

  private var activeSend: OutboundSend?

  /// How long the service stays registered after the ACK's last chunk was
  /// queued, in case the payer has not yet read it and disconnected. iOS only:
  /// Android's `BluetoothGattServer.notifyCharacteristicChanged` is
  /// synchronous with respect to `onNotificationSent`.
  private static let ackFlushGraceMs = 2_000

  // MARK: Probes (prompt-free)

  fileprivate static func describe(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .unknown, .resetting: return "unknown"
    @unknown default: return "unknown"
    }
  }

  /// `.unknown`/`.resetting` are transient. So is `.unauthorized` while the
  /// system prompt is still on screen (authorization `.notDetermined`).
  private static func isSettled(_ state: CBManagerState) -> Bool {
    switch state {
    case .unknown, .resetting: return false
    case .unauthorized: return CBManager.authorization != .notDetermined
    default: return true
    }
  }

  /// Hardware present, not denied, and — where a manager has already reported
  /// it in this process — not powered off. Prompt-free: nothing here creates a
  /// manager. `notDetermined` counts as supported so the ladder can pick BLE
  /// and let the prompt follow (spec §7). A radio that is merely off with no
  /// manager yet is indistinguishable from on without prompting; the ladder
  /// then tries BLE, sendFrame's fast "bluetooth unavailable" falls to the
  /// fountain, and the next scan in this process floors to QR with the
  /// local_bt_off copy (spec §5).
  func isSupported() -> Bool {
    switch CBManager.authorization {
    case .denied, .restricted: return false
    default: break
    }
    return queue.sync {
      switch self.lastKnownState {
      case .unsupported, .poweredOff: return false
      default: return true
      }
    }
  }

  func bluetoothState() -> String {
    queue.sync { self.stateString() }
  }

  static func nfcAvailable() -> Bool {
    #if canImport(CoreNFC)
    return NFCNDEFReaderSession.readingAvailable
    #else
    return false
    #endif
  }

  /// Runs on `queue`. Prefers a live manager's settled state; before any
  /// manager exists, all that can be known without prompting is authorization.
  private func stateString() -> String {
    dispatchPrecondition(condition: .onQueue(queue))
    if let cm = centralManager, Self.isSettled(cm.state) { return Self.describe(cm.state) }
    if let pm = peripheralManager, Self.isSettled(pm.state) { return Self.describe(pm.state) }
    if Self.isSettled(lastKnownState) { return Self.describe(lastKnownState) }
    switch CBManager.authorization {
    case .denied, .restricted: return "unauthorized"
    default: return "unknown"
    }
  }

  // MARK: Managers and prepare()

  /// The one place a `CB*Manager` is constructed -- and therefore the one
  /// place the iOS Bluetooth privacy prompt can appear. Runs on `queue`.
  private func ensureManagers() {
    dispatchPrecondition(condition: .onQueue(queue))
    if peripheralManager == nil {
      peripheralManager = CBPeripheralManager(
        delegate: self, queue: queue,
        options: [CBPeripheralManagerOptionShowPowerAlertKey: false]
      )
    }
    if centralManager == nil {
      centralManager = CBCentralManager(
        delegate: self, queue: queue,
        options: [CBCentralManagerOptionShowPowerAlertKey: false]
      )
    }
  }

  private var managersSettled: Bool {
    guard let pm = peripheralManager, let cm = centralManager else { return false }
    return Self.isSettled(pm.state) && Self.isSettled(cm.state)
  }

  func prepare(timeoutMs: Double) -> Promise<String> {
    let promise = Promise<String>()
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      self.ensureManagers()
      if self.managersSettled {
        let state = self.stateString()
        os_log("prepare resolved state=%{public}@", log: bleLog, type: .default, state)
        promise.resolve(withResult: state)
        return
      }
      let timeout = DispatchWorkItem { [weak self] in
        guard let self else { return }
        dispatchPrecondition(condition: .onQueue(self.queue))
        guard let idx = self.prepareWaiters.firstIndex(where: { $0.promise === promise }) else { return }
        self.prepareWaiters.remove(at: idx)
        let state = self.stateString()
        os_log("prepare timed out state=%{public}@", log: bleLog, type: .default, state)
        promise.resolve(withResult: state)
      }
      self.prepareWaiters.append(PrepareWaiter(promise: promise, timeout: timeout))
      self.queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(timeoutMs))), execute: timeout)
    }
    return promise
  }

  private func stateChanged(_ state: CBManagerState) {
    dispatchPrecondition(condition: .onQueue(queue))
    lastKnownState = state
    guard managersSettled, !prepareWaiters.isEmpty else { return }
    let waiters = prepareWaiters
    prepareWaiters.removeAll()
    let result = stateString()
    os_log("prepare resolved state=%{public}@", log: bleLog, type: .default, result)
    for w in waiters {
      w.timeout.cancel()
      w.promise.resolve(withResult: result)
    }
  }

  // MARK: Payee: startListening / stopListening / confirmFrame

  func startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) -> Promise<Void> {
    let promise = Promise<Void>()
    guard let psk = Data(base64Encoded: pskBase64), !instanceName.isEmpty else {
      promise.reject(withError: BleGattProfile.error("bad psk or instance name", code: 10))
      return promise
    }
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      // Self-reset (spec §3 step 2): a previous session that was never
      // explicitly stopped must not leak its latch, centrals or reapers.
      self.resetListening()
      self.ensureManagers()
      let session = ListenSession(
        instanceName: instanceName, psk: psk,
        serviceUuid: BleGattProfile.serviceUuid(psk: psk, instanceName: instanceName),
        onFrame: onFrame, onError: onError
      )
      session.startPromise = promise
      self.listening = session
      self.advertiseIfPowered()
    }
    return promise
  }

  /// Adds the session service once the peripheral manager is powered on.
  /// Called from `startListening` and again from `peripheralManagerDidUpdateState`
  /// when the manager was still settling at that point.
  private func advertiseIfPowered() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, session.service == nil, let pm = peripheralManager else { return }
    switch pm.state {
    case .poweredOn:
      break
    case .unknown, .resetting:
      return
    case .unauthorized where CBManager.authorization == .notDetermined:
      return
    default:
      failStart(session, message: "bluetooth unavailable")
      return
    }
    let frame = CBMutableCharacteristic(
      type: BleGattProfile.frameCharUuid,
      properties: [.write, .writeWithoutResponse],
      value: nil,
      permissions: [.writeable]
    )
    let ack = CBMutableCharacteristic(
      type: BleGattProfile.ackCharUuid,
      properties: [.indicate],
      value: nil,
      permissions: [.readable]
    )
    let service = CBMutableService(type: session.serviceUuid, primary: true)
    service.characteristics = [frame, ack]
    session.frameChar = frame
    session.ackChar = ack
    session.service = service
    pm.add(service)
  }

  private func failStart(_ session: ListenSession, message: String) {
    dispatchPrecondition(condition: .onQueue(queue))
    if let promise = session.startPromise {
      session.startPromise = nil
      promise.reject(withError: BleGattProfile.error(message, code: 16))
    }
    resetListening()
  }

  /// Tears the current listen session down: advertising, service, every
  /// central's state, every reaper, every queued indication. Runs on `queue`.
  private func resetListening() {
    dispatchPrecondition(condition: .onQueue(queue))
    indicationQueue.removeAll()
    if let session = listening {
      session.centrals.values.forEach { $0.idleReaper?.cancel() }
      session.pendingAckTimeout?.cancel()
      session.closeTimeout?.cancel()
      if let promise = session.startPromise {
        session.startPromise = nil
        promise.reject(withError: BleGattProfile.error("listener reset", code: 17))
      }
      if let promise = session.ackPromise {
        session.ackPromise = nil
        promise.reject(withError: BleGattProfile.error("listener reset", code: 17))
      }
    }
    listening = nil
    if let pm = peripheralManager, pm.state == .poweredOn {
      if pm.isAdvertising { pm.stopAdvertising() }
      pm.removeAllServices()
    }
  }

  func stopListening() -> Promise<Void> {
    let promise = Promise<Void>()
    // Called from the JS-bridge thread, never from `queue` itself. JS must not
    // call this on the success path (it drops the central the ack has to go
    // to) -- see the `teardown` flag in core/localpay/transport/socket.ts.
    queue.sync {
      os_log("listener stopped by JS", log: bleLog, type: .default)
      self.resetListening()
    }
    promise.resolve(withResult: ())
    return promise
  }

  /// Sends the ACK to the central held since `onFrame`, then closes the
  /// session. `accepted: true` only after JS has durably queued the payment;
  /// `accepted: false` only where nothing was queued (spec §9). Idempotent
  /// with nothing pending. Rejects only if the ack cannot reach the central.
  func confirmFrame(accepted: Bool, reason: String) -> Promise<Void> {
    let promise = Promise<Void>()
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      guard let session = self.listening else {
        promise.resolve(withResult: ())
        return
      }
      session.pendingAckTimeout?.cancel()
      session.pendingAckTimeout = nil
      guard let target = session.pendingAck else {
        promise.resolve(withResult: ())
        return
      }
      session.pendingAck = nil
      guard target.subscribed, let pm = self.peripheralManager, pm.state == .poweredOn else {
        promise.reject(withError: BleGattProfile.error("peer disconnected before acking", code: 21))
        self.resetListening()
        return
      }
      // The session is over either way: nobody else gets HELLO_B or a FRAME in.
      for other in session.centrals.values where other !== target {
        self.forget(other, in: session)
      }
      let json = accepted ? BleGattProfile.okJson : BleGattProfile.declineJson(reason: reason)
      let message = BleGattProfile.ackMessage(
        psk: session.psk, instanceName: session.instanceName, ackJson: Data(json.utf8)
      )
      session.ackPromise = promise
      session.ackTarget = target
      session.closing = true
      self.enqueueIndication(message, to: target.central) { [weak self] in
        guard let self, let session = self.listening, session.ackPromise === promise else { return }
        session.ackPromise = nil
        os_log("ack sent ok=%d bytes=%ld", log: bleLog, type: .default, accepted ? 1 : 0, message.count)
        promise.resolve(withResult: ())
        self.scheduleClose(session)
      }
    }
    return promise
  }

  private func scheduleClose(_ session: ListenSession) {
    dispatchPrecondition(condition: .onQueue(queue))
    let item = DispatchWorkItem { [weak self] in
      guard let self, self.listening === session else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))
      self.resetListening()
    }
    session.closeTimeout = item
    queue.asyncAfter(deadline: .now() + .milliseconds(Self.ackFlushGraceMs), execute: item)
  }

  // MARK: Payee: per-central state

  private func inbound(for central: CBCentral, in session: ListenSession) -> InboundCentral {
    dispatchPrecondition(condition: .onQueue(queue))
    if let existing = session.centrals[central.identifier] { return existing }
    let entry = InboundCentral(central: central)
    session.centrals[central.identifier] = entry
    armIdleReaper(entry, in: session)
    return entry
  }

  /// 30 s idle reaper per central (spec §3 step 3). Silent: a stranger that
  /// connected to the advertisement and never completed HELLO is not a failed
  /// payment, and `onError` is scoped to the one accepted payment per session.
  private func armIdleReaper(_ entry: InboundCentral, in session: ListenSession) {
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))
      guard let session = self.listening,
            let current = session.centrals[entry.central.identifier], current === entry else { return }
      os_log("idle central forgotten id=%{public}@", log: bleLog, type: .default, entry.central.identifier.uuidString)
      self.forget(current, in: session)
    }
    entry.idleReaper = item
    queue.asyncAfter(deadline: .now() + .milliseconds(BleGattProfile.idleConnectionTimeoutMs), execute: item)
  }

  /// CoreBluetooth offers no peripheral-side disconnect. Forgetting a central
  /// means: its state is gone, its queued indications are dropped, and its
  /// further writes are answered `insufficientAuthorization`.
  private func forget(_ entry: InboundCentral, in session: ListenSession) {
    dispatchPrecondition(condition: .onQueue(queue))
    entry.idleReaper?.cancel()
    entry.idleReaper = nil
    session.centrals.removeValue(forKey: entry.central.identifier)
    let id = entry.central.identifier
    indicationQueue.removeAll { $0.central.identifier == id }
  }

  /// 60 s ack reaper (spec §3 step 7). Tears down SILENTLY -- never a
  /// synthesised negative ack -- for the reasons spelled out at
  /// HybridLocalPayTransport.pendingAckConfirmTimeout: a negative ack releases
  /// the payer's inputs, and a payee that is merely slow may still succeed.
  private func armAckReaper(_ entry: InboundCentral, in session: ListenSession) {
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))
      guard let session = self.listening, session.pendingAck === entry else { return }
      session.pendingAck = nil
      session.pendingAckTimeout = nil
      self.forget(entry, in: session)
      session.onError("payee never confirmed the payment; connection released")
    }
    session.pendingAckTimeout = item
    queue.asyncAfter(deadline: .now() + .milliseconds(BleGattProfile.pendingAckTimeoutMs), execute: item)
  }

  /// Dispatches one reassembled message from one central (spec §3 steps 4-5).
  private func handle(message: Data, from entry: InboundCentral, in session: ListenSession) {
    dispatchPrecondition(condition: .onQueue(queue))
    // An earlier message in the same write batch may already have forgotten it.
    guard session.centrals[entry.central.identifier] === entry, !message.isEmpty else { return }
    let type = message[message.startIndex]
    let body = Data(message.dropFirst())
    let id = entry.central.identifier.uuidString

    switch (type, entry.stage) {
    case (BleGattProfile.typeHelloA, .awaitingHello):
      let expected = BleGattProfile.proof(psk: session.psk, instanceName: session.instanceName, type: BleGattProfile.typeHelloA)
      guard entry.subscribed, BleGattProfile.constantTimeEquals(body, expected) else {
        // Wrong PSK, or no route back for HELLO_B: forget it, keep advertising.
        os_log("hello rejected id=%{public}@", log: bleLog, type: .default, id)
        forget(entry, in: session)
        return
      }
      entry.stage = .bound
      os_log("hello verified id=%{public}@", log: bleLog, type: .default, id)
      enqueueIndication(
        BleGattProfile.helloB(psk: session.psk, instanceName: session.instanceName),
        to: entry.central, completion: nil
      )

    case (BleGattProfile.typeFrame, .bound):
      // First-success-wins as a native invariant: a second PSK-holder reaching
      // FRAME after we accepted one is refused outright, never raced.
      guard !session.hasAccepted, !body.isEmpty else {
        forget(entry, in: session)
        return
      }
      session.hasAccepted = true
      entry.idleReaper?.cancel()
      entry.idleReaper = nil
      // Stop advertising immediately so nothing else can connect, rather than
      // waiting for JS to round-trip stopListening().
      if let pm = peripheralManager, pm.isAdvertising { pm.stopAdvertising() }
      // Arm the hold BEFORE handing the frame over (see
      // HybridLocalPayTransport.acceptConnection for why the order matters).
      session.pendingAck = entry
      armAckReaper(entry, in: session)
      os_log("frame accepted bytes=%ld id=%{public}@", log: bleLog, type: .default, body.count, id)
      session.onFrame(body.base64EncodedString())

    default:
      // FRAME before HELLO, a second HELLO, or an unknown type: protocol violation.
      forget(entry, in: session)
    }
  }

  // MARK: Payee: indications with backpressure

  private func enqueueIndication(_ message: Data, to central: CBCentral, completion: (() -> Void)?) {
    dispatchPrecondition(condition: .onQueue(queue))
    let parts = BleGattProfile.chunks(BleGattProfile.lengthPrefixed(message), size: central.maximumUpdateValueLength)
    for (i, part) in parts.enumerated() {
      indicationQueue.append(Indication(central: central, chunk: part, completion: i == parts.count - 1 ? completion : nil))
    }
    flushIndications()
  }

  /// `updateValue` returns false when CoreBluetooth's transmit queue is full;
  /// the remainder waits for `peripheralManagerIsReady(toUpdateSubscribers:)`.
  private func flushIndications() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let pm = peripheralManager, let session = listening, let ack = session.ackChar else {
      indicationQueue.removeAll()
      return
    }
    while let next = indicationQueue.first {
      guard pm.updateValue(next.chunk, for: ack, onSubscribedCentrals: [next.central]) else { return }
      indicationQueue.removeFirst()
      next.completion?()
    }
  }

  // MARK: Payer: sendFrame

  func sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ) -> Promise<String> {
    let promise = Promise<String>()
    guard let psk = Data(base64Encoded: pskBase64),
          let sealed = Data(base64Encoded: frameBase64),
          !instanceName.isEmpty else {
      promise.reject(withError: BleGattProfile.error("bad psk or frame", code: 11))
      return promise
    }
    // Type byte + sealed body must fit one profile message (spec §3).
    guard sealed.count + 1 <= BleGattProfile.maxBleFrameBytes else {
      promise.reject(withError: BleGattProfile.error("frame too large for a BLE payload", code: 30))
      return promise
    }
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      self.ensureManagers()
      // JS may have abandoned an earlier send (its own abort) and retried
      // before our timeouts fired; the newer send wins.
      if let previous = self.activeSend {
        previous.settle(.failure(BleGattProfile.error("superseded by a newer send", code: 15)))
      }
      let send = OutboundSend(
        engine: self, instanceName: instanceName, psk: psk, sealed: sealed, promise: promise
      )
      self.activeSend = send
      send.start(timeoutMs: timeoutMs, connectTimeoutMs: connectTimeoutMs)
    }
    return promise
  }

  /// Called by `OutboundSend.settle` on `queue`: releases the radio.
  fileprivate func finishSend(_ send: OutboundSend) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard activeSend === send else { return }
    activeSend = nil
    guard let cm = centralManager else { return }
    if send.isScanning { cm.stopScan() }
    if let p = send.peripheral, p.state != .disconnected { cm.cancelPeripheralConnection(p) }
  }
}

// MARK: - CBPeripheralManagerDelegate (payee)

extension BleEngine: CBPeripheralManagerDelegate {
  func peripheralManagerDidUpdateState(_ pm: CBPeripheralManager) {
    dispatchPrecondition(condition: .onQueue(queue))
    os_log("peripheral manager state=%{public}@", log: bleLog, type: .default, Self.describe(pm.state))
    stateChanged(pm.state)
    guard let session = listening else { return }
    switch pm.state {
    case .poweredOn:
      advertiseIfPowered()
    case .unknown, .resetting:
      break
    case .unauthorized where CBManager.authorization == .notDetermined:
      break
    default:
      if session.startPromise != nil {
        failStart(session, message: "bluetooth unavailable")
      } else if !session.closing {
        let onError = session.onError
        resetListening()
        onError("bluetooth unavailable")
      } else {
        resetListening()
      }
    }
  }

  func peripheralManager(_ pm: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, session.service?.uuid == service.uuid else { return }
    if let error {
      failStart(session, message: error.localizedDescription)
      return
    }
    pm.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [session.serviceUuid],
      CBAdvertisementDataLocalNameKey: BleGattProfile.localName
    ])
  }

  func peripheralManagerDidStartAdvertising(_ pm: CBPeripheralManager, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening else { return }
    if let error {
      failStart(session, message: error.localizedDescription)
      return
    }
    os_log("advertising started service=%{public}@ name=%{public}@", log: bleLog, type: .default,
           session.serviceUuid.uuidString, session.instanceName)
    if let promise = session.startPromise {
      session.startPromise = nil
      promise.resolve(withResult: ())
    }
  }

  func peripheralManager(_ pm: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, characteristic.uuid == BleGattProfile.ackCharUuid, !session.closing else { return }
    // A subscriber after acceptance can never be bound (advertising stopped
    // before it could have discovered us); do not track it.
    guard !session.hasAccepted || session.centrals[central.identifier] != nil else { return }
    let entry = inbound(for: central, in: session)
    entry.subscribed = true
    os_log("central connected id=%{public}@ maxUpdate=%ld", log: bleLog, type: .default,
           central.identifier.uuidString, central.maximumUpdateValueLength)
  }

  func peripheralManager(_ pm: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, let entry = session.centrals[central.identifier] else { return }
    entry.subscribed = false
    let id = central.identifier
    indicationQueue.removeAll { $0.central.identifier == id }
    if let promise = session.ackPromise, session.ackTarget === entry {
      // Mid-ack disconnect: the ack did not fully leave this device.
      session.ackPromise = nil
      promise.reject(withError: BleGattProfile.error("peer disconnected before acking", code: 21))
      resetListening()
      return
    }
    if session.closing, session.ackTarget === entry {
      // The payer read its ack and left: no need to wait out the grace period.
      resetListening()
      return
    }
    if session.pendingAck !== entry {
      // Not the held central: an idle or refused stranger leaving.
      forget(entry, in: session)
    }
    // If it IS the held central (payer gave up before JS confirmed), keep the
    // entry with subscribed == false so confirmFrame reports the failure
    // instead of silently succeeding into nowhere.
  }

  func peripheralManager(_ pm: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let first = requests.first else { return }
    guard let session = listening, !session.closing else {
      pm.respond(to: first, withResult: .insufficientAuthorization)
      return
    }
    var result: CBATTError.Code = .success
    for request in requests {
      guard request.characteristic.uuid == BleGattProfile.frameCharUuid else {
        result = .attributeNotFound
        continue
      }
      let entry: InboundCentral
      if let existing = session.centrals[request.central.identifier] {
        entry = existing
      } else if session.hasAccepted {
        result = .insufficientAuthorization
        continue
      } else {
        entry = inbound(for: request.central, in: session)
      }
      guard let value = request.value, !value.isEmpty else { continue }
      do {
        // Long (prepared) writes arrive as several requests with offsets, in
        // order; appending in array order is correct for a byte stream.
        let messages = try entry.reassembler.feed(value)
        for message in messages {
          handle(message: message, from: entry, in: session)
        }
      } catch {
        forget(entry, in: session)
        result = .invalidAttributeValueLength
      }
    }
    // One response per batch, on the first request (CBPeripheralManager
    // contract). CoreBluetooth ignores it for write-without-response requests,
    // which it cannot distinguish for us on CBATTRequest.
    pm.respond(to: first, withResult: result)
  }

  func peripheralManagerIsReady(toUpdateSubscribers pm: CBPeripheralManager) {
    dispatchPrecondition(condition: .onQueue(queue))
    flushIndications()
  }
}

// MARK: - CBCentralManagerDelegate (payer) -- forwards to the active send

extension BleEngine: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ cm: CBCentralManager) {
    dispatchPrecondition(condition: .onQueue(queue))
    os_log("central manager state=%{public}@", log: bleLog, type: .default, Self.describe(cm.state))
    stateChanged(cm.state)
    activeSend?.managerStateChanged(cm.state)
  }

  func centralManager(_ cm: CBCentralManager, didDiscover peripheral: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didDiscover(peripheral, rssi: RSSI)
  }

  func centralManager(_ cm: CBCentralManager, didConnect peripheral: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didConnect(peripheral)
  }

  func centralManager(_ cm: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didFailToConnect(peripheral, error: error)
  }

  func centralManager(_ cm: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didDisconnect(peripheral, error: error)
  }
}

// MARK: - One payer-side send (spec §3, central state machine)

/// Scan → connect → discover → subscribe → HELLO_A → HELLO_B → FRAME → ACK.
/// Owns its own `settled` latch, both timers and the peripheral delegate for
/// the one peripheral it connects to. All callbacks arrive on `engine.queue`
/// because that is the central manager's delegate queue and CBPeripheral
/// delegates inherit it.
private final class OutboundSend: NSObject, CBPeripheralDelegate {
  private enum Stage {
    case scanning, connecting, discoveringServices, discoveringCharacteristics,
         subscribing, sendingHello, awaitingHelloB, writingFrame, awaitingAck
  }

  private weak var engine: BleEngine?
  private let queue: DispatchQueue
  private let instanceName: String
  private let psk: Data
  private let sealed: Data
  private let serviceUuid: CBUUID
  private let promise: Promise<String>

  private var stage: Stage = .scanning
  private(set) var isScanning = false
  private(set) var peripheral: CBPeripheral?
  private var frameChar: CBCharacteristic?
  private var ackChar: CBCharacteristic?
  private var reassembler = BleGattProfile.Reassembler()
  private var helloChunks: [Data] = []
  private var frameChunks: [Data] = []
  private var frameBytes = 0
  private var settled = false
  /// True once the ACK subscription is confirmed: the connect budget is met.
  private var connectPhaseDone = false
  private var wholeTimeout: DispatchWorkItem?
  private var connectTimeout: DispatchWorkItem?
  private let startedAt = DispatchTime.now()
  private var frameStartedAt: DispatchTime?

  init(engine: BleEngine, instanceName: String, psk: Data, sealed: Data, promise: Promise<String>) {
    self.engine = engine
    self.queue = engine.queue
    self.instanceName = instanceName
    self.psk = psk
    self.sealed = sealed
    self.serviceUuid = BleGattProfile.serviceUuid(psk: psk, instanceName: instanceName)
    self.promise = promise
    super.init()
  }

  private func elapsedMs(since start: DispatchTime) -> Int {
    Int((DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000)
  }

  /// Runs on `queue`. `connectTimeoutMs` covers scan + connect + discovery +
  /// subscribe (spec §3 step 8); `timeoutMs` covers the whole exchange.
  func start(timeoutMs: Double, connectTimeoutMs: Double) {
    dispatchPrecondition(condition: .onQueue(queue))
    let whole = DispatchWorkItem { [weak self] in
      self?.settle(.failure(BleGattProfile.error("timed out waiting for peer", code: 12)))
    }
    wholeTimeout = whole
    queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(timeoutMs))), execute: whole)

    let connect = DispatchWorkItem { [weak self] in
      guard let self, !self.connectPhaseDone else { return }
      self.settle(.failure(BleGattProfile.error("connect timeout: no route to peer", code: 14)))
    }
    connectTimeout = connect
    queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(connectTimeoutMs))), execute: connect)

    if let cm = engine?.centralManager {
      managerStateChanged(cm.state)
    }
  }

  /// Settle latch, as in `HybridLocalPayTransport.sendFrame`: every caller is
  /// on `queue`, so a plain Bool is safe and the precondition enforces it.
  func settle(_ result: Result<String, Error>) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled else { return }
    settled = true
    wholeTimeout?.cancel()
    connectTimeout?.cancel()
    engine?.finishSend(self)
    isScanning = false
    switch result {
    case .success(let ack): promise.resolve(withResult: ack)
    case .failure(let error): promise.reject(withError: error)
    }
  }

  // MARK: Central manager events (forwarded by BleEngine)

  func managerStateChanged(_ state: CBManagerState) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .scanning, !isScanning, let cm = engine?.centralManager else { return }
    switch state {
    case .poweredOn:
      isScanning = true
      cm.scanForPeripherals(withServices: [serviceUuid],
                            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
      os_log("scanning service=%{public}@", log: bleLog, type: .default, serviceUuid.uuidString)
    case .unknown, .resetting:
      break
    case .unauthorized where CBManager.authorization == .notDetermined:
      break
    default:
      settle(.failure(BleGattProfile.error("bluetooth unavailable", code: 16)))
    }
  }

  func didDiscover(_ p: CBPeripheral, rssi: NSNumber) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .scanning, let cm = engine?.centralManager else { return }
    // The filter already matched the per-session UUID: first hit is the payee.
    cm.stopScan()
    isScanning = false
    stage = .connecting
    peripheral = p
    p.delegate = self
    os_log("scan hit rssi=%d id=%{public}@ ms=%ld", log: bleLog, type: .default,
           rssi.int32Value, p.identifier.uuidString, elapsedMs(since: startedAt))
    cm.connect(p, options: nil)
  }

  func didConnect(_ p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, p === peripheral, stage == .connecting else { return }
    stage = .discoveringServices
    os_log("connected id=%{public}@ maxWriteLen=%ld ms=%ld", log: bleLog, type: .default,
           p.identifier.uuidString, p.maximumWriteValueLength(for: .withoutResponse), elapsedMs(since: startedAt))
    p.discoverServices([serviceUuid])
  }

  func didFailToConnect(_ p: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    settle(.failure(error ?? BleGattProfile.error("connect failed", code: 18)))
  }

  func didDisconnect(_ p: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral, !settled else { return }
    switch stage {
    case .sendingHello, .awaitingHelloB, .writingFrame, .awaitingAck:
      settle(.failure(BleGattProfile.error("peer disconnected before acking", code: 21)))
    default:
      settle(.failure(error ?? BleGattProfile.error("peer disconnected", code: 19)))
    }
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .discoveringServices else { return }
    if let error { return settle(.failure(error)) }
    guard let service = p.services?.first(where: { $0.uuid == serviceUuid }) else {
      return settle(.failure(BleGattProfile.error("session service not found on peer", code: 20)))
    }
    stage = .discoveringCharacteristics
    p.discoverCharacteristics([BleGattProfile.frameCharUuid, BleGattProfile.ackCharUuid], for: service)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .discoveringCharacteristics, service.uuid == serviceUuid else { return }
    if let error { return settle(.failure(error)) }
    let chars = service.characteristics ?? []
    guard let frame = chars.first(where: { $0.uuid == BleGattProfile.frameCharUuid }),
          let ack = chars.first(where: { $0.uuid == BleGattProfile.ackCharUuid }) else {
      return settle(.failure(BleGattProfile.error("session characteristics not found on peer", code: 20)))
    }
    frameChar = frame
    ackChar = ack
    stage = .subscribing
    p.setNotifyValue(true, for: ack)
  }

  func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .subscribing, characteristic.uuid == BleGattProfile.ackCharUuid else { return }
    if let error { return settle(.failure(error)) }
    guard characteristic.isNotifying, let frame = frameChar else {
      return settle(.failure(BleGattProfile.error("peer refused the ack subscription", code: 20)))
    }
    // Connect phase complete (spec §3 step 8): the connect budget no longer applies.
    connectPhaseDone = true
    connectTimeout?.cancel()
    os_log("subscribed ms=%ld", log: bleLog, type: .default, elapsedMs(since: startedAt))

    // HELLO_A, chunked like everything else and written WITH response so the
    // peripheral's reply to the last chunk doubles as delivery confirmation.
    let framed = BleGattProfile.lengthPrefixed(BleGattProfile.helloA(psk: psk, instanceName: instanceName))
    helloChunks = BleGattProfile.chunks(framed, size: p.maximumWriteValueLength(for: .withoutResponse))
    stage = .sendingHello
    writeNextHelloChunk(p, frame)
  }

  private func writeNextHelloChunk(_ p: CBPeripheral, _ frame: CBCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !helloChunks.isEmpty else { return }
    let chunk = helloChunks.removeFirst()
    if helloChunks.isEmpty {
      // HELLO_B may arrive before the write response to this final chunk.
      stage = .awaitingHelloB
    }
    p.writeValue(chunk, for: frame, type: .withResponse)
  }

  func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, characteristic.uuid == BleGattProfile.frameCharUuid else { return }
    if let error { return settle(.failure(error)) }
    if stage == .sendingHello, let frame = frameChar {
      writeNextHelloChunk(p, frame)
    }
  }

  func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, characteristic.uuid == BleGattProfile.ackCharUuid else { return }
    if let error { return settle(.failure(error)) }
    guard let value = characteristic.value, !value.isEmpty else { return }
    let messages: [Data]
    do {
      messages = try reassembler.feed(value)
    } catch {
      return settle(.failure(error))
    }
    for message in messages where !settled {
      handle(message: message, on: p)
    }
  }

  private func handle(message: Data, on p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !message.isEmpty else { return }
    let type = message[message.startIndex]
    let body = Data(message.dropFirst())

    switch (type, stage) {
    case (BleGattProfile.typeHelloB, .awaitingHelloB), (BleGattProfile.typeHelloB, .sendingHello):
      let expected = BleGattProfile.proof(psk: psk, instanceName: instanceName, type: BleGattProfile.typeHelloB)
      guard BleGattProfile.constantTimeEquals(body, expected) else {
        return settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      os_log("hello verified ms=%ld", log: bleLog, type: .default, elapsedMs(since: startedAt))
      let framed = BleGattProfile.lengthPrefixed(BleGattProfile.frameMessage(sealed: sealed))
      frameBytes = framed.count
      frameChunks = BleGattProfile.chunks(framed, size: p.maximumWriteValueLength(for: .withoutResponse))
      frameStartedAt = DispatchTime.now()
      stage = .writingFrame
      pumpWrites()

    case (BleGattProfile.typeAck, .awaitingAck):
      guard body.count > BleGattProfile.macLength else {
        return settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      let json = Data(body.prefix(body.count - BleGattProfile.macLength))
      let mac = Data(body.suffix(BleGattProfile.macLength))
      let expected = BleGattProfile.ackMac(psk: psk, instanceName: instanceName, ackJson: json)
      guard BleGattProfile.constantTimeEquals(mac, expected) else {
        return settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      os_log("ack verified bytes=%ld ms=%ld", log: bleLog, type: .default, json.count, elapsedMs(since: startedAt))
      // MAC stripped: JS's parseAck sees exactly the AWDL/Nearby ack JSON.
      settle(.success(json.base64EncodedString()))

    default:
      settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
    }
  }

  /// Write-without-response with real backpressure (spec §3 step 6): stop
  /// when CoreBluetooth's buffer is full, resume from
  /// `peripheralIsReady(toSendWriteWithoutResponse:)`. No pacing sleeps.
  private func pumpWrites() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .writingFrame, let p = peripheral, let frame = frameChar else { return }
    while !frameChunks.isEmpty {
      guard p.canSendWriteWithoutResponse else { return }
      let chunk = frameChunks.removeFirst()
      p.writeValue(chunk, for: frame, type: .withoutResponse)
    }
    stage = .awaitingAck
    let ms = frameStartedAt.map { elapsedMs(since: $0) } ?? 0
    os_log("frame written bytes=%ld ms=%ld", log: bleLog, type: .default, frameBytes, ms)
  }

  func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    pumpWrites()
  }
}
