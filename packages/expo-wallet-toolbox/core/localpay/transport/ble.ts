import { Platform } from 'react-native'
import { getLocalPayBleTransport, type LocalPayBleTransport } from '@bsv/react-native-localpay-transport'
import { unsealFrame, sealFrame, type PaymentFrame } from '../codec'
import { instanceName, type Session } from '../session'
import type { Ack, LocalPaymentTransport, ReceivedFrame } from '../types'
import { bleRole } from './select'
import { SEND_TIMEOUT_MS, declineQuietly, fromBase64, makeConfirm, parseAck, toBase64 } from './socket'

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
 * The BLE rung. Unlike the AWDL/Nearby wrapper this one knows two roles (spec
 * 2026-09-03): the payee listens on BOTH the advertised link (startListening)
 * and, on iOS, the scan link (startScanning); the payer advertises instead of
 * connecting when bleRole() says so. Frame decoding, the single-shot confirm
 * handle and the never-stop-on-success discipline are socket.ts's, reused.
 */
export function makeBleTransport(
  native: () => LocalPayBleTransport | null,
  connectTimeoutMs: number
): LocalPaymentTransport {
  return {
    kind: 'ble',

    receive(session: Session, signal: AbortSignal): Promise<ReceivedFrame> {
      const backend = native()
      if (!backend) return Promise.reject(new Error('ble transport unavailable'))
      if (signal.aborted) return Promise.reject(new Error('cancelled'))
      const name = instanceName(session.sessionId)
      const psk = toBase64(session.psk)

      return new Promise<ReceivedFrame>((resolve, reject) => {
        let settled = false
        // Same contract as socket.ts: teardown is FALSE on the success path,
        // because the native side already cancelled the loser and is holding
        // the winner's link open for confirmFrame().
        const finish = (teardown: boolean, fn: () => void) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          if (teardown) void backend.stopListening().catch(() => {})
          fn()
        }
        const onAbort = () => finish(true, () => reject(new Error('cancelled')))
        signal.addEventListener('abort', onAbort)

        // One frame handler for both links: the native latch guarantees only
        // one of them ever fires it.
        const onFrame = (frameBase64: string) => {
          let frame: PaymentFrame
          try {
            frame = unsealFrame(fromBase64(frameBase64), session.psk)
          } catch (e) {
            declineQuietly(backend, 'decode_failed')
            return finish(false, () => reject(e))
          }
          finish(false, () => resolve({ frame, confirm: makeConfirm(backend) }))
        }
        const onError = (message: string) => finish(true, () => reject(new Error(message)))

        backend
          .startListening(name, psk, onFrame, onError)
          .then(() => {
            // Reversed role: only where this device's central is trusted
            // against a peer that advertises. A scan that cannot start leaves
            // the advertised listener serving iOS payers, so it is logged, not
            // terminal. Started AFTER startListening resolves: the native
            // self-reset inside startListening would otherwise tear it down.
            if (Platform.OS !== 'ios' || settled) return
            return backend.startScanning(name, psk, onFrame, onError).catch((e: unknown) => {
              if (settled) return
              console.warn('[localpay] ble scan unavailable:', e instanceof Error ? e.message : String(e))
            })
          })
          .catch(e => finish(true, () => reject(e)))
      })
    },

    send(session: Session, frame: PaymentFrame, signal: AbortSignal): Promise<Ack> {
      const backend = native()
      if (!backend) return Promise.reject(new Error('ble transport unavailable'))
      if (signal.aborted) return Promise.reject(new Error('cancelled'))

      return new Promise<Ack>((resolve, reject) => {
        let settled = false
        const cleanup = () => signal.removeEventListener('abort', onAbort)
        const onAbort = () => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error('cancelled'))
        }
        signal.addEventListener('abort', onAbort)
        // sealFrame can throw (e.g. an oversize frame); computed inside the
        // executor so that throw becomes a rejection of this Promise<Ack>
        // rather than a synchronous throw out of send() (matches socket.ts).
        let args: readonly [string, string, string, number, number]
        try {
          args = [
            instanceName(session.sessionId),
            toBase64(session.psk),
            toBase64(sealFrame(frame, session.psk)),
            SEND_TIMEOUT_MS,
            connectTimeoutMs,
          ] as const
        } catch (e) {
          settled = true
          cleanup()
          reject(e)
          return
        }
        const pending =
          bleRole(session) === 'peripheral' ? backend.sendFrameAdvertising(...args) : backend.sendFrame(...args)
        pending.then(
          ackBase64 => {
            if (settled) return
            settled = true
            cleanup()
            try {
              resolve(parseAck(ackBase64))
            } catch (e) {
              reject(e)
            }
          },
          e => {
            if (settled) return
            settled = true
            cleanup()
            reject(e)
          }
        )
      })
    },
  }
}

/**
 * A separate HybridObject from the AWDL/Nearby one. That is load-bearing for
 * the payee's multi-listener: aborting this rung runs ITS native
 * stopListening(), which can never touch the other radio's held ack
 * connection.
 */
export const bleTransport = makeBleTransport(getLocalPayBleTransport, BLE_CONNECT_TIMEOUT_MS)
