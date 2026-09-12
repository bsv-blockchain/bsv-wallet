package com.margelo.nitro.yubikeypiv

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import com.yubico.yubikit.android.YubiKitManager
import com.yubico.yubikit.android.transport.nfc.NfcConfiguration
import com.yubico.yubikit.android.transport.nfc.NfcNotAvailable
import com.yubico.yubikit.android.transport.nfc.NfcYubiKeyDevice
import com.yubico.yubikit.android.transport.usb.UsbConfiguration
import com.yubico.yubikit.android.transport.usb.UsbYubiKeyDevice
import com.yubico.yubikit.core.YubiKeyDevice
import com.yubico.yubikit.core.keys.PublicKeyValues
import com.yubico.yubikit.core.smartcard.ApduException
import com.yubico.yubikit.core.smartcard.SmartCardConnection
import com.yubico.yubikit.core.application.InvalidPinException
import com.yubico.yubikit.piv.KeyType
import com.yubico.yubikit.piv.ManagementKeyType
import com.yubico.yubikit.piv.PinPolicy
import com.yubico.yubikit.piv.PivSession
import com.yubico.yubikit.piv.Slot
import com.yubico.yubikit.piv.TouchPolicy
import java.io.IOException
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.SecureRandom
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.cert.X509Certificate
import java.util.concurrent.CountDownLatch

/**
 * YubiKeyPiv over YubiKit-Android's PIV application (CCID).
 *
 * Mirrors the iOS/YubiKit backend's contract exactly (the JS wrapper is
 * shared): discovery streams key-connected / key-removed events to the JS
 * listener, and each Promise-returning method opens a fresh
 * SmartCardConnection → PivSession against the currently-held device, does its
 * one operation, and lets the connection close.
 *
 * Every rejection carries a `VAULT_ERR:<code>:<detail>` message (see
 * `mapError`) so the JS vault layer can branch on a stable machine code rather
 * than parse YubiKit's own English.
 *
 * Discovery bookkeeping is serialized on the main thread. Each JS ceremony
 * starts and stops its own discovery window; stopDiscovery is synchronous with
 * respect to that bookkeeping so the process-wide hardware lease cannot be
 * handed to a successor before the old native discovery has been torn down.
 * Per-operation requestConnection callbacks run on YubiKit's executor and use
 * a volatile snapshot of the selected device.
 */
class HybridYubiKeyPiv : HybridYubiKeyPivSpec() {
  private val main = Handler(Looper.getMainLooper())
  private val pivCode = Regex("^[0-9]{6,8}$")
  private val serialCode = Regex("^[A-Za-z0-9._:-]{1,64}$")

  private val manager: YubiKitManager? by lazy {
    val ctx = NitroModules.applicationContext ?: return@lazy null
    YubiKitManager(ctx.applicationContext)
  }

  private val attestationAuthorities by lazy {
    val ctx = NitroModules.applicationContext
      ?: throw VaultException("attestation-invalid", "application context unavailable for pinned CA bundle")
    try {
      ctx.assets.open(ATTESTATION_ASSET).use(YubicoPivAttestation::loadAuthorities)
    } catch (e: VaultException) {
      throw e
    } catch (_: Throwable) {
      throw VaultException("attestation-invalid", "pinned Yubico CA bundle failed validation")
    }
  }

  /** JS listener: (eventType, serial, transport). Confined to `main`. */
  private var listener: ((String, String, String) -> Unit)? = null
  /** Main-thread writes; operation threads take a volatile snapshot. */
  @Volatile
  private var currentDevice: YubiKeyDevice? = null
  private var currentTransport: String? = null
  private var discovering = false
  private var discoveryGeneration = 0L
  private var nfcActivity: Activity? = null

  // ── discovery ──

  override fun isSupported(): Boolean {
    val ctx = NitroModules.applicationContext ?: return false
    val pm: PackageManager = ctx.packageManager
    val usb = pm.hasSystemFeature(PackageManager.FEATURE_USB_HOST)
    val nfc = pm.hasSystemFeature(PackageManager.FEATURE_NFC)
    return usb || nfc
  }

