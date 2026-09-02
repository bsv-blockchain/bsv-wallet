import { getLocalPayBleTransport } from 'react-native-localpay-transport'
import { makeSocketTransport } from './socket'

/**
 * Connect-phase budget before the payer gives up and falls back to the QR:
 * scan for the session's service UUID + connect + MTU negotiation (≤ 2 s on
 * Android) + service discovery + ACK subscription. The native central rejects
 * "connect timeout: no route to peer" if that has not completed inside this
 * budget — the string NearbyFlow already treats as radios-off / peer-gone —
 * so the payer drops to the fountain instead of waiting out the 20 s
 * whole-send budget.
 */
export const BLE_CONNECT_TIMEOUT_MS = 6_000

/**
 * A separate HybridObject from the AWDL/Nearby one. That is load-bearing for
 * the payee's multi-listener: aborting this rung runs ITS native
 * stopListening(), which can never touch the other radio's held ack
 * connection.
 */
export const bleTransport = makeSocketTransport('ble', getLocalPayBleTransport, BLE_CONNECT_TIMEOUT_MS)
