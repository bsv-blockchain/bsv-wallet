import { getLocalPayTransport } from 'react-native-localpay-transport'
import { makeSocketTransport } from './socket'

/**
 * Connect-phase budget before the payer gives up and falls back to the QR.
 * Nearby has to do BLE discovery and then a Wi-Fi/hotspot upgrade before a
 * connection even exists — AWDL's 4s would false-positive "no route to peer"
 * on a link that just needed more time to come up.
 */
export const NEARBY_CONNECT_TIMEOUT_MS = 10_000

export const nearbyTransport = makeSocketTransport('nearby', getLocalPayTransport, NEARBY_CONNECT_TIMEOUT_MS)
