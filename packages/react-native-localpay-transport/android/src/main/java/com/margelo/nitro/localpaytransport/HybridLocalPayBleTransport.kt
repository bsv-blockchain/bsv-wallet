package com.margelo.nitro.localpaytransport

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.util.Log
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise

/**
 * BLE rung of the local-payment transport: the second HybridObject in this
 * module, registered beside HybridLocalPayTransport by the regenerated
 * LocalPayTransportOnLoad.cpp (spec 2026-09-02 §1).
 *
 * TASK 1 STUB. Only the three prompt-free probes are real. Every transport
 * method rejects with "bluetooth unavailable", which the JS socket wrapper
 * treats as a radio failure, so any caller that reaches it floors to QR
 * exactly as today. Task 9 replaces this file with the BluetoothGattServer /
 * BluetoothGatt state machines and adds BleGattProfile.kt.
 *
 * Log with `adb logcat -s LocalPayBle` to see every line from this class.
 */
@Suppress("UNUSED_PARAMETER")
class HybridLocalPayBleTransport : HybridLocalPayBleTransportSpec() {
  private companion object {
    const val LOG_TAG = "LocalPayBle"
    const val UNAVAILABLE = "bluetooth unavailable"
  }

  private fun context(): Context? = NitroModules.applicationContext

  private fun adapter(): BluetoothAdapter? {
    val ctx = context() ?: return null
    val manager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    return manager?.adapter
  }

  // ── prompt-free probes (real) ──

  /**
   * BLE hardware present AND the radio switched on. isEnabled is prompt-free,
   * and a payer whose radio is off must floor to QR (describeFloor's
   * local_bt_off) rather than attempt a connect that cannot succeed. Task 9
   * keeps exactly this semantics.
   */
  override fun isSupported(): Boolean {
    val ctx = context() ?: return false
    val a = adapter() ?: return false
    return ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) && a.isEnabled
  }

  /**
   * 'unsupported' without an adapter; otherwise the radio's power state.
   * Android has no per-app Bluetooth authorization, so 'unauthorized' is
   * never returned here: a missing runtime permission surfaces later, from
   * requestBlePermissions() in JS (spec §7), not from this probe.
   */
  override fun bluetoothState(): String {
    val adapter = adapter() ?: return "unsupported"
    return if (adapter.isEnabled) "poweredOn" else "poweredOff"
  }

  /** NFC reader present and switched on (HINT_NFC, spec §4). */
  override fun nfcAvailable(): Boolean {
    val ctx = context() ?: return false
    return NfcAdapter.getDefaultAdapter(ctx)?.isEnabled == true
  }

  // ── transport (inert until Task 9) ──

  private fun <T> unavailable(method: String): Promise<T> {
    Log.d(LOG_TAG, "$method: Task 1 stub, rejecting \"$UNAVAILABLE\"")
    return Promise<T>().apply { reject(Error(UNAVAILABLE)) }
  }

  override fun prepare(timeoutMs: Double): Promise<String> = unavailable("prepare")

  override fun startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: (String) -> Unit,
    onError: (String) -> Unit
  ): Promise<Unit> = unavailable("startListening")

  override fun stopListening(): Promise<Unit> = unavailable("stopListening")

  override fun confirmFrame(accepted: Boolean, reason: String): Promise<Unit> = unavailable("confirmFrame")

  override fun sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> = unavailable("sendFrame")
}
