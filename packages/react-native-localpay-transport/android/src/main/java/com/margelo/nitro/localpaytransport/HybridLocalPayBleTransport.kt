package com.margelo.nitro.localpaytransport

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import com.margelo.nitro.localpaytransport.BleGattProfile.ACK_CHAR_UUID
import com.margelo.nitro.localpaytransport.BleGattProfile.CCCD_UUID
import com.margelo.nitro.localpaytransport.BleGattProfile.DEFAULT_ATT_MTU
import com.margelo.nitro.localpaytransport.BleGattProfile.FRAME_CHAR_UUID
import com.margelo.nitro.localpaytransport.BleGattProfile.IDLE_CONNECTION_TIMEOUT_MS
import com.margelo.nitro.localpaytransport.BleGattProfile.MAX_BLE_FRAME_BYTES
import com.margelo.nitro.localpaytransport.BleGattProfile.MTU_NEGOTIATION_TIMEOUT_MS
import com.margelo.nitro.localpaytransport.BleGattProfile.PENDING_ACK_TIMEOUT_MS
import com.margelo.nitro.localpaytransport.BleGattProfile.REQUESTED_MTU
import com.margelo.nitro.localpaytransport.BleGattProfile.TAG
import com.margelo.nitro.localpaytransport.BleGattProfile.TYPE_ACK
import com.margelo.nitro.localpaytransport.BleGattProfile.TYPE_FRAME
import com.margelo.nitro.localpaytransport.BleGattProfile.TYPE_HELLO_A
import com.margelo.nitro.localpaytransport.BleGattProfile.TYPE_HELLO_B
import java.util.UUID

/** Chunk writes refused with ERROR_GATT_WRITE_REQUEST_BUSY are retried this many times, this far apart. */
private const val WRITE_BUSY_MAX_RETRIES = 5
private const val WRITE_BUSY_RETRY_MS = 20L
/** Pre-API-33 writeCharacteristic only says false; a stand-in code so the log line reads the same. */
private const val WRITE_REJECTED_LEGACY = -1

/**
 * LocalPayBleTransport over android.bluetooth GATT — the `bsvpay-ble/1`
 * profile (design §2–§3). Payee = GATT peripheral (advertises the
 * session-derived service UUID, receives HELLO_A/FRAME on the FRAME
 * characteristic, answers HELLO_B/ACK as indications). Payer = GATT central
 * (scan-filters to exactly that UUID, connects, negotiates MTU, subscribes,
 * writes HELLO_A then FRAME, waits for the HMAC'd ACK).
 *
 * Structurally a mirror of HybridLocalPayTransport (Nearby): all mutable
 * state is confined to the main-thread Handler — every BluetoothGatt*Callback
 * arrives on a binder thread and is hopped onto `main` — `hasAccepted` is the
 * payee's first-success-wins latch, `boundDevice` is set only after a
 * verified HELLO_A, `pendingAckDevice` is the one link held open for
 * confirmFrame, and the idle/ack reapers check their own identity before
 * acting. Trust is entirely in the message-layer HMACs: GATT without bonding
 * has no link security, and the ACK carries its own MAC so a UUID-sniffing
 * impostor cannot forge {"ok":true} (§3).
 *
 * Four behaviours are deliberately identical to the reviewed Swift twin
 * (ios/HybridLocalPayBleTransport.swift), because each of them is the
 * difference between a safe failure and a payment reported as delivered to a
 * peer that never heard it:
 *
 *  1. `refuse()` — a stray message from the central being held for the ack (a
 *     duplicate FRAME after `hasAccepted`, an unexpected type, a reassembly
 *     error) is logged and dropped WITHOUT cutting that central's link: it is
 *     the only route the ack has.
 *  2. `dropCentral()` on the held central releases the hold as well, so a
 *     later `confirmFrame` rejects "peer disconnected before acking" instead
 *     of indicating into nowhere and resolving as if the payer had been told.
 *  3. The payer ignores (logs) any non-ACK message once its FRAME is on the
 *     wire; only a bad ACK MAC or a timeout fails from there, because the
 *     payee may already have queued the payment.
 *  4. The GATT write response goes out before anything that could follow from
 *     JS's `confirmFrame`, i.e. inside `onCharacteristicWriteRequest` before
 *     `onFrame` is invoked.
 *
 * The same structurally-unclosable stopListening-vs-in-flight-ack race the
 * Nearby class documents applies here (an indication in flight when JS calls
 * stopListening), and the same JS discipline in core/localpay/transport/
 * socket.ts (never stopListening on a path that still holds a confirm handle)
 * is what keeps it unreachable.
 */
@Suppress("DEPRECATION")
@SuppressLint("MissingPermission") // every android.bluetooth call sits behind canConnect()/canScan()/canAdvertise()
class HybridLocalPayBleTransport : HybridLocalPayBleTransportSpec() {
  private val main = Handler(Looper.getMainLooper())

  private fun context(): Context? = NitroModules.applicationContext

  private fun manager(): BluetoothManager? =
    context()?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  private fun adapter(): BluetoothAdapter? = manager()?.adapter

