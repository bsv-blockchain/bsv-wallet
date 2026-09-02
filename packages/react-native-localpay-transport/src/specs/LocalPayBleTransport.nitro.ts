import type { HybridObject } from 'react-native-nitro-modules'

/**
 * BLE rung of the local-payment transport (GATT profile bsvpay-ble/1, spec
 * docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md §2-§3).
 *
 * The four transport methods have signatures identical to LocalPayTransport so
 * core/localpay/transport/socket.ts drives both HybridObjects through one
 * structural type (`LocalPayNative`). The three probes are prompt-free by
 * contract: reading them at any time never shows the iOS Bluetooth dialog.
 * `prepare()` is the ONE method that may.
 */
export interface LocalPayBleTransport extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /** Hardware present and not denied. Prompt-free. `notDetermined` counts as supported. */
  isSupported(): boolean
  /** 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'. Prompt-free. */
  bluetoothState(): string
  /** NFC reader hardware available and enabled. Prompt-free. */
  nfcAvailable(): boolean
  /**
   * Instantiate the peripheral and central managers and resolve their state.
   * THE ONE CALL THAT MAY SHOW THE iOS BLUETOOTH PROMPT. Resolves the same
   * string as bluetoothState() once the managers settle or timeoutMs elapses.
   */
  prepare(timeoutMs: number): Promise<string>
  startListening(
    instanceName: string,
    pskBase64: string,
    onFrame: (frameBase64: string) => void,
    onError: (message: string) => void
  ): Promise<void>
  stopListening(): Promise<void>
  /**
   * Same contract as LocalPayTransport.confirmFrame (see that spec's doc
   * comment: an ack is a money-safety statement JS makes after its durable
   * write). On BLE the ack additionally carries an HMAC over the wire; the
   * payer's native side verifies and strips it, so JS sees identical bytes.
   */
  confirmFrame(accepted: boolean, reason: string): Promise<void>
  sendFrame(
    instanceName: string,
    pskBase64: string,
    frameBase64: string,
    /** Whole-exchange budget: scan + connect + transfer + the payee's save + ack. */
    timeoutMs: number,
    /**
     * Connect-phase budget (scan, connect, MTU, discovery, subscribe). Rejects
     * with "connect timeout: no route to peer" — the string the JS layer
     * already treats as radios-off/peer-gone so the UI falls to the QR fast.
     */
    connectTimeoutMs: number
  ): Promise<string>
}
