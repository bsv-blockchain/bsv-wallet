/**
 * The nearby rail's PAYER half of the token runtime (plan 07 Task 15).
 *
 * The color module funds and signs the hand-over inside lib `sendHandover`,
 * which also builds the envelope from the host wallet's custody and records
 * the hand-over `pending` in the host ledger (B7); localpay only frames its
 * v4 body. What lives here is the wallet's own record of it, the kept body
 * and `color_transfers` (W1), which the broadcast hold and the abort refusal
 * both read.
 *
 * `handover`, in this order (stability mandate):
 *  1. Refuse what the request alone decides (amount domain, recipient).
 *  2. `sendHandover` with the SESSION's own remittance strings (a contract
 *     extension of IC §8.1: both or neither, ≤ 48 bytes, used verbatim), so
 *     the payee's output is derived from the nonces the payee minted.
 *  3. Check the result is bound to that request: the receipt carries the
 *     same asset and strings, and the payee output is index 0 (the frame
 *     names it). Anything else is released, never journaled.
 *  4. Keep the v4 body (a handle-rail resend of this payment needs it), then
 *     journal `built`, rail `nearby`, with the receipt custody. Nobody has
 *     the bytes yet, so a body or journal fault (or a txid already journaled
 *     for another transfer) is answered by releasing the action, never by
 *     returning bytes the journal does not know.
 *
 * `onHandedOver` moves the row forward only: built → parked → handed_over.
 * A repeat, or a request for a state the row is already past, succeeds
 * without writing, because the handle rail's resend also hands a parked row
 * over and the payer's own release then confirms it. A cancelled, refused or
 * missing row is a failure: `payerHold` reads a failure as "not journaled"
 * and keeps the queue row parked.
 */
import type { WalletInterface } from '@bsv/sdk'
import { MAX_UINT64, sendHandover, type HandoverResult, type HostLedger } from '@bsv/mandala'
import { devLog } from '../logging'
import { releaseUnseenHandover, type HandoverBodies } from './handle'
import type { NearbyTokenDeps } from './runtime'
import type { TransferJournal } from './transferJournal'
import type { ColorTransferState } from './types'

export interface NearbyPayerDeps {
  /** The PUBLISHED manager, bound to the admin originator. */
  wallet: WalletInterface
  identityKey: () => Promise<string>
  journal: TransferJournal
  /** The host's UNDERLYING wallet (the envelope is built from its custody). */
  hostWallet: WalletInterface
  /** The host ledger shared with the issuer-v1 handler. */
  ledger: HostLedger
  /** Where the v4 body is kept for a later resend. */
  bodies: HandoverBodies
  /** Plain reason a recipient cannot receive tokens, or null. */
  recipientRefusal: (recipient: string) => string | null
  /** Journal state changed. */
  onChange?: () => void
}

export type NearbyPayer = Pick<NearbyTokenDeps, 'handover' | 'onHandedOver'>