  private fun hasBleHardware(): Boolean =
    context()?.packageManager?.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) == true

  // ── permissions (§7: JS requests them first; native only refuses) ──

  private fun granted(permission: String): Boolean {
    val ctx = context() ?: return false
    return ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED
  }

  private fun canConnect(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S || granted(Manifest.permission.BLUETOOTH_CONNECT)

  private fun canScan(): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) granted(Manifest.permission.BLUETOOTH_SCAN) && canConnect()
    else granted(Manifest.permission.ACCESS_FINE_LOCATION)

  private fun canAdvertise(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
      (granted(Manifest.permission.BLUETOOTH_ADVERTISE) && canConnect())

  // ── prompt-free probes ──

  /**
   * BLE hardware present and the radio switched on. Deliberately permission-
   * independent: the ladder must be able to pick BLE before the first grant
   * (§7). Power IS included — BluetoothAdapter.isEnabled is prompt-free — so a
   * payer whose radio is off floors to QR with the local_bt_off copy (§5)
   * instead of burning a 6 s connect budget that cannot succeed. The Swift
   * backend does the same once a manager has reported poweredOff.
   */
  override fun isSupported(): Boolean {
    val a = adapter() ?: return false
    return hasBleHardware() && a.isEnabled
  }

  /**
   * Order matters, and it is power BEFORE permissions: reading `state` needs no
   * runtime permission, so a fresh payer whose radio is simply off can be told
   * to turn Bluetooth on (`local_bt_off`, §5) instead of being sent to Settings
   * by the "Allow it in Settings" copy that `unauthorized` (`local_ble_denied`)
   * selects. STATE_TURNING_ON / STATE_TURNING_OFF stay "unknown" — that is what
   * prepare() polls on. Prompt-free throughout.
   */
  override fun bluetoothState(): String {
    val a = adapter() ?: return "unsupported"
    if (!hasBleHardware()) return "unsupported"
    when (a.state) {
      BluetoothAdapter.STATE_ON -> Unit
      BluetoothAdapter.STATE_OFF -> return "poweredOff"
      else -> return "unknown" // STATE_TURNING_ON / STATE_TURNING_OFF
    }
    if (!(canScan() && canConnect() && canAdvertise())) return "unauthorized"
    return "poweredOn"
  }

  override fun nfcAvailable(): Boolean {
    val ctx = context() ?: return false
    return try {
      NfcAdapter.getDefaultAdapter(ctx)?.isEnabled == true
    } catch (e: Exception) {
      false
    }
  }

  /**
   * Android has no async manager bring-up to wait for, so this resolves as
   * soon as the adapter is in a settled state (polling through
   * TURNING_ON/OFF until timeoutMs), opening the GATT server when powered on
   * so startListening has one fewer thing to fail on. Idempotent.
   */
  override fun prepare(timeoutMs: Double): Promise<String> {
    val promise = Promise<String>()
    main.post {
      val deadline = SystemClock.elapsedRealtime() + timeoutMs.toLong()
      lateinit var poll: Runnable
      poll = Runnable {
        val state = bluetoothState()
        if (state != "unknown" || SystemClock.elapsedRealtime() >= deadline) {
          if (state == "poweredOn") ensureGattServer()
          Log.d(TAG, "prepare: $state")
          promise.resolve(state)
        } else {
          main.postDelayed(poll, PREPARE_POLL_MS)
        }
      }
      poll.run()
    }
    return promise
  }

  // ── payee (peripheral) state — main thread only ──

  private class Central(val device: BluetoothDevice) {
    val reassembler = BleGattProfile.Reassembler()
    var subscribed = false
    var mtu = DEFAULT_ATT_MTU
  }

  private class IndicationJob(
    val device: BluetoothDevice,
    val chunks: ArrayDeque<ByteArray>,
    val onDone: (Boolean) -> Unit
  )

  private var gattServer: BluetoothGattServer? = null
  private var service: BluetoothGattService? = null
  private var ackCharacteristic: BluetoothGattCharacteristic? = null
  private var advertising = false
  private var listening = false
  private var listenPsk: ByteArray? = null
  private var listenName: String? = null
  private var listenOnFrame: ((String) -> Unit)? = null
  private var listenOnError: ((String) -> Unit)? = null
  /** Resolved by AdvertiseCallback.onStartSuccess, rejected by any failure before it. */
  private var startPromise: Promise<Unit>? = null
  private var listenStartedAt = 0L
  /** Every connected central, keyed by MAC address. */
  private val centrals = mutableMapOf<String, Central>()
  /** Central whose HELLO_A verified. Only its FRAME is deliverable. */
  private var boundDevice: BluetoothDevice? = null
  /** Central holding an undelivered ack — the one confirmFrame answers. */
  private var pendingAckDevice: BluetoothDevice? = null
  /**
   * Central the ACK is being indicated to right now (Swift's
   * `session.ackTarget`). confirmFrame clears `pendingAckDevice` the moment it
   * commits, so without this the ack route would be unprotected for the few ms
   * the indication is on the wire and one stray write from the payer could
   * drop the link out from under it. Cleared by resetSession.
   */
  private var ackTargetDevice: BluetoothDevice? = null
  /** First-success-wins latch; see HybridLocalPayTransport.hasAccepted. */
  private var hasAccepted = false
  private val idleReapers = mutableMapOf<String, Runnable>()
  private var ackReaper: Runnable? = null
  /** Indications are serialized: one chunk in flight per server, next chunk only after onNotificationSent (§3 framing). */
  private val indicationJobs = ArrayDeque<IndicationJob>()
  private var indicationInFlight: IndicationJob? = null

  private fun ensureGattServer(): BluetoothGattServer? {
    gattServer?.let { return it }
    val ctx = context() ?: return null
    if (!canConnect()) return null
    val server = manager()?.openGattServer(ctx, serverCallback) ?: return null
    gattServer = server
    watchAdapter()
    return server
  }

  /**
   * Bluetooth switched off under a live listener. Android delivers no GATT
   * callback for that, so without this the BLE rung would sit dead until the
   * screen's own abort while JS still showed it as listening. Mirrors the
   * Swift backend's peripheralManagerDidUpdateState → onError("bluetooth
   * unavailable"). A BluetoothGattServer opened before the adapter went off is
   * stale afterwards, so it is closed here and reopened lazily by the next
   * prepare()/startListening().
   */
  private var adapterReceiver: BroadcastReceiver? = null

  private fun watchAdapter() {
    if (adapterReceiver != null) return
    val ctx = context() ?: return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(c: Context?, intent: Intent?) {
        if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
        val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
        if (state != BluetoothAdapter.STATE_OFF && state != BluetoothAdapter.STATE_TURNING_OFF) return
        main.post { onAdapterOff() }
      }
    }
    // ACTION_STATE_CHANGED is a protected system broadcast, so the API 33+
    // RECEIVER_EXPORTED / RECEIVER_NOT_EXPORTED flag requirement does not apply.
    try {
      ctx.registerReceiver(receiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
      adapterReceiver = receiver
    } catch (e: RuntimeException) {
      // A strict OEM build that demands the export flag anyway (or any
      // SecurityException from a hardened ROM) must not take prepare() down
      // with it. Without the receiver the adapter-off path is simply not
      // reported early; the next radio call fails with the usual
      // "bluetooth unavailable" instead.
      Log.d(TAG, "payee: could not register the adapter-state receiver: ${e.message}")
    }
  }

  /** Runs on main. */
  private fun onAdapterOff() {
    val wasListening = listening
    val onError = listenOnError
    val pendingStart = startPromise
    startPromise = null
    resetSession(null)
    try {
      gattServer?.close()
    } catch (e: Exception) {
      // Already gone with the adapter.
    }
    gattServer = null
    if (!wasListening) return
    Log.d(TAG, "payee: bluetooth turned off under a live listener")
    if (pendingStart != null) pendingStart.reject(Error("bluetooth unavailable")) else onError?.invoke("bluetooth unavailable")
  }

  /** Same shape and identity check as HybridLocalPayTransport.armIdleReaper, but silent for EVERY central (spec §3 step 3; the Swift BLE backend is silent here too). */
  private fun armIdleReaper(device: BluetoothDevice) {
    val address = device.address
    cancelIdleReaper(address)
    lateinit var reaper: Runnable
    reaper = Runnable {
      if (idleReapers[address] !== reaper) return@Runnable
      idleReapers.remove(address)
      Log.d(TAG, "payee: idle reaper dropped $address")
      dropCentral(device)
      // Silent on the wire and to JS (spec §3 step 3): a central that never
      // finished — stranger or PSK-holder — is not a failed payment, and
      // reporting it would kill a BLE listener another payer can still use.
      // Unbind so a fresh HELLO_A can bind.
      if (address == boundDevice?.address && !hasAccepted) boundDevice = null
    }
    idleReapers[address] = reaper
    main.postDelayed(reaper, IDLE_CONNECTION_TIMEOUT_MS)
  }

  private fun cancelIdleReaper(address: String) {
    idleReapers.remove(address)?.let { main.removeCallbacks(it) }
  }

  /** Expiry is silent on the wire — never a synthesised ack (spec §3 peripheral step 7, §9 invariant 3). */
  private fun armAckReaper(device: BluetoothDevice) {
    ackReaper?.let { main.removeCallbacks(it) }
    lateinit var reaper: Runnable
    reaper = Runnable {
      // Identity check, as everywhere else: a superseded reaper that somehow
      // still fires must not release a hold it no longer owns.
      if (ackReaper !== reaper || pendingAckDevice?.address != device.address) return@Runnable
      ackReaper = null
      pendingAckDevice = null
      // `hasAccepted` stays true on purpose: this listening session is over
      // either way (advertising stopped at FRAME) and only a fresh
      // startListening() gets a clean slate — so a confirmFrame arriving after
      // this rejects "peer disconnected before acking" rather than resolving.
      Log.d(TAG, "payee: ack reaper fired; connection released (${device.address})")
      dropCentral(device)
      listenOnError?.invoke("payee never confirmed the payment; connection released")
    }
    ackReaper = reaper
    main.postDelayed(reaper, PENDING_ACK_TIMEOUT_MS)
  }

  private fun cancelAckReaper() {
    ackReaper?.let { main.removeCallbacks(it) }
    ackReaper = null
  }

  /**
   * Forget a central and cut its link. Any indication queued for it fails
   * (onDone(false)).
   *
   * Swift hardening 2: dropping the central that was being HELD for the ack
   * releases the hold too. Without that, `pendingAckDevice` would keep
   * pointing at a departed peer, `confirmFrame` would queue the ACK, the
   * stack would accept it, and the promise would resolve — reporting a
   * delivered ack for a payment the payer never heard about. Releasing here
   * makes that path reject "peer disconnected before acking" (via
   * confirmFrame's `hasAccepted` branch), which is the safe failure: the
   * payer's inputs stay locked.
   */
  private fun dropCentral(device: BluetoothDevice) {
    cancelIdleReaper(device.address)
    // Removing it from `centrals` is what actually severs the ack route;
    // clearing `subscribed` mirrors the Swift twin so any surviving reference
    // reads as "no route back".
    centrals.remove(device.address)?.subscribed = false
    if (device.address == pendingAckDevice?.address) {
      pendingAckDevice = null
      cancelAckReaper()
    }
    failIndicationsFor(device)
    gattServer?.cancelConnection(device)
  }

  /**
   * Swift hardening 1: refuses ONE message from one central. The central being
   * held for the ack is deliberately NOT dropped — a stray or malformed write
   * from the payer after its FRAME was accepted (a duplicate, a retry, a
   * truncated record) must not cost it the ack route it is waiting on.
   * Everything else is dropped outright.
   */
  private fun refuse(device: BluetoothDevice, reason: String) {
    Log.d(TAG, "payee: frame refused reason=$reason id=${device.address}")
    // Held for the ack, or being acked right now: keep the link either way.
    // Only a real disconnect (dropCentral from onConnectionStateChange) is
    // allowed to take the ack route down.
    if (device.address == pendingAckDevice?.address || device.address == ackTargetDevice?.address) return
    dropCentral(device)
  }

  private fun failIndicationsFor(device: BluetoothDevice) {
    val orphaned = indicationJobs.filter { it.device.address == device.address }
    indicationJobs.removeAll(orphaned)
    orphaned.forEach { it.onDone(false) }
    val inFlight = indicationInFlight
    if (inFlight != null && inFlight.device.address == device.address) {
      indicationInFlight = null
      inFlight.onDone(false)
      pumpIndications()
    }
  }

  private fun sendIndication(central: Central, message: ByteArray, onDone: (Boolean) -> Unit) {
    val chunks = BleGattProfile.chunk(BleGattProfile.lengthPrefixed(message), central.mtu)
    indicationJobs.addLast(IndicationJob(central.device, chunks, onDone))
    pumpIndications()
  }

  private fun pumpIndications() {
    if (indicationInFlight != null) return
    val job = indicationJobs.removeFirstOrNull() ?: return
    val first = job.chunks.removeFirstOrNull()
    if (first == null) {
      job.onDone(true)
      pumpIndications()
      return
    }
    indicationInFlight = job
    if (!notifyChunk(job.device, first)) {
      indicationInFlight = null
      job.onDone(false)
      pumpIndications()
    }
  }

  /** Runs on main from onNotificationSent: advance the in-flight job by one chunk. */
  private fun onIndicationResult(device: BluetoothDevice, status: Int) {
    val job = indicationInFlight ?: return
    if (job.device.address != device.address) return
    if (status != BluetoothGatt.GATT_SUCCESS) {
      indicationInFlight = null
      job.onDone(false)
      pumpIndications()
      return
    }
    val next = job.chunks.removeFirstOrNull()
    if (next == null) {
      indicationInFlight = null
      job.onDone(true)
      pumpIndications()
      return
    }
    if (!notifyChunk(job.device, next)) {
      indicationInFlight = null
      job.onDone(false)
      pumpIndications()
    }
  }

  /** confirm = true → indication (ATT-acknowledged), which is what the ACK characteristic declares (§2). */
  private fun notifyChunk(device: BluetoothDevice, chunk: ByteArray): Boolean {
    val server = gattServer ?: return false
    val characteristic = ackCharacteristic ?: return false
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        server.notifyCharacteristicChanged(device, characteristic, true, chunk) == BluetoothStatusCodes.SUCCESS
      } else {
        characteristic.value = chunk
        server.notifyCharacteristicChanged(device, characteristic, true)
      }
    } catch (e: Exception) {
      Log.d(TAG, "payee: notifyCharacteristicChanged threw: ${e.message}")
      false
    }
  }

  /** Runs on main. Mirrors HybridLocalPayTransport.payeePayloads.onPayloadReceived one type byte at a time (§3 peripheral steps 4–5). */
  private fun handleCentralMessage(central: Central, message: ByteArray) {
    val psk = listenPsk ?: return
    val name = listenName ?: return
    val device = central.device
    // An earlier message in the same write batch may already have dropped it.
    if (centrals[device.address] !== central) return
    if (message.isEmpty()) {
      refuse(device, "empty message")
      return
    }
    when (message[0]) {
      TYPE_HELLO_A -> {
        if (hasAccepted) {
          // The session already has its payer; nobody else gets HELLO_B, and a
          // stray HELLO_A from the held central must not cost it the ack route.
          refuse(device, "already accepted")
          return
        }
        val proof = message.copyOfRange(1, message.size)
        if (!BleGattProfile.constantTimeEquals(proof, BleGattProfile.proof(psk, name, TYPE_HELLO_A))) {
          // Silent: a stranger must not be able to kill a live request. Advertising continues.
          Log.d(TAG, "payee: HELLO_A proof failed from ${device.address}; dropping")
          dropCentral(device)
          return
        }
        if (!central.subscribed) {
          // Indications cannot be delivered without a CCCD subscription; the profile subscribes before HELLO_A (§3 central step 4).
          Log.d(TAG, "payee: HELLO_A verified but ${device.address} never subscribed to ACK; dropping")
          dropCentral(device)
          return
        }
        boundDevice = device
        Log.d(TAG, "payee: HELLO_A verified from ${device.address} at ${SystemClock.elapsedRealtime() - listenStartedAt} ms; sending HELLO_B")
        sendIndication(central, BleGattProfile.helloB(psk, name)) { ok ->
          // `listening` guards the teardown path: resetSession fails every
          // queued indication, and that is not a peer failure to report.
          if (!ok && listening) {
            Log.d(TAG, "payee: HELLO_B indication failed to ${device.address}")
            dropCentral(device)
            if (boundDevice?.address == device.address) boundDevice = null
            listenOnError?.invoke("failed to reply to peer: indication not delivered")
          }
        }
      }
      TYPE_FRAME -> {
        if (device.address != boundDevice?.address) {
          refuse(device, "not bound")
          return
        }
        if (hasAccepted) {
          // First-success-wins: a second PSK-holder reaching FRAME is refused outright, not raced (§9 invariant 4).
          refuse(device, "already accepted")
          return
        }
        val sealed = message.copyOfRange(1, message.size)
        if (sealed.isEmpty()) {
          refuse(device, "empty frame")
          return
        }
        cancelIdleReaper(device.address)
        hasAccepted = true
        pendingAckDevice = device
        stopAdvertising()
        // Arm the hold BEFORE handing the frame to JS: confirmFrame may come
        // back synchronously from the callback (see Nearby's acceptConnection).
        armAckReaper(device)
        Log.d(TAG, "payee: frame accepted (${sealed.size} bytes, mtu ${central.mtu}) from ${device.address} at ${SystemClock.elapsedRealtime() - listenStartedAt} ms; advertising stopped")
        listenOnFrame?.invoke(Base64.encodeToString(sealed, Base64.NO_WRAP))
      }
      else -> refuse(device, "unexpected type ${message[0].toInt() and 0xff}")
    }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      main.post {
        when (newState) {
          BluetoothProfile.STATE_CONNECTED -> {
            if (!listening) return@post
            Log.d(TAG, "payee: central connected ${device.address} (status $status)")
            if (centrals.containsKey(device.address)) {
              // Keep the entry we already have. A FRAME or CCCD write can
              // outrun this callback and register the central lazily; replacing
              // it here would throw away a mid-record reassembler and the
              // subscription flag, and re-arm a second idle reaper for the
              // same address.
              return@post
            }
            if (hasAccepted &&
              device.address != pendingAckDevice?.address &&
              device.address != ackTargetDevice?.address
            ) {
              // The session already has its payer: no new state for anyone
              // else (same guard as the two lazy-registration sites below).
              Log.d(TAG, "payee: ignoring ${device.address}; session already has its payer")
              return@post
            }
            centrals[device.address] = Central(device)
            // Never arm the 30 s idle reaper once a frame is accepted: it
            // would outlive nothing useful and could fire inside the 60 s ack
            // hold on the very link the ack has to cross.
            if (!hasAccepted) armIdleReaper(device)
          }
          BluetoothProfile.STATE_DISCONNECTED -> {
            Log.d(TAG, "payee: central disconnected ${device.address} (status $status)")
            // dropCentral, not a bare map removal: if this WAS the held
            // central the hold has to go with it (Swift hardening 2), so a
            // later confirmFrame reports the failure instead of indicating
            // into a closed link.
            dropCentral(device)
            if (device.address == boundDevice?.address && !hasAccepted) boundDevice = null
          }
        }
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      main.post {
        centrals[device.address]?.mtu = mtu
        Log.d(TAG, "payee: mtu $mtu for ${device.address}")
      }
    }

    override fun onServiceAdded(status: Int, addedService: BluetoothGattService) {
      main.post {
        if (addedService.uuid != service?.uuid) return@post
        if (status != BluetoothGatt.GATT_SUCCESS) {
          failStart("bluetooth unavailable: could not add GATT service (status $status)")
          return@post
        }
        Log.d(TAG, "payee: service added ${addedService.uuid}; starting advertising")
        startAdvertising(addedService.uuid)
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?
    ) {
      main.post {
        // Swift hardening 4: the write response goes out FIRST, before
        // anything that could follow from JS's confirmFrame. onFrame is
        // invoked further down this same main-thread hop, so an indication
        // can never overtake the response to the write that carried the FRAME.
        //
        // Prepared (long) writes are answered before anything else and NOT
        // with GATT_SUCCESS: the profile never uses them (chunks are ≤ MTU − 3
        // by construction, §3), and telling a peer its queued write was
        // accepted and then refusing it is worse than refusing it outright.
        if (preparedWrite) {
          if (responseNeeded) {
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null)
          }
          if (characteristic.uuid == FRAME_CHAR_UUID && listening) refuse(device, "prepared write")
          return@post
        }
        if (responseNeeded) {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
        }
        if (characteristic.uuid != FRAME_CHAR_UUID || !listening) return@post
        // A write can outrun our main-thread bookkeeping of the CONNECTED
        // event, so the central is registered lazily — but never once this
        // session has its payer (mirrors the Swift twin's
        // `insufficientAuthorization` branch): a refused stranger writing in a
        // loop must not be able to keep minting Central entries and reapers.
        val central = centrals[device.address] ?: run {
          if (hasAccepted) return@post
          val fresh = Central(device)
          centrals[device.address] = fresh
          armIdleReaper(device)
          fresh
        }
        if (value == null || value.isEmpty()) return@post
        val messages = try {
          central.reassembler.feed(value)
        } catch (e: RuntimeException) {
          // RuntimeException, not just IllegalArgumentException: this runnable
          // is the top of the stack for a binder-delivered write, so anything
          // that escapes it kills the process. The held central survives a
          // framing refusal by design, so its reassembler is resynchronised
          // here as well as inside feed().
          Log.d(TAG, "payee: bad framing from ${device.address}: ${e.message}; dropping")
          central.reassembler.reset()
          refuse(device, "oversize or bad frame length")
          return@post
        }
        for (message in messages) handleCentralMessage(central, message)
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?
    ) {
      main.post {
        if (responseNeeded) {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
        }
        if (descriptor.uuid != CCCD_UUID || descriptor.characteristic.uuid != ACK_CHAR_UUID || !listening) return@post
        val central = centrals[device.address] ?: run {
          if (hasAccepted) return@post
          val fresh = Central(device)
          centrals[device.address] = fresh
          armIdleReaper(device)
          fresh
        }
        // 0x01 = notifications, 0x02 = indications; iOS setNotifyValue(true) writes 0x02 for an indicate-only characteristic.
        central.subscribed = value != null && value.isNotEmpty() && (value[0].toInt() and 0x03) != 0
        Log.d(TAG, "payee: ${device.address} ${if (central.subscribed) "subscribed to" else "unsubscribed from"} ACK")
      }
    }

    override fun onDescriptorReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      descriptor: BluetoothGattDescriptor
    ) {
      main.post {
        val subscribed = centrals[device.address]?.subscribed == true
        val current = if (subscribed) BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, current)
      }
    }

    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic
    ) {
      // ACK is indicate-only; a read (iOS does one occasionally after subscribing) gets an empty value.
      main.post {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, ByteArray(0))
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      main.post { onIndicationResult(device, status) }
    }
  }

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
      main.post {
        advertising = true
        Log.d(TAG, "payee: advertising ${service?.uuid} (${SystemClock.elapsedRealtime() - listenStartedAt} ms after startListening)")
        startPromise?.resolve(Unit)
        startPromise = null
      }
    }

    override fun onStartFailure(errorCode: Int) {
      main.post {
        advertising = false
        failStart("advertising failed: code $errorCode")
      }
    }
  }

  private fun startAdvertising(uuid: UUID) {
    val advertiser = adapter()?.bluetoothLeAdvertiser
    if (advertiser == null || !canAdvertise()) {
      failStart("bluetooth unavailable")
      return
    }
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .setTimeout(0)
      .build()
    // A 128-bit UUID takes 18 of the 31 legacy-advertisement bytes; the device
    // name would overflow it (ADVERTISE_FAILED_DATA_TOO_LARGE). localName is
    // advisory in the profile (§2) and Android cannot set a per-app name
    // without renaming the adapter, so the UUID goes alone.
    val data = AdvertiseData.Builder()
      .addServiceUuid(ParcelUuid(uuid))
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .build()
    try {
      advertiser.startAdvertising(settings, data, advertiseCallback)
    } catch (e: Exception) {
      failStart("advertising failed: ${e.message}")
    }
  }

  private fun stopAdvertising() {
    advertising = false
    try {
      adapter()?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
    } catch (e: Exception) {
      // Adapter already off: nothing left to stop.
    }
  }

  private fun failStart(message: String) {
    Log.d(TAG, "payee: start failed: $message")
    val promise = startPromise
    startPromise = null
    resetSession(null)
    promise?.reject(Error(message))
  }

  /**
   * Tears down everything except the GATT server object itself: advertising,
   * every central, every reaper, every queued indication, the service, the
   * latches. Used by the startListening self-reset (mirrors Swift's
   * resetListening and Nearby's stopAdvertising/disconnect block), by
   * stopListening, and after the ack has left. `pendingStartError` rejects a
   * start still waiting on AdvertiseCallback so no promise is left hanging.
   */
  private fun resetSession(pendingStartError: String?) {
    stopAdvertising()
    idleReapers.values.forEach { main.removeCallbacks(it) }
    idleReapers.clear()
    cancelAckReaper()
    val server = gattServer
    val stale = (centrals.values.map { it.device } + listOfNotNull(boundDevice, pendingAckDevice))
      .distinctBy { it.address }
    centrals.values.forEach { it.subscribed = false }
    centrals.clear()
    // Cleared BEFORE the orphaned indications are failed: their callbacks read
    // these flags to tell "the peer went away" from "we are tearing down".
    hasAccepted = false
    boundDevice = null
    pendingAckDevice = null
    ackTargetDevice = null
    listening = false
    val orphaned = indicationJobs.toList() + listOfNotNull(indicationInFlight)
    indicationJobs.clear()
    indicationInFlight = null
    stale.forEach { server?.cancelConnection(it) }
    orphaned.forEach { it.onDone(false) }
    service?.let { server?.removeService(it) }
    service = null
    ackCharacteristic = null
    val pending = startPromise
    startPromise = null
    if (pendingStartError != null) pending?.reject(Error(pendingStartError))
  }

  override fun startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: (String) -> Unit,
    onError: (String) -> Unit
  ): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      val psk = try { Base64.decode(pskBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      if (psk == null || psk.isEmpty() || instanceName.isEmpty()) {
        promise.reject(Error("bad psk or instance name"))
        return@post
      }
      val a = adapter()
      if (a == null || !hasBleHardware() || !a.isEnabled || !canConnect() || !canAdvertise()) {
        promise.reject(Error("bluetooth unavailable"))
        return@post
      }
      val server = ensureGattServer()
      if (server == null) {
        promise.reject(Error("bluetooth unavailable"))
        return@post
      }

      // Self-reset: a fresh session never inherits a previous one's bookkeeping (§3 peripheral step 2).
      resetSession("superseded by a new startListening")

      val uuid = BleGattProfile.serviceUuid(psk, instanceName)
      val frame = BluetoothGattCharacteristic(
        FRAME_CHAR_UUID,
        BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
        BluetoothGattCharacteristic.PERMISSION_WRITE
      )
      val ack = BluetoothGattCharacteristic(
        ACK_CHAR_UUID,
        BluetoothGattCharacteristic.PROPERTY_INDICATE,
        BluetoothGattCharacteristic.PERMISSION_READ
      )
      ack.addDescriptor(
        BluetoothGattDescriptor(
          CCCD_UUID,
          BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
        )
      )
      val svc = BluetoothGattService(uuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
      svc.addCharacteristic(frame)
      svc.addCharacteristic(ack)

      listening = true
      listenPsk = psk
      listenName = instanceName
      listenOnFrame = onFrame
      listenOnError = onError
      listenStartedAt = SystemClock.elapsedRealtime()
      service = svc
      ackCharacteristic = ack
      startPromise = promise
      Log.d(TAG, "payee: adding service $uuid for $instanceName")
      // addService is asynchronous; advertising starts from onServiceAdded.
      if (!server.addService(svc)) failStart("bluetooth unavailable: could not add GATT service")
    }
    return promise
  }

  override fun stopListening(): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      // Cancels a link still held for confirmFrame, so JS must never call
      // this on the success path — see the `teardown` flag in socket.ts.
      Log.d(TAG, "payee: listening stopped by JS")
      resetSession("listening stopped")
      listenPsk = null
      listenName = null
      listenOnFrame = null
      listenOnError = null
      promise.resolve(Unit)
    }
    return promise
  }

  override fun confirmFrame(accepted: Boolean, reason: String): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      cancelAckReaper()
      val device = pendingAckDevice
      val psk = listenPsk
      val name = listenName
      val central = device?.let { centrals[it.address] }
      if (device == null || psk == null || name == null || gattServer == null ||
        central == null || !central.subscribed
      ) {
        if (ackTargetDevice != null) {
          // A second confirmFrame while the first call's ACK is still on the
          // wire (or has just been delivered). The first call owns that send
          // and its own promise; resetSession here would fail the in-flight
          // indication and reject BOTH promises for a peer that was still
          // there. Idempotent no-op instead, per the spec's confirmFrame
          // contract.
          Log.d(TAG, "payee: confirmFrame ignored; an ack is already in flight to ${ackTargetDevice?.address}")
          promise.resolve(Unit)
        } else if (hasAccepted) {
          // A frame WAS accepted in this session but the route back is gone
          // (the payer disconnected or unsubscribed, or the ack reaper already
          // released the hold) and no ack ever went out. Reject rather than
          // resolve: resolving would tell JS the payer was informed when it was
          // not, and the payer's inputs staying locked is the safe failure
          // (Swift hardening 2).
          Log.d(TAG, "payee: confirmFrame with no ack route; peer is gone")
          resetSession(null)
          promise.reject(Error("peer disconnected before acking"))
        } else {
          // Nothing pending: idempotent and safe to call late, per the spec contract.
          promise.resolve(Unit)
        }
        return@post
      }
      pendingAckDevice = null
      boundDevice = null
      // Full-session teardown of everything EXCEPT this link and the service
      // (an indication on a removed service never leaves the stack): drop the
      // other centrals and their reapers now, finish after the ack is through.
      idleReapers.values.forEach { main.removeCallbacks(it) }
      idleReapers.clear()
      centrals.values.filter { it.device.address != device.address }.toList().forEach { dropCentral(it.device) }
      val json = BleGattProfile.ackJson(accepted, reason).toByteArray(Charsets.UTF_8)
      val t0 = SystemClock.elapsedRealtime()
      // Protects this link while the indication is on the wire; resetSession
      // clears it once the ack is through (or the send failed).
      ackTargetDevice = device
      sendIndication(central, BleGattProfile.ackMessage(psk, name, json)) { ok ->
        Log.d(TAG, "payee: ack ok=$accepted delivered=$ok to ${device.address} in ${SystemClock.elapsedRealtime() - t0} ms")
        gattServer?.cancelConnection(device)
        resetSession(null)
        if (ok) promise.resolve(Unit) else promise.reject(Error("peer disconnected before acking"))
      }
    }
    return promise
  }

  // ── reversed role (spec 2026-09-03) — filled in by the PayerAdvertise / startScanning tasks ──

  override fun startScanning(
    instanceName: String,
    pskBase64: String,
    onFrame: (String) -> Unit,
    onError: (String) -> Unit
  ): Promise<Unit> {
    val promise = Promise<Unit>()
    promise.reject(Error("bluetooth unavailable"))
    return promise
  }

  override fun sendFrameAdvertising(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> {
    val promise = Promise<String>()
    promise.reject(Error("bluetooth unavailable"))
    return promise
  }

  // ── payer (central) ──

  override fun sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> {
    val promise = Promise<String>()
    main.post {
      val ctx = context()
      val a = adapter()
      // Pre-flight rejections happen before any radio work, so there is no
      // `settle` yet — but they are still terminal failures of a send, and the
      // hardware checklist reads every one of them off a `send failed
      // reason=` line rather than inferring it from a missing line.
      fun rejectEarly(message: String) {
        Log.d(TAG, "payer: send failed reason=$message")
        promise.reject(Error(message))
      }
      val psk = try { Base64.decode(pskBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      val sealed = try { Base64.decode(frameBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      if (psk == null || psk.isEmpty() || sealed == null || instanceName.isEmpty()) {
        rejectEarly("bad psk or frame")
        return@post
      }
      if (sealed.size + 1 > MAX_BLE_FRAME_BYTES) {
        // The profile's ceiling, not a GATT limit: JS falls back to the fountain, which has none below 64 KiB (§3).
        rejectEarly("frame too large for a BLE payload")
        return@post
      }
      val scanner = a?.bluetoothLeScanner
      if (ctx == null || a == null || !hasBleHardware() || !a.isEnabled || scanner == null || !canScan() || !canConnect()) {
        rejectEarly("bluetooth unavailable")
        return@post
      }

      val uuid = BleGattProfile.serviceUuid(psk, instanceName)
      val t0 = SystemClock.elapsedRealtime()
      fun elapsed(): Long = SystemClock.elapsedRealtime() - t0

      var settled = false
      /** Step 4 (subscribed to ACK) reached: the connect budget no longer applies (§3 central step 8). */
      var ready = false
      /** Swift hardening 3: stage writing-frame / awaiting-ack. */
      var frameOnWire = false
      var scanning = false
      var gatt: BluetoothGatt? = null
      var mtu = DEFAULT_ATT_MTU
      var discoveryStarted = false
      var mtuTimer: Runnable? = null
      var connectTimer: Runnable? = null
      var wholeTimer: Runnable? = null
      val reassembler = BleGattProfile.Reassembler()
      var frameCharacteristic: BluetoothGattCharacteristic? = null
      var writeQueue = ArrayDeque<ByteArray>()
      var writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
      var onWriteQueueDrained: (() -> Unit)? = null
      lateinit var scanCallback: ScanCallback

      fun settle(block: () -> Unit) {
        if (settled) return
        settled = true
        if (scanning) {
          scanning = false
          try { scanner.stopScan(scanCallback) } catch (e: Exception) { /* adapter off */ }
        }
        mtuTimer?.let { main.removeCallbacks(it) }
        connectTimer?.let { main.removeCallbacks(it) }
        wholeTimer?.let { main.removeCallbacks(it) }
        gatt?.let {
          try {
            it.disconnect()
            it.close()
          } catch (e: Exception) {
            // Already gone.
          }
        }
        gatt = null
        block()
      }

      /**
       * Swift hardening 3 (log half): every terminal failure of a send says so
       * in the log, so the hardware rows are positive checks rather than
       * inferences from a missing line.
       */
      fun fail(message: String) {
        settle {
          Log.d(TAG, "payer: send failed reason=$message")
          promise.reject(Error(message))
        }
      }

      /**
       * Swift hardening 3: once the FRAME is on the wire the payee may already
       * have queued the payment, so nothing unexpected may reject — doing so
       * would drop a paid session onto the fountain. Only a bad ACK MAC or a
       * timeout fails from there.
       */
      fun ignoreOrFail(type: Int, bodyBytes: Int, message: String) {
        if (frameOnWire) {
          Log.d(TAG, "payer: unexpected message ignored type=$type bytes=$bodyBytes")
          return
        }
        fail(message)
      }

      /**
       * Next chunk only after the previous onCharacteristicWrite — Android
       * delivers it for WRITE_TYPE_NO_RESPONSE too (§3 step 6).
       *
       * API 33+ answers a write the stack cannot take yet with
       * ERROR_GATT_WRITE_REQUEST_BUSY. Some OEM stacks (seen: OSCAL TIGER 13,
       * Android 14) clear their busy flag only AFTER delivering
       * onCharacteristicWrite, so the very next chunk, written from inside that
       * callback, is refused. That is a moment's contention, not a dead link:
       * retry a few times before giving up, and log the code either way.
       */
      var busyRetries = 0
      fun writeNextChunk(g: BluetoothGatt) {
        val characteristic = frameCharacteristic
        if (characteristic == null) {
          fail("session service not found on peer")
          return
        }
        val chunk = writeQueue.firstOrNull()
        if (chunk == null) {
          val drained = onWriteQueueDrained
          onWriteQueueDrained = null
          drained?.invoke()
          return
        }
        val status = try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            g.writeCharacteristic(characteristic, chunk, writeType)
          } else {
            characteristic.writeType = writeType
            characteristic.value = chunk
            if (g.writeCharacteristic(characteristic)) BluetoothStatusCodes.SUCCESS else WRITE_REJECTED_LEGACY
          }
        } catch (e: Exception) {
          WRITE_REJECTED_LEGACY
        }
        Log.d(TAG, "payer: chunk write submitted bytes=${chunk.size} remaining=${writeQueue.size - 1} type=$writeType status=$status at ${elapsed()} ms")
        when {
          status == BluetoothStatusCodes.SUCCESS -> {
            writeQueue.removeFirst()
            busyRetries = 0
          }
          status == BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY && busyRetries < WRITE_BUSY_MAX_RETRIES -> {
            busyRetries++
            Log.d(TAG, "payer: stack busy on chunk write; retry $busyRetries in $WRITE_BUSY_RETRY_MS ms")
            main.postDelayed({ if (!settled) writeNextChunk(g) }, WRITE_BUSY_RETRY_MS)
          }
          else -> fail("failed to send frame: write rejected by the stack (status $status)")
        }
      }

      fun writeMessage(g: BluetoothGatt, message: ByteArray, type: Int, onDrained: () -> Unit) {
        writeQueue = BleGattProfile.chunk(BleGattProfile.lengthPrefixed(message), mtu)
        writeType = type
        onWriteQueueDrained = onDrained
        writeNextChunk(g)
      }

      fun startDiscovery(g: BluetoothGatt) {
        if (settled || discoveryStarted) return
        discoveryStarted = true
        mtuTimer?.let { main.removeCallbacks(it) }
        mtuTimer = null
        if (!g.discoverServices()) fail("service discovery could not start")
      }

      fun handleIndication(g: BluetoothGatt, value: ByteArray) {
        if (settled) return
        val messages = try {
          reassembler.feed(value)
        } catch (e: RuntimeException) {
          // As on the payee side: this runs at the top of a main.post runnable
          // for a binder-delivered indication, so nothing may escape it.
          fail("bad frame from peer: ${e.message}")
          return
        }
        for (message in messages) {
          if (settled) return
          val type = if (message.isEmpty()) -1 else message[0].toInt() and 0xff
          when {
            message.isEmpty() -> ignoreOrFail(type, 0, "unexpected payload from peer")

            message[0] == TYPE_HELLO_B && !frameOnWire -> {
              val proof = message.copyOfRange(1, message.size)
              if (!BleGattProfile.constantTimeEquals(proof, BleGattProfile.proof(psk, instanceName, TYPE_HELLO_B))) {
                fail("peer failed the session proof")
                return
              }
              val chunkCount = (sealed.size + 1 + BleGattProfile.LENGTH_PREFIX_BYTES + BleGattProfile.chunkSize(mtu) - 1) / BleGattProfile.chunkSize(mtu)
              Log.d(TAG, "payer: HELLO_B verified at ${elapsed()} ms; sending frame (${sealed.size} bytes, $chunkCount chunks at mtu $mtu)")
              val tFrame = SystemClock.elapsedRealtime()
              frameOnWire = true
              writeMessage(g, BleGattProfile.frameMessage(sealed), BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) {
                Log.d(TAG, "payer: frame written in ${SystemClock.elapsedRealtime() - tFrame} ms; awaiting ack")
              }
            }

            // Type paired with stage, exactly as the Swift twin's
            // `case (typeAck, .awaitingAck)`: an ACK that arrives before our
            // FRAME was ever written cannot be an ack for this payment, so it
            // falls through to the else branch below and fails there (its own
            // MAC would only prove the peer holds the PSK, not that it received
            // anything). Resolving it would release the payer's inputs against
            // a payment the payee never saw.
            message[0] == TYPE_ACK && frameOnWire -> {
              // The one failure still allowed past frameOnWire: a MAC that does
              // not verify is not our payee, and resolving it would release the
              // payer's inputs on an unauthenticated {"ok":true}.
              val json = BleGattProfile.verifyAck(psk, instanceName, message)
              if (json == null) {
                fail("peer failed the session proof")
                return
              }
              Log.d(TAG, "payer: ack verified; total ${elapsed()} ms")
              settle { promise.resolve(Base64.encodeToString(json, Base64.NO_WRAP)) }
              return
            }

            else -> ignoreOrFail(type, message.size - 1, "unexpected payload from peer")
          }
        }
      }

      val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
          main.post {
            if (settled) return@post
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
              Log.d(TAG, "payer: connected to ${g.device.address} at ${elapsed()} ms; requesting mtu $REQUESTED_MTU")
              // MTU first, discovery strictly after onMtuChanged or the 2 s
              // timer — interleaving the two is the March mDeviceBusy deadlock (§3 step 3).
              val timer = Runnable {
                if (!settled && !discoveryStarted) {
                  Log.d(TAG, "payer: mtu negotiation timed out; discovering with mtu $mtu")
                  startDiscovery(g)
                }
              }
              mtuTimer = timer
              main.postDelayed(timer, MTU_NEGOTIATION_TIMEOUT_MS)
              if (!g.requestMtu(REQUESTED_MTU)) {
                Log.d(TAG, "payer: requestMtu refused; discovering with mtu $mtu")
                startDiscovery(g)
              }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
              fail(if (ready) "peer disconnected before acking" else "connect failed: gatt status $status")
            }
          }
        }

        override fun onMtuChanged(g: BluetoothGatt, newMtu: Int, status: Int) {
          main.post {
            if (settled) return@post
            // Android 14 queues the app's MTU request behind its own connect-time
            // service discovery, so against a peripheral with many services (iOS)
            // the answer lands well after the 2 s timer started discovery. Adopt it
            // whenever it arrives, as long as no message is mid-write: a chunk size
            // is fixed per message at writeMessage(), so a later message simply
            // uses the real MTU instead of 20-byte pieces.
            if (status == BluetoothGatt.GATT_SUCCESS && writeQueue.isEmpty()) mtu = newMtu
            if (discoveryStarted) {
              Log.d(TAG, "payer: late mtu $newMtu (status $status) at ${elapsed()} ms; using $mtu")
              return@post
            }
            Log.d(TAG, "payer: mtu $mtu (status $status) at ${elapsed()} ms; discovering services")
            startDiscovery(g)
          }
        }

        override fun onPhyUpdate(g: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) {
          Log.d(TAG, "payer: phy updated tx=$txPhy rx=$rxPhy status=$status at ${elapsed()} ms")
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
          main.post {
            if (settled) return@post
            val svc = if (status == BluetoothGatt.GATT_SUCCESS) g.getService(uuid) else null
            val frame = svc?.getCharacteristic(FRAME_CHAR_UUID)
            val ack = svc?.getCharacteristic(ACK_CHAR_UUID)
            val cccd = ack?.getDescriptor(CCCD_UUID)
            if (frame == null || ack == null || cccd == null) {
              fail("session service not found on peer")
              return@post
            }
            frameCharacteristic = frame
            g.setCharacteristicNotification(ack, true)
            Log.d(TAG, "payer: services discovered at ${elapsed()} ms; subscribing to ACK")
            val ok = try {
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE) == BluetoothStatusCodes.SUCCESS
              } else {
                cccd.value = BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                g.writeDescriptor(cccd)
              }
            } catch (e: Exception) {
              false
            }
            if (!ok) fail("could not subscribe to the peer's ACK characteristic")
          }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
          main.post {
            if (settled || descriptor.uuid != CCCD_UUID) return@post
            if (status != BluetoothGatt.GATT_SUCCESS) {
              fail("could not subscribe to the peer's ACK characteristic: status $status")
              return@post
            }
            ready = true
            Log.d(TAG, "payer: subscribed to ACK at ${elapsed()} ms; sending HELLO_A (mtu $mtu)")
            writeMessage(g, BleGattProfile.helloA(psk, instanceName), BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) {}
          }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
          main.post {
            if (settled || characteristic.uuid != FRAME_CHAR_UUID) return@post
            Log.d(TAG, "payer: chunk write confirmed status=$status queued=${writeQueue.size} at ${elapsed()} ms")
            if (status != BluetoothGatt.GATT_SUCCESS) {
              fail("failed to send frame: gatt status $status")
              return@post
            }
            writeNextChunk(g)
          }
        }

        // API 33+ delivers the value directly. Android 13 calls BOTH overloads,
        // so the legacy one bails there to avoid feeding every chunk twice.
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
          if (characteristic.uuid != ACK_CHAR_UUID) return
          val copy = value.copyOf()
          main.post { handleIndication(g, copy) }
        }

        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
          if (characteristic.uuid != ACK_CHAR_UUID) return
          // Copy now: the framework reuses the characteristic's value buffer.
          val copy = characteristic.value?.copyOf() ?: return
          main.post { handleIndication(g, copy) }
        }
      }

      scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          main.post {
            if (settled || gatt != null) return@post
            scanning = false
            try { scanner.stopScan(scanCallback) } catch (e: Exception) { /* adapter off */ }
            Log.d(TAG, "payer: found ${result.device.address} (rssi ${result.rssi}) at ${elapsed()} ms; connecting")
            val g = result.device.connectGatt(ctx, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            gatt = g
            if (g == null) fail("bluetooth unavailable")
          }
        }

        override fun onScanFailed(errorCode: Int) {
          main.post {
            scanning = false
            fail("scan failed: code $errorCode")
          }
        }
      }

      val connect = Runnable {
        if (!ready) fail("connect timeout: no route to peer")
      }
      connectTimer = connect
      main.postDelayed(connect, connectTimeoutMs.toLong())
      val whole = Runnable { fail("timed out waiting for peer") }
      wholeTimer = whole
      main.postDelayed(whole, timeoutMs.toLong())

      // Exact 128-bit match on the session UUID: only the PSK holder that read this QR is advertising it (§2).
      val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(uuid)).build()
      val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
      Log.d(TAG, "payer: scanning for $uuid")
      scanning = true
      try {
        scanner.startScan(listOf(filter), settings, scanCallback)
      } catch (e: Exception) {
        scanning = false
        fail("bluetooth unavailable")
      }
    }
    return promise
  }

  companion object {
    private const val PREPARE_POLL_MS = 100L
  }
}