  /** `message` is the iOS NFC alert text; Android's system NFC has no
   *  per-session prompt and USB has none, so it is accepted and ignored. */
  override fun startDiscovery(message: String) {
    onMainSync {
      if (discovering) return@onMainSync
      val m = manager ?: return@onMainSync
      discovering = true
      val generation = ++discoveryGeneration

      // USB: the SDK owns the runtime permission dialog. Each plug-in delivers
      // a UsbYubiKeyDevice that stays live until unplugged. Enabling discovery
      // also reports keys that were already inserted.
      m.startUsbDiscovery(UsbConfiguration()) { device ->
        main.post {
          if (!isActive(generation)) {
            device.close()
            return@post
          }
          currentDevice = device
          currentTransport = "usb"
          device.setOnClosed {
            main.post {
              if (isActive(generation) && currentDevice === device) {
                currentDevice = null
                currentTransport = null
                listener?.invoke("removed", "", "usb")
              }
            }
          }
          readSerialAndEmit(device, "usb", generation)
        }
      }

      // NFC: best-effort. Needs a foreground Activity and an NFC radio; either
      // missing is fine — USB still works and isSupported() stays honest.
      try {
        val activity = (NitroModules.applicationContext as? ReactApplicationContext)?.currentActivity
        if (activity != null) {
          nfcActivity = activity
          m.startNfcDiscovery(NfcConfiguration(), activity) { device ->
            main.post {
              if (!isActive(generation)) {
                // Its discovery executor was already shut down by teardown.
                // Do not call remove(Runnable): that is an imperative close,
                // never a detach-listener registration.
                return@post
              }
              currentDevice = device
              currentTransport = "nfc"
              readSerialAndEmit(device, "nfc", generation)
            }
          }
        }
      } catch (_: NfcNotAvailable) {
        // no NFC on this device — ignore
      } catch (_: Throwable) {
        // any other NFC-start failure is non-fatal for USB-only use
      }
    }
  }

  override fun stopDiscovery() {
    onMainSync {
      if (!discovering) return@onMainSync
      discovering = false
      ++discoveryGeneration
      val m = manager
      val held = currentDevice
      currentDevice = null
      currentTransport = null
      // YubiKit 3.1 has no NFC detach callback. remove(Runnable) immediately
      // makes this transient handle unusable, so call it only as explicit
      // ceremony teardown. A physical lift during an operation is reported as
      // IOException by requestConnection and is handled in withPiv below.
      (held as? NfcYubiKeyDevice)?.remove {}
      try { m?.stopUsbDiscovery() } catch (_: Throwable) {}
      try {
        val activity = nfcActivity
        if (activity != null) m?.stopNfcDiscovery(activity)
      } catch (_: Throwable) {}
      nfcActivity = null
    }
  }

  override fun setKeyListener(listener: (String, String, String) -> Unit) {
    onMainSync { this.listener = listener }
  }

  override fun clearKeyListener() {
    onMainSync { this.listener = null }
  }

