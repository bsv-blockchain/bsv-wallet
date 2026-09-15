/**
 * The AdmissionBundle: the evidence a token payment carries with it.
 *
 * Offline settlement turns on one question the recipient must answer with no
 * network: *is every token ancestor of this transaction either already
 * admitted by the issuer's overlay, or present in bytes I can walk further?*
 * The bundle is what makes that question answerable — σ_I signatures for the
 * ancestors that bottom out, linkage payloads for the ones that do not (so
 * whoever reconnects first can submit them), and the tip's own AtomicBEEF for
 * everything in between.
 *
 * Two halves live here, and they are deliberately separate:
 *
 *  · `assembleBundle` — the PAYER's side. Walks the transaction it just built
 *    and collects, from this device's own settlement tables, the evidence the
 *    recipient will need. Storage-facing, async, and best-effort: it never
 *    decides whether the result is sufficient.
 *
 *  · `coverFromFrame` — the PAYEE's side. Rebuilds an in-memory bundle from a
 *    decoded frame and hands it to an injected pure verifier. The verdict is
 *    the verifier's, never this module's.
 *
 * The COVER walk itself (spec §1.2) is pure and belongs in `@bsv/mandala`,
 * where the overlay's own σ_I digest lives beside it — one implementation, one
 * set of test vectors, no chance of the wallet and the overlay disagreeing
 * about what a signature covers. This package does not depend on it yet, so
 * the verifier is INJECTED and its types are declared here to match
 * `CoverResult` in `./types`. When the dependency lands, the injection site
 * becomes a one-line import and nothing else here changes.
 */
import { Beef, Transaction } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import type { PaymentFrame } from '../localpay/codec'
import type { AdmissionEntryWire, CoverResult, SettlementStore } from './types'

export { MANDALA_BASKET } from './types'

/**
 * The read side of the settlement store this walk needs.
 *
 * Narrowed from `SettlementStore` on purpose: the walk reads cached evidence
 * and writes nothing, and a builder holding the full store could advance a
 * settlement row halfway through assembling a frame.
 */
export type BundleStore = Pick<SettlementStore, 'getAdmission' | 'getLinkage'>

/** The evidence a payer collected for one tip, ready to go onto the wire. */
export interface AdmissionBundle {
  tipTxid: string
  assetId: string
  overlayIdentityKey: string
  /** Frontier ancestors: unadmitted, so somebody must still submit them. */
  linkage: Array<{ txid: string; payload: Uint8Array }>
  /** Bottoms: ancestors this device holds the overlay's own σ_I for. */
  admissions: AdmissionEntryWire[]
}

/** The tip the verifier is asked about. */
export interface CoverTip {
  txid: string
  tx: Transaction
}

/**
 * Everything the pure COVER walk reads, as maps — the in-memory shape of
 * §1.1's AdmissionBundle. Mirrors `@bsv/mandala`'s own input type; declared
 * locally only until this package depends on it.
 */
export interface CoverBundle {
  assetId: string
  overlayIdentityKey: string
  /** Every transaction carried in the tip's AtomicBEEF, keyed by txid. */
  beef: Map<string, Transaction>
  linkage: Map<string, Uint8Array>
  admissions: Map<string, AdmissionEntryWire>
}

/** The injected pure verifier: `cover(tip, bundle)` (spec §1.2). */
export type CoverVerifier = (tip: CoverTip, bundle: CoverBundle) => CoverResult | Promise<CoverResult>

/**
 * The token inputs of `tx` for `assetId` — FIX K.
 *
 * Only inputs whose SOURCE OUTPUT decodes as a MandalaToken of this asset
 * count. A fresh unconfirmed BSV output funding the fee is not a token
 * ancestor: the payer's own change routinely funds the next offline payment
 * (`allocateChangeInput` accepts `unproven`), and a walk that treated it as an
 * ancestor with no σ_I would refuse the single most ordinary case there is.
 * It is an ordinary broadcast-only parent, handled by the release engine.
 *
 * Returns the parent transactions, deduplicated by txid — a transaction with
 * two inputs from the same parent is one ancestor, not two.
 */
export function tokenParentsOf(tx: Transaction, assetId: string): Transaction[] {
  const seen = new Set<string>()
  const parents: Transaction[] = []
  for (const input of tx.inputs) {
    const source = input.sourceTransaction
    if (!source) continue // txid-only ancestor: a hole for COVER, nothing to walk here
    const output = source.outputs[input.sourceOutputIndex]
    if (!output?.lockingScript) continue
    let decoded: { assetId: string }
    try {
      decoded = MandalaToken.decode(output.lockingScript)
    } catch {
      continue // not a token script — a fee parent, per FIX K
    }
    if (decoded.assetId !== assetId) continue // another issuer's coin riding along
    const txid = source.id('hex')
    if (seen.has(txid)) continue
    seen.add(txid)
    parents.push(source)
  }
  return parents
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : ''
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0
  return out
}

