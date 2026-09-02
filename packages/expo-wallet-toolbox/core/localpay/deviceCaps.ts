/**
 * What THIS device can do right now, as the hint bits the payee's session QR
 * carries above the rung byte (session.ts HINT_*). The payer's ladder never
 * reads these; they drive one line of copy on the payer's confirm screen
 * (describeFloor) and are available to future rungs.
 *
 * A clear bit means "false OR unknown". Only the one asynchronous probe —
 * internet reachability — gets a companion KNOWN bit, because it is the one
 * that routinely cannot answer inside a minting budget.
 *
 * This file deliberately does NOT use getOnline() from core/net/online.ts.
 * That helper collapses a `null` (not yet probed) NetInfo answer to "online",
 * which is right for the home-screen banner — a wrong "offline" there hides
 * the online rails from someone with signal — and wrong for a flag another
 * device will act on. Here `null` must stay `null` so the QR says "unknown"
 * (HINT_ONLINE_KNOWN clear) rather than asserting a reachability nobody
 * established.
 */
import { Platform } from 'react-native'
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo'
import { getLocalPayBleTransport } from 'react-native-localpay-transport'
import {
  HINT_BT,
  HINT_NET,
  HINT_NFC,
  HINT_ONLINE,
  HINT_ONLINE_KNOWN,
  HINT_WIFI,
  RUNG_MASK,
} from './session'

/** Mirrors LocalPayBleTransport.bluetoothState(); anything else coerces to 'unknown'. */
export type BluetoothState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'

export interface DeviceProbe {
  /** NetInfo isInternetReachable; null when unknown, including "did not answer in budget". */
  online: boolean | null
  /** NetInfo isConnected; null when unknown. */
  connected: boolean | null
  /**
   * Android: the Wi-Fi radio is on (isWifiEnabled). iOS has no radio-power
   * API, so this is "associated with a Wi-Fi network" (type === 'wifi').
   */
  wifi: boolean
  bluetooth: BluetoothState
  /** NFC reader hardware available. Advisory only — NFC is not a transport. */
  nfc: boolean
}

/** How long minting waits for NetInfo before writing "unknown" into the QR. */
export const DEFAULT_NET_BUDGET_MS = 800

/** How long minting waits for the BLE managers to settle (LocalPayBleTransport.prepare). */
export const BLE_PREPARE_TIMEOUT_MS = 1500

const BLUETOOTH_STATES: readonly BluetoothState[] = [
  'poweredOn',
  'poweredOff',
  'unauthorized',
  'unsupported',
  'unknown',
]

/**
 * Native reports Bluetooth as a plain string over Nitro. Anything outside the
 * five documented values — a future CoreBluetooth case, a bridge hiccup —
 * becomes 'unknown', which every caller already treats as "do not advertise".
 * Shared by readBluetoothState() below and prepareBle() (added in Task 10).
 */
function asBluetoothState(raw: unknown): BluetoothState {
  return typeof raw === 'string' && (BLUETOOTH_STATES as readonly string[]).includes(raw)
    ? (raw as BluetoothState)
    : 'unknown'
}

/**
 * Pure. Hint bits only: the rung byte belongs to mintSession, which ORs the
 * rungs it is actually listening on with `hints & ~RUNG_MASK`. Masking here
 * too keeps the invariant local, so a future hint constant that strays into
 * the low byte cannot make a payer believe a radio is listening.
 */
export function capsFromProbe(p: DeviceProbe): number {
  let caps = 0
  if (p.online === true) caps |= HINT_ONLINE
  if (p.online !== null) caps |= HINT_ONLINE_KNOWN
  if (p.connected === true) caps |= HINT_NET
  if (p.wifi) caps |= HINT_WIFI
  if (p.bluetooth === 'poweredOn') caps |= HINT_BT
  if (p.nfc) caps |= HINT_NFC
  return caps & ~RUNG_MASK
}

/**
 * Race NetInfo against the budget. A timeout or a rejection both yield null:
 * "we do not know" is the honest answer to write into the QR, and the caller
 * must not be able to tell the two apart, or it would be tempted to guess.
 * The timer is always cleared so a fast answer leaves nothing pending.
 */
async function fetchNetWithinBudget(budgetMs: number): Promise<NetInfoState | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), budgetMs)
  })
  const answer = Promise.resolve()
    .then(() => NetInfo.fetch())
    .catch(() => null)
  try {
    return await Promise.race([answer, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The prompt-free Bluetooth answer, right now. Sync, never throws. The payee's
 * probe reads it for HINT_BT; the payer reads it on scanning a session so
 * describeFloor can say "your Bluetooth is off" without ever raising the iOS
 * privacy prompt for someone who is about to pay by code anyway (spec §7).
 * 'unsupported' when there is no BLE HybridObject at all (web, jest, a build
 * without the native lib).
 */
export function readBluetoothState(): BluetoothState {
  try {
    const ble = getLocalPayBleTransport()
    return ble ? asBluetoothState(ble.bluetoothState()) : 'unsupported'
  } catch {
    return 'unknown'
  }
}

function readNfcAvailable(): boolean {
  try {
    return getLocalPayBleTransport()?.nfcAvailable() === true
  } catch {
    return false
  }
}

/**
 * Prompt-free. bluetoothState() and nfcAvailable() are sync class-property /
 * adapter reads on both platforms (spec §"Verified facts"); the one call that
 * may show the iOS Bluetooth prompt is prepare(), which NearbyFlow issues
 * separately (prepareBle, Task 10) and only when the user has asked to
 * receive a nearby payment.
 */
export async function probeDeviceCaps(opts?: { netBudgetMs?: number }): Promise<DeviceProbe> {
  const net = await fetchNetWithinBudget(opts?.netBudgetMs ?? DEFAULT_NET_BUDGET_MS)
  const wifi =
    net !== null &&
    (Platform.OS === 'android' ? net.isWifiEnabled === true : net.type === 'wifi')
  return {
    online: net === null ? null : net.isInternetReachable,
    connected: net === null ? null : net.isConnected,
    wifi,
    bluetooth: readBluetoothState(),
    nfc: readNfcAvailable(),
  }
}
