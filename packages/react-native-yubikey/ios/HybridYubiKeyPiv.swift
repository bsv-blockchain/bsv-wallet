import CoreNFC
import Foundation
import Security
import YubiKit

/**
 * YubiKeyPiv over Yubico's YubiKit, NFC transport (`YKFNFCConnection` +
 * `YKFPIVSession`).
 *
 * WHY NFC and not USB-C on iOS: the USB-C smart-card path
 * (`YKFSmartCardConnection`) needs `com.apple.security.smartcard`, a macOS App
 * Sandbox entitlement that iOS App Store validation rejects. NFC ISO7816 is the
 * only App-Store-valid way for a third-party app to reach a YubiKey's PIV
 * applet on iOS, via the `com.apple.developer.nfc.readersession.formats` (TAG)
 * capability + the iso7816 select-identifiers in Info.plist. It requires an
 * NFC-capable key (e.g. YubiKey 5C NFC). Android keeps USB-C CCID.
 *
 * NFC lifecycle: unlike a persistent USB reader, an NFC session is a modal tap
 * — `startNFCConnection()` shows the system scan sheet, the user holds the key
 * to the top of the phone, `didConnectNFC` fires, and the connection stays open
 * (so a whole ceremony — verify PIN then touch-gated signing — runs in ONE tap)
 * until `stopNFCConnection()`. So the JS layer calls start() only when a
 * ceremony begins (never at launch), and stop() when it arms or fails.
 *
 * Every rejection carries a `VAULT_ERR:<code>:<detail>` message (see `mapError`)
 * so the JS vault layer can branch on a stable machine code. Completion handlers
 * are all guarded — a dropped tap or a YubiKit error becomes a rejection.
 */
final class HybridYubiKeyPiv: HybridYubiKeyPivSpec {
  /// (eventType, serial, transport) -> Void. Nitro dispatches the call to JS.
  private var listener: ((String, String, String) -> Void)?
  /// The connection for the key currently on a reader. Set on didConnect*,
  /// cleared on didDisconnect*. Every operation runs against this.
  fileprivate var activeConnection: (any YKFConnectionProtocol)?
  /// YKFManagerDelegate requires an NSObject conformer, which this Nitro
  /// HybridObject is not — so the delegate lives on a separate NSObject that
  /// forwards connect/disconnect back here. Held strong; YubiKitManager keeps
  /// only a weak reference.
  private lazy var connDelegate: ConnectionDelegate = {
    let d = ConnectionDelegate()
    d.owner = self
    return d
  }()
  private static let attestationAuthorities = Result {
    try YubicoPivAttestation.loadBundledAuthorities()
  }

  // MARK: - Capability

  /// NFC ISO7816 needs iOS 13+ and NFC hardware. There is no App-Store-valid
  /// USB-C smart-card path on iOS, so when NFC is unavailable the JS layer
  /// treats the device as reader-less and stays on its software-key path.
  func isSupported() throws -> Bool {
    if #available(iOS 13, *) { return NFCReaderSession.readingAvailable } else { return false }
  }

  // MARK: - Discovery (an NFC tap)