/**
 * Collects the evidence for `tipTx`'s token ancestry (spec §1.1).
 *
 * One decision per ancestor, and it is the whole algorithm:
 *
 *  · a cached admission signed by THIS session's overlay is a BOTTOM — emit an
 *    admissions entry and stop. The recipient can verify it offline and will
 *    never need to submit that transaction, so forwarding its linkage would be
 *    dead weight on the wire.
 *  · anything else is a FRONTIER — emit the stored linkage payload if this
 *    device holds one, then walk that ancestor's OWN token inputs. Forwarding
 *    linkage verbatim hop by hop is what lets whoever reconnects first settle
 *    a whole chain of offline hands.
 *
 * An admission signed by any other key is treated as ABSENT, not as a
 * refusal (FIX H): it is not evidence for this overlay, and the ancestor is
 * walked exactly as if the cache had been empty.
 *
 * A frontier this device holds no linkage for still emits nothing and is still
 * walked. That is not a silent failure — the recipient's own COVER decides
 * whether what arrived is sufficient, and inventing a payload here would put a
 * guess where the overlay expects exact bytes.
 *
 * The tip's own linkage is NOT collected: the payer mints it as part of
 * building the transfer and adds it at the call site, because only the builder
 * knows which outputs it just created.
 */
export async function assembleBundle(args: {
  tipTx: Transaction
  assetId: string
  overlayIdentityKey: string
  store: BundleStore
}): Promise<AdmissionBundle> {
  const { tipTx, assetId, overlayIdentityKey, store } = args
  const linkage: Array<{ txid: string; payload: Uint8Array }> = []
  const admissions: AdmissionEntryWire[] = []
  const visited = new Set<string>()

  // Iterative, not recursive: a hostile or merely deep BEEF must not be able to
  // blow the JS stack on a device. Termination is structural — a txid is the
  // hash of its own bytes, so the spend graph is acyclic — and `visited` bounds
  // the work at one expansion per distinct transaction regardless.
  const queue: Transaction[] = [tipTx]
  while (queue.length > 0) {
    const tx = queue.shift() as Transaction
    for (const parent of tokenParentsOf(tx, assetId)) {
      const txid = parent.id('hex')
      if (visited.has(txid)) continue
      visited.add(txid)

      const cached = await store.getAdmission(txid)
      if (cached && cached.signerKey === overlayIdentityKey) {
        admissions.push({
          txid,
          outputsToAdmit: [...cached.outputsToAdmit],
          signature: hexToBytes(cached.signatureHex),
          signerKey: cached.signerKey
        })
        continue
      }

      const stored = await store.getLinkage(txid)
      if (stored) linkage.push({ txid, payload: new Uint8Array(stored.payloadBytes) })
      queue.push(parent)
    }
  }

  return { tipTxid: tipTx.id('hex'), assetId, overlayIdentityKey, linkage, admissions }
}

/**
 * Runs COVER for a delivered frame.
 *
 * A thin adapter, on purpose: it turns the frame's wire arrays into the maps
 * the pure walk reads, and makes exactly no judgement of its own about whether
 * the evidence is sufficient. Every verdict below that is not the verifier's
 * own is a SHAPE refusal — there was nothing coherent to ask about:
 *
 *  · not a token frame, or a token frame with no token block;
 *  · transaction bytes that are not readable AtomicBEEF;
 *  · a verifier that threw. The verifier is injected and may be a third
 *    party's; an exception escaping into the settle path would abort a credit
 *    somewhere between "refused" and "accepted", which is the one outcome a
 *    money path may never have.
 */
export async function coverFromFrame(frame: PaymentFrame, cover: CoverVerifier): Promise<CoverResult> {
  if (frame.kind !== 'token' || !frame.token) return { ok: false, reason: 'shape' }

  let beef: Beef
  let tipTxid: string
  try {
    beef = Beef.fromBinary(Array.from(frame.transaction))
    const atomic = beef.atomicTxid
    const tx = Transaction.fromAtomicBEEF(Array.from(frame.transaction))
    tipTxid = atomic ?? tx.id('hex')
  } catch {
    return { ok: false, reason: 'shape' }
  }

  const txs = new Map<string, Transaction>()
  for (const btx of beef.txs) {
    const tx = btx.tx
    if (tx) txs.set(btx.txid, tx)
  }
  const tip = txs.get(tipTxid)
  if (!tip) return { ok: false, reason: 'shape' }

  const bundle: CoverBundle = {
    assetId: frame.token.assetId,
    overlayIdentityKey: frame.token.overlayIdentityKey,
    beef: txs,
    linkage: new Map(frame.token.linkage.map(l => [l.txid, l.payload])),
    admissions: new Map(frame.token.admissions.map(a => [a.txid, a]))
  }

  try {
    return await cover({ txid: tipTxid, tx: tip }, bundle)
  } catch {
    return { ok: false, reason: 'shape' }
  }
}
