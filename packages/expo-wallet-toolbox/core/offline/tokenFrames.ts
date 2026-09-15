/**
 * Turning the frames this device already holds durably into drain sources.
 *
 * This is the supply side of FIX G and FIX I. `processOfflineActions` calls
 * `token.frames()` at the start of every pass and hands the result to
 * `reconcileSettlements`, which re-derives the evidence cache and any missing
 * `token_settlements` row. The two durable stores have very different shapes,
 * so each gets its own reader:
 *
 *  · `localpay_pending` (receiver) holds the frame ALREADY DECODED, so nothing
 *    is needed but the queue entries.
 *  · `offline_actions.framePayload` (payer) holds the SEALED `bsvpayf1:` QR
 *    string. Opening it needs the session pre-shared key, which the drain does
 *    not hold and should not — so the decoder is injected by whoever still has
 *    the session, and a row that cannot be opened is simply skipped. The payer
 *    losing its own settlement row is survivable in a way the recipient's is
 *    not: the recipient submits (rule 3), and the payer's optional submit
 *    (rule 6) is a race it is always safe to lose.
 *
 * **Deliberately NOT filtered by `MAX_PENDING_ATTEMPTS` (FIX I).** That ceiling
 * governs `localpay_pending`'s own BSV-shaped internalize retry loop and burns
 * an attempt on any failure, including a transient
 * `Block header not found for height N` from a fresh-block BUMP this device has
 * not caught up on. A token payment's state of record is `token_settlements`,
 * not the pending queue — so an exhausted queue entry still contributes its
 * frame here, the settlement row stays alive, and the row is abandoned only by
 * an explicit `refused`/`orphaned` verdict from the overlay.
 */
import { Beef } from '@bsv/sdk'
import type { EvidenceFrame, TokenFrameSource } from '../mandala/drain'
import type { OfflineActionRow } from '../storage/methods/offlineActions'
import { frameBytesFromQr, unsealFrame } from '../localpay/codec'

/** Structurally satisfied by `localpay/pending`'s `PendingPayment`. */
export interface PendingLike {
  frame: EvidenceFrame
  status?: string
}

/**
 * The subject txid of an AtomicBEEF — the same txid `internalizeAction` used
 * internally, and therefore the one a `token_settlements` row is keyed by.
 */
export function frameTxid(frame: EvidenceFrame): string | undefined {
  try {
    return Beef.fromBinary(frame.transaction).atomicTxid
  } catch {
    return undefined
  }
}

/**
 * Receiver-side sources. Every non-completed entry with a token block, whether
 * or not the pending queue has given up on it.
 */
export function tokenFrameSourcesFromPending(entries: readonly PendingLike[]): TokenFrameSource[] {
  const sources: TokenFrameSource[] = []
  for (const entry of entries) {
    if (!entry.frame?.token) continue
    const txid = frameTxid(entry.frame)
    if (!txid) continue
    sources.push({ txid, role: 'received', frame: entry.frame })
  }
  return sources
}

/**
 * Payer-side sources, for the rows whose sealed `framePayload` the caller can
 * open. A row this device cannot decode contributes nothing rather than
 * throwing: the drain must reach every other row in the same pass.
 */
export function tokenFrameSourcesFromOfflineActions(
  rows: readonly OfflineActionRow[],
  decode: (framePayload: string) => EvidenceFrame | undefined
): TokenFrameSource[] {
  const sources: TokenFrameSource[] = []
  for (const row of rows) {
    if (!row.framePayload) continue
    let frame: EvidenceFrame | undefined
    try {
      frame = decode(row.framePayload)
    } catch {
      continue
    }
    if (!frame?.token) continue
    sources.push({
      txid: row.txid,
      role: row.role,
      frame,
      // A parked row must keep its own state: it is the user's, not the
      // drain's, and reconciliation may not promote it to a submittable one.
      state: row.status === 'parked' ? 'parked' : undefined
    })
  }
  return sources
}

// ───────────────────── the payer's sealed-frame decoder ─────────────────────
//
// `offline_actions.framePayload` is the `bsvpayf1:` envelope around a frame
// SEALED with the nearby session's pre-shared key. The drain holds no session
// and should not: the PSK is a hand-over secret, not durable wallet state. So
// the keys of the sessions this process has actually taken part in are kept
// here, in memory only, and the decoder tries each of them.
//
// What "in memory only" costs is bounded and known: a payer that restarts
// before its own optional submit (rule 6) loses the ability to re-derive its
// `token_settlements` row from the frame. That is the race it is always safe
// to lose — the RECIPIENT submits (rule 3), and the payer's submit only makes
// its own change spendable sooner. What it buys is that a durable copy of the
// key that opens every stored frame is never written to disk.

/** How many session keys are remembered. Well past any plausible number of live hand-overs. */
export const MAX_REMEMBERED_SESSION_KEYS = 32

const sessionKeys: Uint8Array[] = []

/**
 * Remember a nearby session's PSK for this process.
 *
 * Called by whoever mints or scans a session (the nearby flow), not by the
 * drain. Idempotent per key, and bounded: the oldest key is dropped once the
 * ring is full, which is correct because a hand-over's frame is reconciled on
 * the very next online tick.
 */
export function rememberSessionPsk(psk: Uint8Array): void {
  if (!(psk instanceof Uint8Array) || psk.length !== 32) return
  const already = sessionKeys.some(known => known.length === psk.length && known.every((b, i) => b === psk[i]))
  if (already) return
  sessionKeys.push(new Uint8Array(psk))
  while (sessionKeys.length > MAX_REMEMBERED_SESSION_KEYS) sessionKeys.shift()
}

/** Drop every remembered key. Logout, network switch, and the tests. */
export function forgetSessionPsks(): void {
  sessionKeys.length = 0
}

/**
 * A decoder for `tokenFrameSourcesFromOfflineActions`.
 *
 * Tries each remembered session key in turn and returns the first frame that
 * opens. Undefined — never a throw — for a truncated row, a foreign string, or
 * a frame from a session this process no longer holds the key for: the drain
 * must reach every other row in the same pass.
 */
export function sealedFramePayloadDecoder(
  keys: () => readonly Uint8Array[] = () => sessionKeys
): (framePayload: string) => EvidenceFrame | undefined {
  return framePayload => {
    let bytes: Uint8Array
    try {
      bytes = frameBytesFromQr(framePayload)
    } catch {
      return undefined
    }
    for (const psk of keys()) {
      try {
        return unsealFrame(bytes, psk)
      } catch {
        // Wrong key for this frame (a GCM tag mismatch). Try the next.
      }
    }
    return undefined
  }
}