  /** Run discovery mutations synchronously on Android's main thread. Nitro can
   * invoke these methods off-main; waiting here makes `stop()` a real teardown
   * barrier before JS releases the process-wide hardware lease. */
  private fun onMainSync(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
      return
    }
    val done = CountDownLatch(1)
    var failure: Throwable? = null
    main.post {
      try {
        block()
      } catch (t: Throwable) {
        failure = t
      } finally {
        done.countDown()
      }
    }
    try {
      done.await()
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
      throw e
    }
    failure?.let { throw it }
  }

  /** Called only on the main thread. */
  private fun isActive(generation: Long): Boolean = discovering && discoveryGeneration == generation

  /** Open a throwaway session just to read the serial for a connected event. */
  private fun readSerialAndEmit(device: YubiKeyDevice, transport: String, generation: Long) {
    device.requestConnection(SmartCardConnection::class.java) { result ->
      val serial = try {
        val piv = PivSession(result.value)
        piv.serialNumber.toString()
      } catch (_: Throwable) {
        null
      }
      main.post {
        if (!isActive(generation) || currentDevice !== device) return@post
        if (serial != null && serialCode.matches(serial)) {
          listener?.invoke("connected", serial, transport)
        } else {
          currentDevice = null
          currentTransport = null
          listener?.invoke("failed", "", transport)
        }
      }
    }
  }

  // ── operations ──

  override fun getKeyInfo(): Promise<String> {
    val promise = Promise<String>()
    withPiv(promise) { piv ->
      val serial = piv.serialNumber
      val v = piv.version
      val retries = try { piv.pinAttempts } catch (_: Throwable) { -1 }
      "{\"serial\":\"$serial\",\"firmwareVersion\":\"${v.major}.${v.minor}.${v.micro}\",\"pinRetries\":$retries}"
    }
    return promise
  }

  override fun verifyPin(expectedSerial: String, pin: String): Promise<String> {
    val promise = Promise<String>()
    if (!serialCode.matches(expectedSerial)) {
      promise.reject(vaultError("template-invalid", "invalid expected YubiKey serial"))
      return promise
    }
    if (!pivCode.matches(pin)) {
      promise.reject(vaultError("template-invalid", "PIV PIN must be 6 to 8 ASCII digits"))
      return promise
    }
    withPiv(promise) { piv ->
      requireExpectedSerial(piv, expectedSerial)
      try {
        piv.verifyPin(pin.toCharArray())
        "{\"ok\":true,\"retriesLeft\":null}"
      } catch (e: InvalidPinException) {
        // A wrong PIN is a normal, resolvable result for this probe (the spec
        // returns {ok, retriesLeft}); only transport faults reject.
        "{\"ok\":false,\"retriesLeft\":${e.attemptsRemaining}}"
      }
    }
    return promise
  }

  override fun changePin(expectedSerial: String, oldPin: String, newPin: String): Promise<String> {
    val promise = Promise<String>()
    if (!serialCode.matches(expectedSerial)) {
      promise.reject(vaultError("template-invalid", "invalid expected YubiKey serial"))
      return promise
    }
    if (!pivCode.matches(oldPin) || !pivCode.matches(newPin)) {
      promise.reject(vaultError("template-invalid", "PIV PIN must be 6 to 8 ASCII digits"))
      return promise
    }
    withPiv(promise) { piv ->
      requireExpectedSerial(piv, expectedSerial)
      // PIV CHANGE REFERENCE DATA needs only the old PIN — NOT management-key
      // auth. Gating it on the management key would wrongly reject a key that
      // has a custom management key but a still-default PIN.
      //
      // A wrong/locked old PIN throws InvalidPinException, which withPiv's
      // mapError classifies (pin-invalid:retries=N, or pin-locked when no
      // attempts remain) — same reporting as every other PIN-consuming op on
      // both platforms. No local catch: one used to force pin-invalid here
      // even at 0 retries, diverging from mapError and from iOS.
      piv.changePin(oldPin.toCharArray(), newPin.toCharArray())
      "{\"ok\":true}"
    }
    return promise
  }

  override fun changePuk(expectedSerial: String, oldPuk: String, newPuk: String): Promise<String> {
    val promise = Promise<String>()
    if (!serialCode.matches(expectedSerial)) {
      promise.reject(vaultError("template-invalid", "invalid expected YubiKey serial"))
      return promise
    }
    if (!pivCode.matches(oldPuk) || !pivCode.matches(newPuk)) {
      promise.reject(vaultError("template-invalid", "PIV PUK must be 6 to 8 ASCII digits"))
      return promise
    }
    withPiv(promise) { piv ->
      requireExpectedSerial(piv, expectedSerial)
      try {
        piv.changePuk(oldPuk.toCharArray(), newPuk.toCharArray())
      } catch (e: InvalidPinException) {
        val n = e.attemptsRemaining
        if (n <= 0) throw VaultException("puk-locked", "no attempts remaining")
        throw VaultException("puk-invalid", "retries=$n")
      }
      "{\"ok\":true,\"retriesLeft\":null}"
    }
    return promise
  }

  override fun preflightDedicatedPiv(expectedSerial: String, allowOccupiedVaultSlot: Boolean): Promise<String> {
    val promise = Promise<String>()
    if (!serialCode.matches(expectedSerial)) {
      promise.reject(vaultError("template-invalid", "invalid expected YubiKey serial"))
      return promise
    }
    withPiv(promise) { piv ->
      requireExpectedSerial(piv, expectedSerial)
      // Prove the immutable factory F9 certificate is a production Yubico
      // credential before changing the PIN, PUK, or management key. This is
      // offline and never consults Android's system trust store or an AIA URL.
      requireFactoryAttestation(piv, expectedSerial)
      // Authentication is read-only and happens before any PIN/PUK mutation.
      // A custom or transport-ambiguous management-key result fails closed.
      authenticateManagementKey(piv)
      val userSlots = Slot.values().filter {
        it != Slot.ATTESTATION && !(allowOccupiedVaultSlot && it.value == VAULT_SLOT)
      }
      val inspection = when {
        piv.supports(PivSession.FEATURE_METADATA) -> {
          for (slot in userSlots) {
            try {
              piv.getSlotMetadata(slot)
              throw VaultException("slot-occupied", "PIV slot 0x${Integer.toHexString(slot.value)} is occupied")
            } catch (e: ApduException) {
              if ((e.sw.toInt() and 0xffff) != 0x6a88) {
                throw VaultException(
                  "slot-occupied",
                  "could not prove PIV slot 0x${Integer.toHexString(slot.value)} empty"
                )
              }
            }
          }
          "metadata"
        }
        piv.supports(PivSession.FEATURE_ATTESTATION) -> {
          for (slot in userSlots) {
            try {
              piv.attestKey(slot)
              throw VaultException("slot-occupied", "PIV slot 0x${Integer.toHexString(slot.value)} is occupied")
            } catch (e: ApduException) {
              if ((e.sw.toInt() and 0xffff) != 0x6a88) {
                throw VaultException(
                  "slot-occupied",
                  "could not prove PIV slot 0x${Integer.toHexString(slot.value)} empty"
                )
              }
            }
          }
          "attestation"
        }
        else -> throw VaultException("slot-occupied", "this YubiKey cannot prove its user PIV slots are empty")
      }
      "{\"ok\":true,\"inspection\":\"$inspection\",\"manufacturerAttestation\":\"verified\"}"
    }
    return promise
  }

  override fun generateVaultKey(expectedSerial: String): Promise<String> {
    val promise = Promise<String>()
    if (!serialCode.matches(expectedSerial)) {
      promise.reject(vaultError("template-invalid", "invalid expected YubiKey serial"))
      return promise
    }
    withPiv(promise) { piv ->
      requireExpectedSerial(piv, expectedSerial)
      authenticateManagementKey(piv)
      // YubiKit 3.1 generateKey(...) returns PublicKeyValues.
      val pub = piv.generateKey(
        Slot.fromValue(VAULT_SLOT),
        KeyType.ECCP256,
        PinPolicy.ONCE,
        TouchPolicy.CACHED
      )
      val encoded = (pub as? PublicKeyValues.Ec)?.encodedPoint
        ?: throw VaultException("wrong-key", "generated key was not P-256")
      try {
        requireOnCurveP256(encoded)
      } catch (_: Throwable) {
        throw VaultException("wrong-key", "generated key was not a canonical P-256 point")
      }
      // ATTEST and the F9 read occur on this same PivSession as generation.
      // The statement must bind the exact returned point to slot 0x82 with the
      // requested policies and this session's serial, and F9 must still chain
      // through the pinned production allowlist.
      val statement = try {
        piv.attestKey(Slot.fromValue(VAULT_SLOT))
      } catch (e: ApduException) {
        if ((e.sw.toInt() and 0xffff) == 0x6a88) {
          throw VaultException("attestation-invalid", "generated slot could not be attested")
        }
        throw e
      }
      val f9 = readFactoryCertificate(piv)
      try {
        YubicoPivAttestation.verifyGeneratedVaultKey(
          statement,
          f9,
          encoded,
          expectedSerial,
          attestationAuthorities
        )
      } catch (_: Throwable) {
        throw VaultException("attestation-invalid", "generated Vault key failed manufacturer attestation")
      }
      "{\"publicKey\":\"${encoded.toHex()}\",\"manufacturerAttestation\":\"verified\"}"
    }
    return promise
  }

  override fun protectManagementKey(expectedSerial: String): Promise<String> {
    val promise = Promise<String>()
    if (!serialCode.matches(expectedSerial)) {
      promise.reject(vaultError("template-invalid", "invalid expected YubiKey serial"))
      return promise
    }
    withPiv(promise) { piv ->
      requireExpectedSerial(piv, expectedSerial)
      authenticateManagementKey(piv)
      val v = piv.version
      val major = v.major.toInt()
      val minor = v.minor.toInt()
      val type = if (major > 5 || (major == 5 && minor >= 7)) {
        ManagementKeyType.AES192
      } else {
        ManagementKeyType.TDES
      }
      val replacement = ByteArray(type.keyLength)
      try {
        SecureRandom().nextBytes(replacement)
        // The credential is intentionally unrecoverable: Vault needs the PIV
        // signing key, never future administrative access to the token.
        piv.setManagementKey(type, replacement, false)
      } finally {
        replacement.fill(0)
      }
      "{\"ok\":true}"
    }
    return promise
  }

  override fun readVaultPublicKey(expectedSerial: String): Promise<String> {
    val promise = Promise<String>()
    if (!serialCode.matches(expectedSerial)) {
      promise.reject(vaultError("template-invalid", "invalid expected YubiKey serial"))
      return promise
    }
    withPiv(promise) { piv ->
      requireExpectedSerial(piv, expectedSerial)
      try {
        val meta = piv.getSlotMetadata(Slot.fromValue(VAULT_SLOT))
        val pub = meta.publicKeyValues as PublicKeyValues.Ec
        "{\"publicKey\":\"${pub.encodedPoint.toHex()}\"}"
      } catch (e: ApduException) {
        // Only REFERENCE DATA NOT FOUND proves the slot is empty. Incorrect
        // data/algorithm and all other APDU statuses fail closed.
        if ((e.sw.toInt() and 0xffff) == 0x6a88) "{\"publicKey\":null}" else throw e
      }
    }
    return promise
  }

  override fun signEcdsa(expectedSerial: String, pin: String, digest: String): Promise<String> {
    val promise = Promise<String>()
    if (!serialCode.matches(expectedSerial)) {
      promise.reject(vaultError("template-invalid", "invalid expected YubiKey serial"))
      return promise
    }
    if (!pivCode.matches(pin)) {
      promise.reject(vaultError("template-invalid", "PIV PIN must be 6 to 8 ASCII digits"))
      return promise
    }
    // MUST be exactly 32 bytes: rawSignOrDecrypt silently TRUNCATES an over-long
    // EC payload (Arrays.copyOf to the key's 32-byte length) and left zero-pads a
    // short one, so an off-length digest signs the wrong message rather than
    // failing. Checked BEFORE any card command so a malformed digest never burns
    // a PIN retry.
    val digestBytes = try {
      hexToBytes(digest)
    } catch (t: Throwable) {
      // hexToBytes' message distinguishes odd-length from non-hex-content so
      // this detail doesn't misreport which check actually failed.
      promise.reject(vaultError("template-invalid", "digest ${t.message ?: "must be hex"}"))
      return promise
    }
    if (digestBytes.size != 32) {
      promise.reject(vaultError("template-invalid", "digest must be exactly 32 bytes, got ${digestBytes.size}"))
      return promise
    }

    withPiv(promise) { piv ->
      requireExpectedSerial(piv, expectedSerial)
      // withPiv opens a FRESH PivSession per call, so the PIN must be verified
      // inside every operation — this is not redundant with an earlier verify.
      piv.verifyPin(pin.toCharArray())
      // TOUCH-gated by the slot's touch policy; a required-but-unmet touch
      // surfaces as SW 0x6982/0x6985, which mapError folds into touch-timeout.
      // rawSignOrDecrypt sends the digest verbatim (no local hashing/re-encoding)
      // and the card returns raw DER (SEQUENCE { r, s }), NOT low-S normalised —
      // returned here unmodified.
      val der = piv.rawSignOrDecrypt(Slot.fromValue(VAULT_SLOT), KeyType.ECCP256, digestBytes)
      if (der.isEmpty()) {
        // Mirrors iOS: an empty result without a thrown error should not
        // resolve as a "signature" — surface it as touch-timeout rather than
        // silently returning {"signature":""}.
        throw VaultException("touch-timeout", "no signature returned")
      }
      "{\"signature\":\"${der.toHex()}\"}"
    }
    return promise
  }

  // ── helpers ──

  /**
   * Open a SmartCardConnection → PivSession against the held device, run
   * `block`, resolve; translate any failure to a VAULT_ERR rejection. No held
   * device means no key is on a reader → no-key.
   */
  private fun withPiv(promise: Promise<String>, block: (PivSession) -> String) {
    val device = currentDevice
    if (device == null) {
      promise.reject(vaultError("no-key", "no YubiKey present"))
      return
    }
    device.requestConnection(SmartCardConnection::class.java) { result ->
      try {
        val piv = PivSession(result.value) // result.value throws IOException if the connect failed
        promise.resolve(block(piv))
      } catch (t: Throwable) {
        if (t is IOException) forgetRemovedDevice(device)
        promise.reject(mapError(t))
      }
    }
  }

  /** YubiKit 3.1 exposes no NFC detach listener. A failed connection is the
   * authoritative signal that a transient tag left the field; forget only the
   * exact handle this operation captured so a newer tap cannot be cleared by
   * an older callback. */
  private fun forgetRemovedDevice(device: YubiKeyDevice) {
    main.post {
      if (currentDevice === device) {
        val transport = currentTransport ?: device.transport.name.lowercase()
        currentDevice = null
        currentTransport = null
        listener?.invoke("removed", "", transport)
      }
    }
  }

  /**
   * Authenticate with the firmware-default management key so generateKey can
   * run. In yubikit-android 3.1.0 `authenticate(byte[])` reads the key's
   * algorithm from card metadata itself, so we pass only the 24-byte default
   * value (the same default for both the pre-5.7 TDES and fw >= 5.7 AES-192
   * cards). A rejection means the key has a custom management key we cannot
   * supply → mgmt-key-custom.
   */
  private fun authenticateManagementKey(piv: PivSession) {
    try {
      piv.authenticate(DEFAULT_MANAGEMENT_KEY)
    } catch (e: Throwable) {
      throw VaultException("mgmt-key-custom", "default management key rejected")
    }
  }

  private fun readFactoryCertificate(piv: PivSession): X509Certificate {
    return try {
      piv.getCertificate(Slot.ATTESTATION)
    } catch (e: ApduException) {
      if ((e.sw.toInt() and 0xffff) == 0x6a88) {
        throw VaultException("attestation-invalid", "factory attestation certificate is missing")
      }
      throw e
    }
  }

  private fun requireFactoryAttestation(piv: PivSession, expectedSerial: String): X509Certificate {
    val certificate = readFactoryCertificate(piv)
    try {
      YubicoPivAttestation.verifyFactoryCertificate(
        certificate,
        expectedSerial,
        attestationAuthorities
      )
    } catch (e: VaultException) {
      throw e
    } catch (_: Throwable) {
      throw VaultException("attestation-invalid", "factory attestation certificate is not trusted")
    }
    return certificate
  }

  /** Bind each PIN-consuming, signing, reading, or mutating command to the
   * selected card on the same PivSession that executes the command. Android
   * opens a fresh connection per method and multiple USB tokens can change
   * `currentDevice` between calls, so a JS-only serial check is insufficient. */
  private fun requireExpectedSerial(piv: PivSession, expectedSerial: String) {
    val actual = piv.serialNumber.toString()
    if (actual != expectedSerial) {
      throw VaultException("serial-mismatch", "presented key $actual, expected $expectedSerial")
    }
  }

  /** Small carrier so a code path can name its own VAULT_ERR code + detail. */
  private class VaultException(val code: String, val detail: String) : Exception("$code:$detail")

  private fun vaultError(code: String, detail: String): Throwable = Error("VAULT_ERR:$code:$detail")

  private fun mapError(t: Throwable): Throwable = when (t) {
    is VaultException -> Error("VAULT_ERR:${t.code}:${t.detail}")
    is InvalidPinException -> {
      val n = t.attemptsRemaining
      if (n <= 0) Error("VAULT_ERR:pin-locked:no attempts remaining")
      else Error("VAULT_ERR:pin-invalid:retries=$n")
    }
    is ApduException -> {
      when (t.sw.toInt() and 0xffff) {
        0x6983 -> Error("VAULT_ERR:pin-locked:authentication method blocked")
        // Only REFERENCE DATA NOT FOUND proves an empty slot. INCORRECT DATA
        // (0x6a80) can also mean an occupied slot with an algorithm mismatch.
        0x6a88 -> Error("VAULT_ERR:no-key:reference data not found")
        0x6a80 -> Error("VAULT_ERR:wrong-key:incorrect data or parameters")
        // 0x6982 (security status not satisfied) / 0x6985 (conditions not
        // satisfied) is what a required-but-unmet touch surfaces as over CCID.
        0x6982, 0x6985 -> Error("VAULT_ERR:touch-timeout:conditions of use not satisfied")
        else -> Error("VAULT_ERR:wrong-key:apdu 0x${Integer.toHexString(t.sw.toInt() and 0xffff)}")
      }
    }
    is IOException -> Error("VAULT_ERR:key-removed-mid-op:${t.message}")
    else -> Error("VAULT_ERR:wrong-key:${t.message}")
  }

  /** Validate the generated SEC1 encoding and P-256 curve equation before it
   * crosses the bridge as an enrollment candidate. */
  private fun requireOnCurveP256(point: ByteArray) {
    require(point.size == 65 && point[0] == 0x04.toByte()) { "not uncompressed SEC1" }
    val params = AlgorithmParameters.getInstance("EC").run {
      init(ECGenParameterSpec("secp256r1"))
      getParameterSpec(ECParameterSpec::class.java)
    }
    val curve = params.curve
    val modulus = (curve.field as ECFieldFp).p
    val x = BigInteger(1, point.copyOfRange(1, 33))
    val y = BigInteger(1, point.copyOfRange(33, 65))
    require(x < modulus && y < modulus) { "coordinate outside field" }
    val lhs = y.modPow(BigInteger.valueOf(2), modulus)
    val rhs = x.modPow(BigInteger.valueOf(3), modulus).add(curve.a.multiply(x)).add(curve.b).mod(modulus)
    require(lhs == rhs) { "point is off curve" }
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

  private fun hexToBytes(hex: String): ByteArray {
    val clean = hex.removePrefix("0x").removePrefix("0X")
    require(clean.length % 2 == 0) { "must have even length" }
    // Character.digit(c, 16) returns -1 for a non-hex character rather than
    // throwing, so without this explicit check a garbage string of the right
    // length (e.g. "g".repeat(64)) would silently decode to a byte array of
    // 0xEF instead of failing — exactly the class of bug this function must
    // not produce for callers that gate on decoded length alone (signEcdsa).
    require(clean.all { Character.digit(it, 16) != -1 }) { "contains a non-hex character" }
    return ByteArray(clean.length / 2) {
      ((Character.digit(clean[it * 2], 16) shl 4) + Character.digit(clean[it * 2 + 1], 16)).toByte()
    }
  }

  companion object {
    private const val VAULT_SLOT = 0x82
    private const val ATTESTATION_ASSET = "yubico-vault-attestation.pem"
    /** Firmware-default PIV management key (0x0102…08 ×3, 24 bytes). */
    private val DEFAULT_MANAGEMENT_KEY = byteArrayOf(
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08
    )
  }
}
