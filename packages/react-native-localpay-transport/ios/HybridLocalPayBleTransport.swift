import CoreBluetooth
import CoreNFC
import Foundation
import os

/// BLE rung of the local-payment transport: the second HybridObject in this
/// package, registered beside `HybridLocalPayTransport` (spec
/// docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md §1).
///
/// TASK 1 STUB. This file exists so the app LINKS CoreBluetooth (the ITMS-90683
/// store gate, spec "Why now") and so JS can already construct the object and
/// read its three prompt-free probes. Every transport method rejects with
/// "bluetooth unavailable", which the JS socket wrapper treats as a radio
/// failure, so any caller that reaches it floors to QR exactly as today. Task 8
/// replaces this whole file with the CoreBluetooth peripheral/central state
/// machines and adds ios/BleGattProfile.swift.
///
/// Prompt discipline (spec §7): instantiating ANY CB*Manager while
/// authorization is `.notDetermined` shows the system Bluetooth dialog.
/// Nothing in this file instantiates one; `prepare()` is the single method
/// allowed to, and only in Task 8.
final class HybridLocalPayBleTransport: HybridLocalPayBleTransportSpec {
  /// `log stream --predicate 'category == "LocalPayBle"'` shows every line.
  private static let logger = Logger(subsystem: "org.bsvblockchain.wallet", category: "LocalPayBle")

  /// Manager state as last reported to `prepare()`. Task 8 writes it from the
  /// CBPeripheralManager/CBCentralManager delegates; nothing writes it in this
  /// stub, so `bluetoothState()` answers "unknown" (never a guess) until the
  /// managers have actually been created. Spec §1: prompt-free by contract.
  private var lastKnownState: String?

  /// Every transport method of the stub fails the same way. Domain and message
  /// are part of the shared naming contract: the JS layer matches the text.
  private static func unavailable(_ method: String, code: Int) -> NSError {
    logger.info("\(method, privacy: .public): Task 1 stub, rejecting \"bluetooth unavailable\"")
    return NSError(domain: "LocalPayBleTransport", code: code,
                   userInfo: [NSLocalizedDescriptionKey: "bluetooth unavailable"])
  }

  // MARK: - Prompt-free probes (real)

  /// Hardware present and not denied. `.notDetermined` counts as supported so
  /// the payer's ladder can pick BLE and let the prompt follow (spec §7);
  /// `.denied`/`.restricted` is unsupported, which floors to QR with the
  /// `local_ble_denied` copy.
  func isSupported() throws -> Bool {
    switch CBManager.authorization {
    case .denied, .restricted:
      return false
    default:
      return true
    }
  }

  /// 'unauthorized' is knowable without a manager; everything else is not,
  /// so until `prepare()` has run the honest answer is 'unknown'.
  func bluetoothState() throws -> String {
    switch CBManager.authorization {
    case .denied, .restricted:
      return "unauthorized"
    default:
      return lastKnownState ?? "unknown"
    }
  }

  /// NFC reader hardware available and enabled (HINT_NFC, spec §4). The same
  /// call the YubiKey module uses; false on iPad and in the simulator.
  func nfcAvailable() throws -> Bool {
    return NFCReaderSession.readingAvailable
  }

  // MARK: - Transport (inert until Task 8)

  func prepare(timeoutMs: Double) throws -> Promise<String> {
    return Promise<String>.rejected(withError: Self.unavailable("prepare", code: 20))
  }

  func startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) throws -> Promise<Void> {
    return Promise<Void>.rejected(withError: Self.unavailable("startListening", code: 21))
  }

  func stopListening() throws -> Promise<Void> {
    return Promise<Void>.rejected(withError: Self.unavailable("stopListening", code: 22))
  }

  func confirmFrame(accepted: Bool, reason: String) throws -> Promise<Void> {
    return Promise<Void>.rejected(withError: Self.unavailable("confirmFrame", code: 23))
  }

  func sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ) throws -> Promise<String> {
    return Promise<String>.rejected(withError: Self.unavailable("sendFrame", code: 24))
  }
}
