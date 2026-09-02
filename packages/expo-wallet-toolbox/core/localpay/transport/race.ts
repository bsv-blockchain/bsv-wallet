import type { Session } from '../session'
import type { LocalPaymentTransport, ReceivedFrame } from '../types'

export type RadioKind = 'awdl' | 'nearby' | 'ble'

/** The frame that won, and which radio carried it — `savePending` records the kind. */
export interface RaceWinner extends ReceivedFrame {
  kind: RadioKind
}

/**
 * Listen on every radio at once; the first delivered frame wins.
 *
 * Pure over the LocalPaymentTransport interface so the arbitration is testable
 * without a screen. One AbortController per transport; on the first
 * resolution the losers are aborted BEFORE the winner is handed back, so each
 * loser's own native stopListening() runs while the winner's held ack
 * connection — a different HybridObject on a different radio — is untouched
 * (spec §6).
 *
 * A rejection is non-terminal: it is reported through `onError` (so the screen
 * can show "Bluetooth is unavailable" while Wi-Fi keeps listening) and only
 * when EVERY radio has failed does the promise reject, with the last error.
 * Rejections that follow an abort — the losers' 'cancelled', or everything
 * after the outer signal fires — are consequences, not failures, and are not
 * reported.
 *
 * `qr` transports are skipped: the QR rung is driven by the UI, not by
 * receive() (core/localpay/qr.ts).
 */
export function raceReceivers(
  transports: readonly LocalPaymentTransport[],
  session: Session,
  signal: AbortSignal,
  onError: (kind: RadioKind, error: unknown) => void
): Promise<RaceWinner> {
  const radios = transports.filter(t => t.kind !== 'qr')
  if (radios.length === 0) return Promise.reject(new Error('no radio transports to listen on'))
  if (signal.aborted) return Promise.reject(new Error('cancelled'))

  return new Promise<RaceWinner>((resolve, reject) => {
    let settled = false
    let failures = 0
    let lastError: unknown = new Error('every radio listener failed')
    const controllers = radios.map(() => new AbortController())

    const abortAll = (except?: AbortController) => {
      for (const c of controllers) if (c !== except && !c.signal.aborted) c.abort()
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () =>
      finish(() => {
        abortAll()
        reject(new Error('cancelled'))
      })
    signal.addEventListener('abort', onAbort)

    // One radio going down, however it goes down. Shared by the rejection path
    // and by the synchronous-throw path below so the two are indistinguishable.
    const failed = (kind: RadioKind, controller: AbortController, error: unknown) => {
      if (settled || controller.signal.aborted) return
      failures += 1
      lastError = error
      onError(kind, error)
      if (failures === radios.length) finish(() => reject(lastError))
    }

    radios.forEach((transport, i) => {
      const controller = controllers[i]
      const kind = transport.kind as RadioKind

      // receive() may THROW rather than reject — a missing native accessor does
      // exactly that. Unguarded, the throw escapes this executor, rejects the
      // whole race, and leaves the siblings listening with nobody waiting on
      // them: the payee would sit on a dead screen while a working radio held
      // an open listener. Treated as that one radio failing instead, so the
      // others keep the request live.
      let listening: Promise<ReceivedFrame>
      try {
        listening = transport.receive(session, controller.signal)
      } catch (e) {
        failed(kind, controller, e)
        return
      }

      listening.then(
        received => {
          if (settled) {
            // The race was already decided (or aborted) when this frame landed.
            // Nothing will ever be written for it, so it is a provable decline —
            // the payer must release its inputs rather than rest on a green
            // "Sent" until its own timeout.
            void received.confirm(false, 'save_failed')
            return
          }
          finish(() => {
            abortAll(controller)
            resolve({ kind, frame: received.frame, confirm: received.confirm })
          })
        },
        error => failed(kind, controller, error)
      )
    })
  })
}