/** States each `onHandedOver` target may be reached from. */
const ADVANCE_FROM: Record<'parked' | 'handed_over', readonly ColorTransferState[]> = {
  parked: ['built'],
  handed_over: ['built', 'parked']
}
/** States that already satisfy each target: the row is there or further on. */
const ALREADY_AT: Record<'parked' | 'handed_over', readonly ColorTransferState[]> = {
  parked: ['parked', 'handed_over', 'settled'],
  handed_over: ['handed_over', 'settled']
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Why `h` is not the hand-over this request asked for, or null when it is.
 * Shared by the runtime (before journaling) and the frame builder (before
 * framing), so the two can never disagree about what "bound" means.
 */
export function handoverMismatch(
  h: Pick<HandoverResult, 'outputIndex' | 'receipt'>,
  want: { assetId: string; derivationPrefix: string; derivationSuffix: string }
): string | null {
  if (h.outputIndex !== 0) return `the hand-over pays output ${String(h.outputIndex)}, not output 0`
  if (h.receipt?.assetId !== want.assetId) return 'the hand-over is for another asset'
  if (h.receipt.derivationPrefix !== want.derivationPrefix || h.receipt.derivationSuffix !== want.derivationSuffix) {
    return 'the hand-over does not carry this session’s remittance'
  }
  return null
}

export function createNearbyPayer(d: NearbyPayerDeps): NearbyPayer {
  const notify = (): void => {
    try {
      d.onChange?.()
    } catch (e) {
      devLog('[mandala] nearby: a change listener threw:', e)
    }
  }

  const handover: NearbyPayer['handover'] = async a => {
    const units = a.units
    if (typeof units !== 'bigint' || units < 1n || units > MAX_UINT64) {
      throw new Error('A token amount must be a whole number from 1 to 18446744073709551615 base units')
    }
    const refusal = d.recipientRefusal(a.recipientKey)
    if (refusal !== null) throw new Error(refusal)
    const recipientKey = a.recipientKey.trim().toLowerCase()
    const note = a.note !== undefined && a.note.trim() !== '' ? a.note.trim() : undefined
    const identityKey = await d.identityKey()

    // A lib throw is passed through untouched: its `.name` is the refusal
    // class the screen maps (IC D22), and nothing was signed.
    const h = await sendHandover({
      wallet: d.wallet,
      identityKey,
      assetId: a.assetId,
      amount: units,
      recipientKey,
      derivationPrefix: a.derivationPrefix,
      derivationSuffix: a.derivationSuffix,
      ...(note !== undefined ? { note } : {}),
      hostWallet: d.hostWallet,
      ledger: d.ledger,
      // The journal row below, the kept body and the host ledger own
      // durability; see the handle rail's `sendToHandle` for why the lib's
      // txJournal stays off.
      journal: false
    })

    // Signed. From here every exit either journals it or releases it.
    const mismatch = handoverMismatch(h, a)
    if (mismatch !== null) {
      await releaseUnseenHandover(d, h)
      throw new Error(mismatch)
    }
    try {
      await d.bodies.put(h.txid, h.body)
      const wrote = await d.journal.insert({
        txid: h.txid,
        role: 'sent',
        state: 'built',
        delivered: false,
        reference: h.reference,
        rail: 'nearby',
        units,
        counterpartyKey: recipientKey,
        outputIndex: h.outputIndex,
        assetId: a.assetId,
        ...(note !== undefined ? { note } : {}),
        derivationPrefix: h.receipt.derivationPrefix,
        derivationSuffix: h.receipt.derivationSuffix,
        senderIdentityKey: h.receipt.senderIdentityKey
      })
      if (!wrote) {
        const existing = await d.journal.get(h.txid)
        if (existing?.role !== 'sent' || existing.reference !== h.reference) {
          throw new Error(`color_transfers already holds ${h.txid} for another transfer`)
        }
      }
    } catch (e) {
      devLog(`[mandala] nearby: journaling the hand-over ${h.txid} failed; releasing it unframed:`, messageOf(e))
      await releaseUnseenHandover(d, h)
      throw e
    }
    notify()
    return h
  }

  const onHandedOver: NearbyPayer['onHandedOver'] = async (txid, to) => {
    const patch = to === 'handed_over' ? { delivered: true } : undefined
    if (await d.journal.advance(txid, ADVANCE_FROM[to], to, patch)) {
      notify()
      return
    }
    const row = await d.journal.get(txid)
    if (row?.role !== 'sent') throw new Error(`color_transfers has no sent row for ${txid}`)
    if (!ALREADY_AT[to].includes(row.state)) {
      throw new Error(`the hand-over ${txid} is ${row.state}; it cannot be marked ${to}`)
    }
    if (to === 'handed_over' && row.state === 'handed_over' && !row.delivered) {
      await d.journal.setDelivered(txid, true)
      notify()
    }
  }

  return { handover, onHandedOver }
}