  /// Begin an NFC session — the JS layer calls this only when a ceremony needs a
  /// key, NEVER at launch (it presents the system scan sheet). The session stays
  /// open across the whole ceremony until stopDiscovery().
  ///
  /// Throws (instead of YubiKit's silent YKFAssertReturn no-op) when NFC
  /// reading is unavailable RIGHT NOW: `readingAvailable` goes false not just
  /// on non-NFC hardware but transiently when the system NFC daemon (nfcd) is
  /// wedged — a state only a device restart clears, observed in production
  /// after interrupted scan sessions. Silence here was one of the "modal never
  /// appears and nothing is reported" paths.
  func startDiscovery(message: String) throws {
    if #available(iOS 13.0, *) {
      guard NFCReaderSession.readingAvailable else {
        throw Self.vaultError(
          "driver-unavailable",
          "NFC reading unavailable — NFC may be off, or the NFC service may need a device restart")
      }
    }
    YubiKitManager.shared.delegate = connDelegate
    // The alert text comes from JS, localised per tap (a withdrawal batch, an
    // enrollment step). YubiKit reads this static at session start, so it is
    // fixed for the life of one session; progress between batches is shown by
    // the app once the sheet dismisses. Empty = native default wording.
    YubiKitExternalLocalization.nfcScanAlertMessage =
      message.isEmpty ? "Hold your YubiKey to the top of your phone." : message
    if #available(iOS 13.0, *) {
      YubiKitManager.shared.startNFCConnection()
    }
  }

  /// End the NFC session (dismisses the scan sheet). Called on arm / terminal
  /// error / cancel by the JS ceremony.
  func stopDiscovery() throws {
    if #available(iOS 13.0, *) {
      YubiKitManager.shared.stopNFCConnection()
    }
    YubiKitManager.shared.delegate = nil
    activeConnection = nil
  }

  func setKeyListener(listener: @escaping (String, String, String) -> Void) throws {
    self.listener = listener
  }

  func clearKeyListener() throws {
    self.listener = nil
  }

  fileprivate func emit(_ eventType: String, _ serial: String, _ transport: String) {
    listener?(eventType, serial, transport)
  }

  /// Called by the delegate on a connect: hold the connection and emit.
  fileprivate func handleConnect(_ connection: any YKFConnectionProtocol, _ transport: String) {
    activeConnection = connection
    readSerialAndEmit(connection, transport)
  }

  /// Called by the delegate on a disconnect: drop the connection if it is the
  /// one we hold, and emit a removal so the JS layer relocks.
  fileprivate func handleDisconnect(_ connection: AnyObject, _ transport: String) {
    if (activeConnection as AnyObject?) === connection { activeConnection = nil }
    emit("removed", "", transport)
  }

  /// Called by the delegate when a session dies BEFORE any key connected —
  /// the user cancelled the system NFC sheet (CoreNFC code 200), it timed out
  /// (201), or the session failed outright (202/203). No connection ever
  /// existed, so didDisconnect never fires for these; before this handler the
  /// event was silently dropped and the JS ceremony hung in waiting-for-key
  /// forever (the production hang). The CoreNFC code rides in the eventType
  /// (`failed:<code>`) because the listener signature has no error channel;
  /// the JS driver maps 200 → user-cancelled and everything else → no-key.
  fileprivate func handleConnectFailure(_ error: Error, _ transport: String) {
    emit("failed:\((error as NSError).code)", "", transport)
  }

  /// Opens a throwaway session just to read the serial for a connect event.
  private func readSerialAndEmit(_ connection: any YKFConnectionProtocol, _ transport: String) {
    connection.pivSession { [weak self] session, _ in
      guard let self else { return }
      guard let session else { self.emit("connected", "", transport); return }
      session.getSerialNumber { serial, error in
        let serialStr = error == nil ? String(serial) : ""
        self.emit("connected", serialStr, transport)
      }
    }
  }

  // MARK: - Operations

  func getKeyInfo() throws -> Promise<String> {
    let promise = Promise<String>()
    withSession(promise) { session in
      let version = session.version
      session.getPinAttempts { attempts, _ in
        session.getSerialNumber { serial, error in
          if let error { return promise.reject(withError: Self.mapError(error)) }
          let json = "{\"serial\":\"\(serial)\",\"firmwareVersion\":\"\(version.major).\(version.minor).\(version.micro)\",\"pinRetries\":\(attempts)}"
          promise.resolve(withResult: json)
        }
      }
    }
    return promise
  }

  func verifyPin(expectedSerial: String, pin: String) throws -> Promise<String> {
    try Self.requireExpectedSerial(expectedSerial)
    try Self.requirePivCode(pin, label: "PIN")
    let promise = Promise<String>()
    withSession(promise) { session in
      self.withExpectedSerial(session, expectedSerial, promise) {
        session.verifyPin(pin) { retriesLeft, error in
          // A wrong PIN is a normal, resolvable result for this probe (the spec
          // returns {ok, retriesLeft}); only transport faults reject.
          if error != nil, retriesLeft >= 0 {
            promise.resolve(withResult: "{\"ok\":false,\"retriesLeft\":\(retriesLeft)}")
          } else if let error {
            promise.reject(withError: Self.mapError(error))
          } else {
            promise.resolve(withResult: "{\"ok\":true,\"retriesLeft\":null}")
          }
        }
      }
    }
    return promise
  }

  func changePin(expectedSerial: String, oldPin: String, newPin: String) throws -> Promise<String> {
    try Self.requireExpectedSerial(expectedSerial)
    try Self.requirePivCode(oldPin, label: "PIN")
    try Self.requirePivCode(newPin, label: "PIN")
    let promise = Promise<String>()
    let settled = SettleGuard()
    withSession(promise) { session in
      self.withExpectedSerial(session, expectedSerial, promise) {
        // CHANGE REFERENCE DATA needs only the old PIN. Keeping this independent
        // of management-key authentication is essential after Vault replaces and
        // discards the factory management key.
        Self.verifyPinGated(session, pin: oldPin, settled, promise) {
          session.setPin(newPin, oldPin: oldPin) { error in
            if let error { return settled.reject(promise, Self.mapError(error)) }
            settled.resolve(promise, "{\"ok\":true}")
          }
        }
      }
    }
    return promise
  }

  func changePuk(expectedSerial: String, oldPuk: String, newPuk: String) throws -> Promise<String> {
    try Self.requireExpectedSerial(expectedSerial)
    try Self.requirePivCode(oldPuk, label: "PUK")
    try Self.requirePivCode(newPuk, label: "PUK")
    let promise = Promise<String>()
    withSession(promise) { session in
      self.withExpectedSerial(session, expectedSerial, promise) {
        session.setPuk(newPuk, oldPuk: oldPuk) { error in
          if let error {
            let ns = error as NSError
            if ns.code == 6 || ns.code == 0x6983 {
              return promise.reject(withError: Self.vaultError("puk-locked", "no attempts remaining"))
            }
            if ns.code == 5 || (ns.code >= 0x63C0 && ns.code <= 0x63CF) {
              let retries = ns.code >= 0x63C0 ? ns.code & 0x0f : -1
              let detail = retries >= 0 ? "retries=\(retries)" : "PUK not accepted"
              return promise.reject(withError: Self.vaultError("puk-invalid", detail))
            }
            return promise.reject(withError: Self.mapError(error))
          }
          promise.resolve(withResult: "{\"ok\":true,\"retriesLeft\":null}")
        }
      }
    }
    return promise
  }

  func preflightDedicatedPiv(expectedSerial: String, allowOccupiedVaultSlot: Bool) throws -> Promise<String> {
    try Self.requireExpectedSerial(expectedSerial)
    let promise = Promise<String>()
    withSession(promise) { session in
      self.withExpectedSerial(session, expectedSerial, promise) {
        // Verify the immutable factory F9 certificate against the bundled,
        // production-only Yubico trust graph before any global PIV credential
        // mutation. Only then authenticate the factory management key and prove
        // the user slots empty.
        self.requireFactoryAttestation(session, expectedSerial, promise) { _ in
          self.authenticateManagementKey(session, promise) {
            self.inspectEmptyUserSlots(session, index: 0, allowOccupiedVaultSlot: allowOccupiedVaultSlot, promise: promise)
          }
        }
      }
    }
    return promise
  }

  func generateVaultKey(expectedSerial: String) throws -> Promise<String> {
    try Self.requireExpectedSerial(expectedSerial)
    let promise = Promise<String>()
    guard let pivSlot = YKFPIVSlot(rawValue: Self.vaultSlot) else {
      promise.reject(withError: Self.vaultError("template-invalid", "Vault slot 0x82 is unavailable"))
      return promise
    }
    withSession(promise) { session in
      self.withExpectedSerial(session, expectedSerial, promise) {
        self.authenticateManagementKey(session, promise) {
          session.generateKey(
            in: pivSlot,
            type: .ECCP256,
            pinPolicy: .once,
            touchPolicy: .cached
          ) { publicKey, error in
            if let error { return promise.reject(withError: Self.mapError(error)) }
            guard let publicKey, let sec1 = Self.secKeyToSec1(publicKey) else {
              return promise.reject(withError: Self.vaultError("wrong-key", "could not export public key"))
            }
            // ATTEST and the factory F9 read stay on this exact session. Do not
            // return a public key to JS until its slot, key, serial, and policies
            // have all been bound by the verified manufacturer chain.
            session.attestKey(in: pivSlot) { statement, attestError in
              if let attestError {
                return promise.reject(withError: Self.vaultError(
                  "attestation-invalid", "generated slot could not be attested: \(attestError.localizedDescription)"))
              }
              guard let statement else {
                return promise.reject(withError: Self.vaultError(
                  "attestation-invalid", "generated slot returned no attestation"))
              }
              self.requireFactoryAttestation(session, expectedSerial, promise) { f9 in
                do {
                  let authorities = try Self.attestationAuthorities.get()
                  try YubicoPivAttestation.verifyGeneratedVaultKey(
                    statement,
                    f9: f9,
                    generatedSec1: sec1,
                    expectedSerial: expectedSerial,
                    authorities: authorities
                  )
                } catch {
                  return promise.reject(withError: Self.vaultError(
                    "attestation-invalid", "generated Vault key failed manufacturer attestation"))
                }
                promise.resolve(withResult: "{\"publicKey\":\"\(sec1.hexString)\",\"manufacturerAttestation\":\"verified\"}")
              }
            }
          }
        }
      }
    }
    return promise
  }

  func protectManagementKey(expectedSerial: String) throws -> Promise<String> {
    try Self.requireExpectedSerial(expectedSerial)
    let promise = Promise<String>()
    withSession(promise) { session in
      self.withExpectedSerial(session, expectedSerial, promise) {
        self.authenticateManagementKey(session, promise) {
          let version = session.version
          let fw57 = version.major > 5 || (version.major == 5 && version.minor >= 7)
          let type: YKFPIVManagementKeyType = fw57 ? .aes192() : .tripleDES()
          // Both the pre-5.7 TDES key and the 5.7+ AES-192 key are 24 bytes.
          var replacement = Data(count: 24)
          let status = replacement.withUnsafeMutableBytes { bytes in
            SecRandomCopyBytes(kSecRandomDefault, bytes.count, bytes.baseAddress!)
          }
          guard status == errSecSuccess else {
            replacement.resetBytes(in: 0..<replacement.count)
            return promise.reject(withError: Self.vaultError("driver-unavailable", "native CSPRNG failed"))
          }
          session.setManagementKey(replacement, type: type, requiresTouch: false) { error in
            replacement.resetBytes(in: 0..<replacement.count)
            if let error { return promise.reject(withError: Self.mapError(error)) }
            promise.resolve(withResult: "{\"ok\":true}")
          }
        }
      }
    }
    return promise
  }

  /// The five PIV slots YubiKit 4.4 can map to a data-object id, and therefore
  /// the only ones `getCertificateInSlot:` accepts. For ANY other slot it calls
  /// `[NSException raise:@"UnknownObjectId"...]` — a synchronous Objective-C
  /// exception that unwinds straight through this Swift frame and TRAPS the whole
  /// app (Swift cannot catch ObjC exceptions). The vault lives in retired slot
  /// 0x82, which is not in this set.
  private static let certReadableSlots: Set<UInt> = [0x9a, 0x9c, 0x9d, 0x9e, 0xf9]

  func readVaultPublicKey(expectedSerial: String) throws -> Promise<String> {
    try Self.requireExpectedSerial(expectedSerial)
    let promise = Promise<String>()
    let rawSlot = Self.vaultSlot
    guard let pivSlot = YKFPIVSlot(rawValue: rawSlot) else {
      promise.reject(withError: Self.vaultError("no-key", "bad slot"))
      return promise
    }
    // Cert-based occupancy is only readable for the five standard slots (see
    // `certReadableSlots`). For a retired slot like the vault's 0x82,
    // getCertificateInSlot would RAISE and crash the app, and YubiKit 4.4 offers
    // no other slot-occupancy read (getSlotMetadata is later/Android-only). So on
    // iOS the retired-slot certificate is unreadable, so report no readable
    // public key. Enrollment separately sends a random signing probe and only
    // generates after the card returns explicit reference-not-found (0x6a88).
    guard Self.certReadableSlots.contains(rawSlot) else {
      withSession(promise) { session in
        self.withExpectedSerial(session, expectedSerial, promise) {
          promise.resolve(withResult: "{\"publicKey\":null}")
        }
      }
      return promise
    }
    withSession(promise) { session in
      self.withExpectedSerial(session, expectedSerial, promise) {
        // Standard slot: PIV tooling writes an X.509 cert alongside the key, so a
        // present cert means "occupied — don't overwrite". A bare keypair with no
        // cert still reads as empty.
        session.getCertificateIn(pivSlot) { certificate, error in
          guard error == nil, let certificate,
                let pub = SecCertificateCopyKey(certificate),
                let hex = Self.secKeyToSec1Hex(pub) else {
            return promise.resolve(withResult: "{\"publicKey\":null}")
          }
          promise.resolve(withResult: "{\"publicKey\":\"\(hex)\"}")
        }
      }
    }
    return promise
  }

  func signEcdsa(expectedSerial: String, pin: String, digest: String) throws -> Promise<String> {
    try Self.requireExpectedSerial(expectedSerial)
    try Self.requirePivCode(pin, label: "PIN")
    let promise = Promise<String>()
    guard let pivSlot = YKFPIVSlot(rawValue: Self.vaultSlot) else {
      promise.reject(withError: Self.vaultError("template-invalid", "Vault slot 0x82 is unavailable"))
      return promise
    }
    // MUST be exactly 32 bytes, checked BEFORE any card command. YKFPIVPadding
    // returns 32 ZERO bytes rather than an error when it does not recognise the
    // algorithm constant, and pads/truncates anything off-length — either way the
    // card would happily sign the wrong message.
    guard let digestData = Data(hexString: digest), digestData.count == 32 else {
      promise.reject(withError: Self.vaultError("template-invalid", "digest must be exactly 32 bytes"))
      return promise
    }

    // Guards YubiKit 4.4.0's double-callback in signWithKeyInSlot: (see SettleGuard).
    let settled = SettleGuard()
    withSession(promise) { session in
      self.withExpectedSerial(session, expectedSerial, promise) {
        // pin-policy ONCE gate: neither YubiKit nor the card verifies for us.
        // A wrong/locked PIN is classified by verifyPinGated (it used to fall
        // through mapError and come out as wrong-key with no retry count).
        Self.verifyPinGated(session, pin: pin, settled, promise) {
          // .ecdsaSignatureDigestX962SHA256 is the DIGEST variant — YKFPIVPadding
          // passes it through unhashed (`hash = [data mutableCopy]`). Never use the
          // ...MessageX962... variants: those hash locally with CommonCrypto and
          // would sign the wrong value. Signature is the card's raw DER bytes,
          // returned unmodified (P-256 signatures here are NOT low-S normalised).
          session.signWithKey(
            in: pivSlot,
            type: .ECCP256,
            algorithm: .ecdsaSignatureDigestX962SHA256,
            message: digestData
          ) { signature, error in
            if let error { return settled.reject(promise, Self.mapError(error)) }
            guard let signature, !signature.isEmpty else {
              return settled.reject(promise, Self.vaultError("touch-timeout", "no signature returned"))
            }
            settled.resolve(promise, "{\"signature\":\"\(signature.hexString)\"}")
          }
        }
      }
    }
    return promise
  }

  // MARK: - Helpers

  private static func requirePivCode(_ value: String, label: String) throws {
    guard value.range(of: "^[0-9]{6,8}$", options: .regularExpression) != nil else {
      throw vaultError("template-invalid", "PIV \(label) must be 6 to 8 ASCII digits")
    }
  }

  private static func requireExpectedSerial(_ value: String) throws {
    guard value.range(of: "^[A-Za-z0-9._:-]{1,64}$", options: .regularExpression) != nil else {
      throw vaultError("template-invalid", "invalid expected YubiKey serial")
    }
  }

  /// Opens a `YKFPIVSession` on the held connection and hands it to `work`;
  /// rejects with no-key when nothing is on a reader, or maps a session-open
  /// error. `work` owns resolving/rejecting `promise` from there.
  private func withSession(_ promise: Promise<String>, _ work: @escaping (YKFPIVSession) -> Void) {
    guard let connection = activeConnection else {
      promise.reject(withError: Self.vaultError("no-key", "no YubiKey present"))
      return
    }
    connection.pivSession { session, error in
      if let error { return promise.reject(withError: Self.mapError(error)) }
      guard let session else {
        return promise.reject(withError: Self.vaultError("no-key", "could not open PIV session"))
      }
      work(session)
    }
  }

  /// Bind each command to the selected card on the same PIV session that will
  /// execute it. This remains required on iOS because the active connection can
  /// change between separate bridge calls, even though NFC normally presents
  /// only one token at a time.
  private func withExpectedSerial(
    _ session: YKFPIVSession,
    _ expectedSerial: String,
    _ promise: Promise<String>,
    _ next: @escaping () -> Void
  ) {
    session.getSerialNumber { serial, error in
      if let error { return promise.reject(withError: Self.mapError(error)) }
      let actual = String(serial)
      guard actual == expectedSerial else {
        return promise.reject(withError: Self.vaultError(
          "serial-mismatch", "presented key \(actual), expected \(expectedSerial)"))
      }
      next()
    }
  }

  /// Authenticate with the firmware-default management key so generation or
  /// management-key rotation can proceed, then run `next`. Pre-5.7 keys default to
  /// TDES, fw >= 5.7 to AES-192; both ship the same 24-byte default value. A
  /// failure means a custom management key we cannot supply → mgmt-key-custom.
  private func authenticateManagementKey(
    _ session: YKFPIVSession,
    _ promise: Promise<String>,
    _ next: @escaping () -> Void
  ) {
    let version = session.version
    let fw57 = version.major > 5 || (version.major == 5 && version.minor >= 7)
    // 4.4: these are class factory methods on YKFPIVManagementKeyType, so call
    // them (they are not enum cases).
    let type: YKFPIVManagementKeyType = fw57 ? .aes192() : .tripleDES()
    session.authenticate(withManagementKey: Self.defaultManagementKey, type: type) { error in
      if error != nil {
        return promise.reject(withError: Self.vaultError("mgmt-key-custom", "default management key rejected"))
      }
      next()
    }
  }

  private func inspectEmptyUserSlots(
    _ session: YKFPIVSession,
    index: Int,
    allowOccupiedVaultSlot: Bool,
    promise: Promise<String>
  ) {
    guard index < Self.userPivSlots.count else {
      promise.resolve(withResult: "{\"ok\":true,\"inspection\":\"attestation\",\"manufacturerAttestation\":\"verified\"}")
      return
    }
    let rawSlot = Self.userPivSlots[index]
    if allowOccupiedVaultSlot && rawSlot == Self.vaultSlot {
      inspectEmptyUserSlots(session, index: index + 1, allowOccupiedVaultSlot: allowOccupiedVaultSlot, promise: promise)
      return
    }
    guard let slot = YKFPIVSlot(rawValue: rawSlot) else {
      promise.reject(withError: Self.vaultError("slot-occupied", "could not address PIV slot"))
      return
    }
    session.attestKey(in: slot) { certificate, error in
      if error == nil, certificate != nil {
        promise.reject(withError: Self.vaultError(
          "slot-occupied", "PIV slot 0x\(String(rawSlot, radix: 16)) is occupied"))
        return
      }
      if let error {
        let ns = error as NSError
        if ns.code == 0x6A88 {
          self.inspectEmptyUserSlots(session, index: index + 1, allowOccupiedVaultSlot: allowOccupiedVaultSlot, promise: promise)
          return
        }
      }
      // Imported keys, an overwritten/missing attestation slot, and transport
      // ambiguity cannot prove emptiness, so global PIN/PUK changes are refused.
      promise.reject(withError: Self.vaultError(
        "slot-occupied", "could not prove PIV slot 0x\(String(rawSlot, radix: 16)) empty"))
    }
  }

  private func requireFactoryAttestation(
    _ session: YKFPIVSession,
    _ expectedSerial: String,
    _ promise: Promise<String>,
    _ next: @escaping (SecCertificate) -> Void
  ) {
    guard let slot = YKFPIVSlot(rawValue: 0xf9) else {
      promise.reject(withError: Self.vaultError("attestation-invalid", "factory attestation slot unavailable"))
      return
    }
    session.getCertificateIn(slot) { certificate, error in
      guard error == nil, let certificate else {
        promise.reject(withError: Self.vaultError("attestation-invalid", "factory attestation certificate is missing"))
        return
      }
      do {
        let authorities = try Self.attestationAuthorities.get()
        try YubicoPivAttestation.verifyFactoryCertificate(
          certificate,
          expectedSerial: expectedSerial,
          authorities: authorities
        )
      } catch {
        promise.reject(withError: Self.vaultError("attestation-invalid", "factory attestation certificate is not trusted"))
        return
      }
      next(certificate)
    }
  }

  /// The PIN gate shared by signing operations: verify `pin` on `session`, rejecting a failure through
  /// `settled`, and run `next` only on success.
  ///
  /// The retry count MUST be read from the completion's first argument, not
  /// inferred from the error. YubiKit does not surface the card's 0x63Cx
  /// status word here — it swallows it and hands back its own NSError
  /// (YKFPIVErrorDomain, InvalidPin = 5 / PinLocked = 6), which `mapError`'s
  /// status-word cases cannot recognise and would fold into `wrong-key`,
  /// losing the count. What the block DOES carry (YKFPIVSession.m:594-619,
  /// and the header's "retries left or -1 if an error occured") is:
  ///   > 0  wrong PIN, that many attempts remain
  ///   == 0 PIN blocked
  ///   == -1 neither — a transport/APDU fault, which mapError does classify.
  /// The detail strings are byte-identical to the Android side's
  /// (`pin-invalid:retries=N` / `pin-locked:no attempts remaining`) so
  /// vaultErrorFromNative's /retries=(\d+)/ populates VaultError.retriesLeft
  /// identically on both platforms.
  private static func verifyPinGated(
    _ session: YKFPIVSession,
    pin: String,
    _ settled: SettleGuard,
    _ promise: Promise<String>,
    _ next: @escaping () -> Void
  ) {
    session.verifyPin(pin) { retries, error in
      if let error {
        if retries > 0 {
          return settled.reject(promise, vaultError("pin-invalid", "retries=\(retries)"))
        }
        if retries == 0 {
          return settled.reject(promise, vaultError("pin-locked", "no attempts remaining"))
        }
        return settled.reject(promise, mapError(error))
      }
      next()
    }
  }

  private static func vaultError(_ code: String, _ detail: String) -> NSError {
    NSError(domain: "YubiKeyPiv", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "VAULT_ERR:\(code):\(detail)"])
  }

  /// Best-effort translation of a YubiKit error to a VAULT_ERR code.
  ///
  /// NOTE: YubiKit surfaces smart-card faults as NSErrors whose `code` is often
  /// the raw APDU status word; the exact domains/codes are version-sensitive
  /// and should be re-checked on-device. Anything unrecognised falls through to
  /// wrong-key so a failure is never silently swallowed.
  private static func mapError(_ error: Error) -> NSError {
    let ns = error as NSError
    // Already one of ours (e.g. nested through withSession) — pass through.
    if ns.domain == "YubiKeyPiv" { return ns }
    switch ns.code {
    case 0x6983: return vaultError("pin-locked", "authentication method blocked")
    case 0x63C0...0x63CF: // 0x63Cx = PIN verify failed, x = retries left
      return vaultError("pin-invalid", "retries=\(ns.code & 0x0F)")
    // Only REFERENCE DATA NOT FOUND proves an empty slot. INCORRECT DATA
    // (0x6a80) can also mean an occupied slot with an algorithm mismatch.
    case 0x6A88: return vaultError("no-key", "reference data not found")
    case 0x6A80: return vaultError("wrong-key", "incorrect data or parameters")
    case 0x6982, 0x6985: return vaultError("touch-timeout", "conditions of use not satisfied")
    default:
      let desc = ns.localizedDescription.lowercased()
      if desc.contains("touch") || desc.contains("timeout") {
        return vaultError("touch-timeout", ns.localizedDescription)
      }
      if desc.contains("no connection") || desc.contains("disconnect") || desc.contains("removed") {
        return vaultError("key-removed-mid-op", ns.localizedDescription)
      }
      return vaultError("wrong-key", ns.localizedDescription)
    }
  }

  /// EC public `SecKey` -> SEC1 uncompressed hex (0x04 || X || Y). Security's
  /// external representation for an EC public key IS ANSI X9.63 uncompressed,
  /// so this is a straight export + hex encode.
  private static func secKeyToSec1(_ key: SecKey) -> Data? {
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(key, &error) as Data?,
          data.count == 65, data.first == 0x04 else { return nil }
    return data
  }

  private static func secKeyToSec1Hex(_ key: SecKey) -> String? {
    secKeyToSec1(key)?.hexString
  }

  private static let vaultSlot: UInt = 0x82
  /** Every user-key slot; 0xf9 is the factory attestation key and is expected
   * to be occupied on a dedicated/factory-reset PIV application. */
  private static let userPivSlots: [UInt] =
    Array(UInt(0x82)...UInt(0x95)) + [UInt(0x9a), UInt(0x9c), UInt(0x9d), UInt(0x9e)]

  /// Firmware-default PIV management key (0x0102…08 ×3, 24 bytes).
  private static let defaultManagementKey = Data([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08
  ])
}

