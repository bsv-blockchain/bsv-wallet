import { Platform } from 'react-native'
import { getLocalPayBleTransport, getLocalPayTransport } from 'react-native-localpay-transport'
import { CAP_AWDL, CAP_BLE, CAP_NEARBY, HINT_BT, RUNG_MASK, type Session } from '../session'
import type { BluetoothState } from '../deviceCaps'

export type TransportKind = 'awdl' | 'nearby' | 'ble' | 'qr'

/** True when this device can act as an AWDL peer. */
export function localSupportsAwdl(): boolean {
  if (Platform.OS !== 'ios') return false
  try {
    return getLocalPayTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

/**
 * True when this device can act as a Nearby Connections peer. The same native
 * surface as AWDL, from the Kotlin backend: isSupported() there means Google
 * Play services is present. Runtime permissions are requested at flow entry,
 * not here — a denial degrades the mint/ladder to QR at that point.
 */
export function localSupportsNearby(): boolean {
  if (Platform.OS !== 'android') return false
  try {
    return getLocalPayTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

/**
 * True when this device can act as a BLE peer. No Platform.OS gate: BLE is the
 * one radio that exists on both platforms, which is the whole reason it is on
 * the ladder (spec §5). Prompt-free — the native isSupported() reads hardware
 * presence plus CBManager.authorization / BluetoothAdapter without creating a
 * manager, and `notDetermined` counts as supported so the ladder can pick BLE
 * and let the iOS prompt appear inside sendFrame()/prepare() (spec §7).
 * denied/restricted report unsupported and floor the pair to QR, and so does a
 * radio the native side already knows is powered off (Android always, via
 * BluetoothAdapter.isEnabled; iOS once a manager has existed in this process)
 * — that is what makes describeFloor's local_bt_off row reachable.
 */
export function localSupportsBle(): boolean {
  try {
    return getLocalPayBleTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

/**
 * The rung both sides can climb to. Caps say what the PEER advertised at mint
 * time; the local check says what THIS device can do. Same-OS pairs keep the
 * higher-throughput radio they have today; cross-OS pairs land on BLE because
 * the peer's AWDL/Nearby bits can never match local ability. `session.os` is
 * metadata and is deliberately not read here (see Session.os). QR is the
 * floor every pair can reach — and the automatic fallback when a chosen radio
 * fails at send time (see NearbyFlow's executeSend).
 */
export function selectTransport(session: Session): TransportKind {
  if ((session.caps & CAP_AWDL) !== 0 && localSupportsAwdl()) return 'awdl'
  if ((session.caps & CAP_NEARBY) !== 0 && localSupportsNearby()) return 'nearby'
  if ((session.caps & CAP_BLE) !== 0 && localSupportsBle()) return 'ble'
  return 'qr'
}

/**
 * Why a payer is on the QR fountain. 'none' when a radio was selected, or
 * when nothing in the table applies.
 */
export type FloorReason =
  | 'none'
  /** The peer is not listening on any radio rung at all. */
  | 'peer_no_radio'
  /** The peer has no BLE rung and its Bluetooth is off (or unknown). */
  | 'peer_bt_off'
  /** The peer advertises BLE but this app's Bluetooth permission is denied. */
  | 'local_ble_denied'
  /** The peer advertises BLE but this device's Bluetooth radio is off. */
  | 'local_bt_off'
  /** Other OS, peer Bluetooth on, but the peer's app could not advertise BLE. */
  | 'cross_os_no_ble'

/**
 * The one line of copy the payer's confirm screen shows when the pair is on
 * the fountain floor (spec §5). Pure: reads the caps the peer minted into the
 * QR (rung bits + hint bits) and what the caller already knows about this
 * device. Evaluated only when selectTransport() returned 'qr'; every other
 * outcome is 'none' so the copy never contradicts a live radio.
 *
 * Order matters: the local_* rows fire before the peer rows because a peer
 * that advertised BLE has done its part — the fix is on this side. session.os
 * is read here (it is copy, exactly what Session.os is for) but never for
 * dispatch.
 */
export function describeFloor(
  session: Session,
  local: { os: 'ios' | 'android'; bluetooth: BluetoothState }
): FloorReason {
  if (selectTransport(session) !== 'qr') return 'none'
  const caps = session.caps
  if ((caps & RUNG_MASK) === 0) return 'peer_no_radio'
  const peerBle = (caps & CAP_BLE) !== 0
  const peerBtOn = (caps & HINT_BT) !== 0
  if (peerBle && local.bluetooth === 'unauthorized') return 'local_ble_denied'
  if (peerBle && local.bluetooth === 'poweredOff') return 'local_bt_off'
  if (!peerBle && session.os !== undefined && session.os !== local.os && peerBtOn) return 'cross_os_no_ble'
  if (!peerBle && !peerBtOn) return 'peer_bt_off'
  return 'none'
}
