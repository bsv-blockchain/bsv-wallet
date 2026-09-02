import { getLocalPayTransport } from 'react-native-localpay-transport'
import { makeSocketTransport } from './socket'

/**
 * Connect-phase budget before the payer gives up and falls back to the QR.
 * AWDL's Bonjour discovery over an already-established Wi-Fi link resolves
 * (or doesn't) inside ~4s; a longer wait only delays the fountain.
 */
export const AWDL_CONNECT_TIMEOUT_MS = 4_000

export const awdlTransport = makeSocketTransport('awdl', getLocalPayTransport, AWDL_CONNECT_TIMEOUT_MS)