// MARK: - Settle guard

/// Defense in depth against any native callback firing twice. YubiKit 4.4.1
/// fixes the known signWithKeyInSlot double-completion defect, but a duplicate
/// completion must never settle a Nitro Promise twice.
private final class SettleGuard {
  private var settled = false
  private let lock = NSLock()

  private func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if settled { return false }
    settled = true
    return true
  }

  func resolve(_ promise: Promise<String>, _ value: String) {
    if claim() { promise.resolve(withResult: value) }
  }

  func reject(_ promise: Promise<String>, _ error: Error) {
    if claim() { promise.reject(withError: error) }
  }
}

// MARK: - Discovery delegate

/// YKFManagerDelegate is declared `<NSObject>`, so its conformer must be an
/// NSObject — which the Nitro HybridObject is not. This lightweight NSObject
/// holds a weak back-reference and forwards every connect/disconnect to the
/// owner. The SmartCard callbacks carry no availability annotation in YubiKit
/// 4.4's protocol, so none is needed here (startSmartCardConnection, which is
/// iOS 16+, is already guarded at the call site).
private final class ConnectionDelegate: NSObject, YKFManagerDelegate {
  weak var owner: HybridYubiKeyPiv?

  func didConnectNFC(_ connection: YKFNFCConnection) {
    owner?.handleConnect(connection, "nfc")
  }
  func didDisconnectNFC(_ connection: YKFNFCConnection, error: Error?) {
    owner?.handleDisconnect(connection, "nfc")
  }
  func didConnectAccessory(_ connection: YKFAccessoryConnection) {
    owner?.handleConnect(connection, "usb")
  }
  func didDisconnectAccessory(_ connection: YKFAccessoryConnection, error: Error?) {
    owner?.handleDisconnect(connection, "usb")
  }
  func didConnectSmartCard(_ connection: YKFSmartCardConnection) {
    owner?.handleConnect(connection, "usb")
  }
  func didDisconnectSmartCard(_ connection: YKFSmartCardConnection, error: Error?) {
    owner?.handleDisconnect(connection, "usb")
  }
  // Optional in YKFManagerDelegate — but load-bearing: without these, a
  // cancelled or timed-out scan sheet is silently swallowed (YubiKitManager
  // guards the forward with respondsToSelector) and the ceremony hangs.
  func didFailConnectingNFC(_ error: Error) {
    owner?.handleConnectFailure(error, "nfc")
  }
  func didFailConnectingSmartCard(_ error: Error) {
    owner?.handleConnectFailure(error, "usb")
  }
}

// MARK: - hex

private extension Data {
  var hexString: String { map { String(format: "%02x", $0) }.joined() }

  init?(hexString: String) {
    var hex = hexString
    if hex.hasPrefix("0x") || hex.hasPrefix("0X") { hex = String(hex.dropFirst(2)) }
    guard hex.count % 2 == 0 else { return nil }
    var out = Data(capacity: hex.count / 2)
    var idx = hex.startIndex
    while idx < hex.endIndex {
      let next = hex.index(idx, offsetBy: 2)
      guard let byte = UInt8(hex[idx..<next], radix: 16) else { return nil }
      out.append(byte)
      idx = next
    }
    self = out
  }
}
