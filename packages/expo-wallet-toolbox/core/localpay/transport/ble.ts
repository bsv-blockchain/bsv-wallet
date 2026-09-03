import { getLocalPayBleTransport } from 'react-native-localpay-transport'
import { makeSocketTransport } from './socket'

/**
 * Connect-phase budget before the payer gives up and falls back to the QR:
 * scan for the session's service UUID + connect + MTU negotiation (≤ 2 s on
 * Android) + service discovery + ACK subscription. The native central rejects
 * "connect timeout: no route to peer" if that has not completed inside this
 * budget — the string NearbyFlow already treats as radios-off / peer-gone —
 * so the payer drops to the fountain instead of waiting out the whole-send
 * budget (SEND_TIMEOUT_MS in socket.ts).
 *
 * 6 s was too tight against a real device: a captured Android(central)↔iOS
 * (peripheral) failure showed the LE link physically connect, then iOS's
 * radio hit a PHY-update collision (HCI status 0x2A "Instant Passed") that
 * held up service discovery past the old budget — Android's own MTU request
 * got no answer within 2 s either. Widened to give a slow link-layer
 * renegotiation room to finish before conceding to the fountain.
 */
export const BLE_CONNECT_TIMEOUT_MS = 15_000

/**
 * A separate HybridObject from the AWDL/Nearby one. That is load-bearing for
 * the payee's multi-listener: aborting this rung runs ITS native
 * stopListening(), which can never touch the other radio's held ack
 * connection.
 */
export const bleTransport = makeSocketTransport('ble', getLocalPayBleTransport, BLE_CONNECT_TIMEOUT_MS)
