import {
  Beef,
  Hash,
  P2PKH,
  PublicKey,
  Signature,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils
} from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { FRAME_VERSION, type PaymentFrame } from './codec'
import { isRequestableAmount, type Session } from './session'
import { PEERPAY_LABEL, PEERPAY_PROTOCOL_ID } from './pending'
import { FT_PROTOCOL_ID } from './verify'
import type { Ack } from './types'
import { MANDALA_ACTION_LABEL, MANDALA_BASKET, assembleBundle, type BundleStore } from '../mandala/bundle'
import { getOnline } from '../net/online'

/** The toolbox's per-txid verdict on a `sendWith` release. */
type SendWithStatus = 'unproven' | 'sending' | 'failed'

interface ListOutputsOutcome {
  totalOutputs?: number
  outputs: { outpoint: string; satoshis?: number; spendable?: boolean; customInstructions?: string }[]
  BEEF?: number[]
}

interface CreateActionOutcome {
  tx?: number[]
  txid?: string
  signableTransaction?: { reference: string; tx?: number[] }
  sendWithResults?: { txid: string; status: string }[]
}

interface PayingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
  createAction(args: unknown, originator?: string): Promise<CreateActionOutcome>
  signAction(args: unknown, originator?: string): Promise<{ tx?: number[]; txid?: string }>
  /**
   * Token path only. Present on every BRC-100 wallet; optional here so the BSV
   * path's callers and its tests are unchanged by the token path's existence.
   */
  listOutputs?(args: unknown, originator?: string): Promise<ListOutputsOutcome>
  /** Token path only: signs each selected token input (BRC-100 `createSignature`). */
  createSignature?(args: unknown, originator?: string): Promise<{ signature: number[] }>
  /** Token path only: mints the overlay-verifier linkage for inputs and change. */
  revealSpecificKeyLinkage?(args: unknown, originator?: string): Promise<unknown>
  /**
   * Releases the inputs a `noSend` action is holding. Required, not optional:
   * without it an abandoned build locks `amount + fee` in the payer's wallet
   * permanently — see BuiltPayment.reference.
   */
  abortAction(args: { reference: string }, originator?: string): Promise<{ aborted: boolean }>
}

/** A signed, undelivered payment plus the handles needed to unwind or release it. */
export interface BuiltPayment {
  frame: PaymentFrame
  /**
   * The `createAction` reference, for `abortAction`.
   *
   * The action is created `noSend`, which marks its inputs `spendable: false`.
   * The storage sweeper (`TaskFailAbandoned`) only reaps `unprocessed` and
   * `unsigned` actions — NOT `nosend` — so a build that is never delivered
   * locks `amount + fee` forever and silently. Callers MUST abort on every
   * path where the frame provably never left the device, and MUST NOT abort
   * once delivery is even possible: the payee may still broadcast, and
   * aborting frees inputs the payer's wallet would then respend.
   *
   * Undefined only if a wallet finalises `createAction` itself without
   * surfacing a reference; nothing can be aborted in that case.
   */
  reference?: string
  /**
   * The txid of the signed `noSend` transaction, for `broadcastPayment`.
   *
   * `options.sendWith` addresses a withheld action by txid, not by reference,
   * so this is the only handle that can release it. Undefined only if a wallet
   * returns no txid from either `createAction` or `signAction`; the action then
   * cannot be broadcast by the payer at all.
   */
  txid?: string
  /**
   * The real satoshis locked into `frame.outputIndex`, read off the signed
   * transaction rather than the requested `amount` — the two differ under
   * send-max, where `amount` carries the sentinel and the wallet rewrites the
   * output to whatever it could fund. Callers displaying "amount sent" must
   * use this, not the value they asked `buildPaymentFrame` for.
   *
   * On the TOKEN path this is the output's own satoshis — 1, per BRC-92 — and
   * is not the payment. `tokenAmount` is.
   */
  satoshis: number
  /**
   * Base units of the asset locked to the payee, on the token path only.
   *
   * A token output carries 1 satoshi and the real figure in its script, so a
   * caller that rendered `satoshis` as "amount sent" for a token payment would
   * show "1" for every payment ever made. Undefined on the BSV path, where
   * `satoshis` IS the payment.
   */
  tokenAmount?: number
}

/** One token coin in the payer's basket, with what it takes to spend it. */
export interface SelectedTokenCoin {
  /** "<txid>.<vout>" */
  outpoint: string
  /** Base units carried by the script, not satoshis. */
  amount: number
  /** BRC-42 keyID this coin was locked under, from its customInstructions. */
  keyID: string
  /** BRC-42 counterparty this coin was locked under. */
  counterparty: string
}

/**
 * The D2 blinding seam.
 *
 * A′ = A + rG: the payee derives against a BLINDED sender key and so cannot
 * join this payer's later payments to each other. That arithmetic needs the
 * payer's own scalar, which no BRC-100 method exposes — it lives in
 * `@bsv/mandala` beside the rest of the token pipeline. It is injected rather
 * than approximated here, and it is REQUIRED rather than defaulted: a
 * silent fall-back to an unblinded BRC-29 lock would still produce a working
 * payment, which is exactly why it would never be noticed.
 */
export type LockToPayee = (args: {
  assetId: string
  amount: number
  /** The payee's identity key, from the session. */
  recipientKey: string
  /** The session's own nonces, `"<prefix> <suffix>"` — what binds frame to request. */
  keyID: string
}) => Promise<{
  lockingScript: string
  /** A′ — what goes on the wire as `frame.senderIdentityKey`. */
  senderIdentityKey: string
  /** The overlay-verifier SpecificLinkage for this output (k for S′, not S). */
  linkage: unknown
  customInstructions?: string
}>

/** What the token path needs beyond an ordinary BSV build. */
export interface TokenBuildDeps {
  /** Read side of this device's settlement tables, for the AdmissionBundle. */
  store: BundleStore
  lockToPayee: LockToPayee
  /**
   * Promotes a `lockToPayee` blinding reservation to the frame's tip txid once
   * the transaction is signed (nearby blinding, offline-settlement design):
   * `lockToPayee` mints r and reserves it under the session's own `keyID`
   * before a txid exists; this call moves that reservation to the real txid
   * once one does. Optional so the BSV path's callers and tests are
   * unaffected — omitting it just leaves the reservation for the drain's own
   * `pruneBlindingReservations` sweep instead of promoting it, which costs
   * this device's own later recovery of r but never the payment itself.
   */
  commitBlinding?: (keyID: string, txid: string) => Promise<void>
  /** Defaults to `MANDALA_BASKET`. */
  basket?: string
  /** Opaque serialized VerifiableCertificates to carry, if the asset needs any. */
  certificates?: Uint8Array[]
}

/**
 * What became of a delivered payment, from the payer's side.
 *
 * `broadcast: 'pending'` is NOT a failed payment. It means the payee acked
 * positively — the money is durably queued there and will be internalized —
 * but this device could not get the transaction out itself.
 */
export type DeliveryOutcome =
  | { kind: 'sent'; broadcast: 'ok' | 'pending'; detail?: string }
  | { kind: 'declined'; reason?: string }

/**
 * Picks the coins to spend: largest first, fewest UTXOs.
 *
 * Fewest inputs is not an aesthetic preference — every token input adds its own
 * ancestor to the BEEF the frame carries and its own linkage reveal to the
 * payload, and the sealed frame has a hard 64 KiB ceiling on the radios. A
 * selection that took ten small coins where one large one would do can push an
 * otherwise ordinary payment past the wire limit.
 *
 * Throws rather than under-funding: a transaction that moves less than the
 * payee asked for is not a smaller payment, it is a broken one.
 */
export function selectTokenCoins(
  coins: SelectedTokenCoin[],
  amount: number
): { selected: SelectedTokenCoin[]; total: number } {
  if (!isRequestableAmount(amount)) {
    throw new Error('amount must be a positive whole number of base units')
  }
  const sorted = [...coins].sort((a, b) => b.amount - a.amount)
  // An exact or single-coin cover is both the smallest input set and the
  // smallest frame, so prefer the smallest coin that covers the whole amount.
  const single = [...sorted].reverse().find(c => c.amount >= amount)
  if (single) return { selected: [single], total: single.amount }

  const selected: SelectedTokenCoin[] = []
  let total = 0
  for (const coin of sorted) {
    selected.push(coin)
    total += coin.amount
    if (total >= amount) return { selected, total }
  }
  throw new Error(`insufficient token balance: have ${total}, need ${amount}`)
}

/**
 * Builds the frame a payer sends. BRC-29: the output locks to a key derived
 * for the payee from the session's derivation nonces.
 *
 * The transaction is AtomicBEEF on both transports. The QR path was originally
 * specified as bare rawtx to shrink the symbol, but the payee needs ancestry to
 * internalize offline, and the fountain removed the symbol-size ceiling that
 * made a smaller QR payload worth having — so one encoding serves both paths.
 *
 * `amount` is passed in rather than read off the session because the session's
 * own amount is optional: on an open request the payer chooses. Making it an
 * explicit argument means the one figure that becomes a real output — and the
 * one the payee binds its settle check to — is chosen at exactly one call site
 * and cannot silently fall back to `undefined` satoshis. It is validated here
 * rather than trusted, since a fractional or negative value reaching
 * createAction is a malformed transaction, not a UI glitch.
 */
export async function buildPaymentFrame(
  wallet: PayingWallet,
  session: Session,
  originator: string,
  amount: number,
  /**
   * Required when — and only when — the session names an asset. A token
   * request with no deps is refused rather than silently paid in satoshis:
   * the two are not interchangeable, and `amount` means base units on one
   * path and satoshis on the other.
   */
  token?: TokenBuildDeps,
  /** The payer's note. Becomes the action's description in place of the fixed
   * fallback, and rides on the frame so the payee's own activity row can show
   * it too. */
  note?: string
): Promise<BuiltPayment> {
  if (!isRequestableAmount(amount)) {
    throw new Error('amount must be a positive whole number of satoshis')
  }
  if (session.asset) {
    if (!token) {
      throw new Error('a token session needs token build deps (store + lockToPayee)')
    }
    if (session.amount !== undefined && session.amount !== amount) {
      throw new Error('amount does not match the payee’s request')
    }
    return buildTokenPaymentFrame(wallet, session, session.asset, originator, amount, token, note)
  }
  // A payee that named a figure is stating a binding term of the request, and
  // its settle path refuses anything else. Catching the disagreement here — on
  // the payer, before an action exists — turns a burnt build and a remote
  // decline into a plain refusal with nothing to unwind.
  if (session.amount !== undefined && session.amount !== amount) {
    throw new Error('amount does not match the payee’s request')
  }

  const { publicKey: senderIdentityKey } = await wallet.getPublicKey({ identityKey: true }, originator)

  const { publicKey: derived } = await wallet.getPublicKey(
    {
      protocolID: PEERPAY_PROTOCOL_ID,
      keyID: `${session.derivationPrefix} ${session.derivationSuffix}`,
      counterparty: session.identityKey,
      forSelf: false
    },
    originator
  )

  const lockingScript = new P2PKH().lock(PublicKey.fromString(derived).toAddress()).toHex()

  let result = await wallet.createAction(
    {
      // The activity list uses the description as the row title, so it says
      // what happened. Not the payee's key: the row draws the counterparty as
      // a sigil from the label below, and an abbreviated key as a title told
      // the user nothing about a blinded transfer (2026-09-16). A payer's note
      // overrides this fixed wording, same as the message-box rail.
      description: note?.trim() || 'Sent BSV',
      // The payee's identity key rides as a label, and the derivation data as
      // the output's customInstructions — exactly what the handle rail writes.
      // Both rails derive to BRC-29 (`counterparty: identityKey`, keyID
      // `prefix suffix`), so a nearby payment whose code was never scanned can
      // be rebuilt and re-delivered through the message box later, from the
      // transaction's own row. Without these two fields nothing on this device
      // remembers who the payment was for: the sealed frame needs the payee's
      // session PSK to read, and that dies with the session.
      labels: [PEERPAY_LABEL, session.identityKey],
      outputs: [
        {
          lockingScript,
          satoshis: amount,
          outputDescription: 'Nearby payment',
          customInstructions: JSON.stringify({
            derivationPrefix: session.derivationPrefix,
            derivationSuffix: session.derivationSuffix,
            type: 'BRC29'
          })
        }
      ],
      // `signAndProcess: false` is what makes the action abortable.
      //
      // WalletPermissionsManager forces signAndProcess=false on the underlying
      // wallet regardless, so the transaction built here is byte-identical
      // either way. What changes is who finalises it: left unset, the manager
      // calls signAction itself and returns `signableTransaction: undefined`,
      // discarding the only reference the wallet ever emits. Asking for the
      // deferred result keeps that reference, so an abandoned build can release
      // its inputs instead of locking them forever.
      options: { randomizeOutputs: false, noSend: true, signAndProcess: false }
    },
    originator
  )

  const reference = result.signableTransaction?.reference

  return await releasingOnFailure(wallet, reference, originator, async () => {
    // With signAndProcess disabled, createAction returns an unsigned
    // `signableTransaction` rather than a final `tx`. We have no caller-supplied
    // inputs — all inputs are wallet-funded — so finalize by signing with empty
    // `spends`. noSend stays true: the payee internalizes and broadcasts, not
    // the payer.
    if (!result.tx && result.signableTransaction) {
      const signed = await wallet.signAction(
        {
          reference: result.signableTransaction.reference,
          spends: {},
          options: { noSend: true }
        },
        originator
      )
      result = { ...result, ...signed }
    }

    if (!result.tx) throw new Error('createAction returned no transaction')

    // Authoritative amount off the transaction itself — covers send-max, where
    // `amount` was the sentinel and the wallet wrote the real figure to output 0.
    const paid = Transaction.fromAtomicBEEF(result.tx).outputs[0]?.satoshis
    if (typeof paid !== 'number' || paid <= 0) throw new Error('Could not determine paid amount')

    return {
      frame: {
        version: FRAME_VERSION,
        kind: 'bsv' as const,
        senderIdentityKey,
        outputIndex: 0,
        derivationPrefix: session.derivationPrefix,
        derivationSuffix: session.derivationSuffix,
        ...(note?.trim() ? { note: note.trim() } : {}),
        transaction: new Uint8Array(result.tx)
      },
      reference,
      txid: result.txid,
      satoshis: paid
    }
  })
}

/**
 * Runs the rest of a build once `createAction` has handed back a reference,
 * and releases that action if any step throws.
 *
 * From `createAction` on, the action holds its inputs `spendable: false`. An
 * `unsigned` action is eventually reaped by the storage sweeper; a signed
 * `nosend` one never is — the 2026-09-16 incident left a just-received coin
 * locked for good when `assembleBundle` threw after `signAction`, and the
 * caller's catch had no way to know an action existed. The build does know,
 * and nothing inside it has left the device, so aborting here is always safe.
 * Best-effort: the error the caller sees is the one that stopped the build.
 */
async function releasingOnFailure<T>(
  wallet: PayingWallet,
  reference: string | undefined,
  originator: string,
  steps: () => Promise<T>
): Promise<T> {
  try {
    return await steps()
  } catch (e) {
    if (reference) {
      try {
        const result = await wallet.abortAction({ reference }, originator)
        if (result?.aborted === false) throw new Error('abortAction returned aborted:false')
      } catch (abortError) {
        console.warn('[localpay] could not release the failed build:', messageOf(abortError))
      }
    }
    throw e
  }
}

/**
 * The payer's token build (offline-settlement spec §9, steps 4–5).
 *
 * Structurally the same shape as the BSV path — select, create `noSend`, sign,
 * hand over — with two differences that are the whole point of the revision:
 *
 *  1. The frame carries an ADMISSION BUNDLE: σ_I for every ancestor this device
 *     can prove the overlay admitted, and the linkage payload for every one it
 *     cannot, including the tip's own. That is what lets the payee decide,
 *     offline, whether the coin it is being handed is real.
 *  2. Nothing is submitted. Not to the overlay, not to the network. The payer
 *     hands over and stops; the recipient submits (rule 3) and this device's own
 *     drain submits too, optionally, whenever it next reconnects (rule 6).
 *     Submitting first would put a face-to-face payment behind a network round
 *     trip, and broadcasting first would put an unadmitted token transaction on
 *     chain — which the overlay can then only refuse.
 *
 * `randomizeOutputs` is off, as on the BSV path, so the payee's output is index
 * 0 and the frame can name it. The mandala handle rail shuffles instead, to hide
 * which output is the recipient's from a chain observer; that buys nothing here,
 * where the payee is standing in front of the payer and already knows its own
 * script.
 */
/**
 * How many basket outputs one `listOutputs` page asks for.
 *
 * BRC-100's default `limit` is TEN. Coin selection was reading that one default
 * page and calling it the wallet's balance: a payer holding twelve coins whose
 * eleventh and twelfth were the ones that covered the amount got
 * `insufficient token balance` for money it plainly had — worse, the figure in
 * the message was a partial total, so it read as a wallet bug rather than a
 * paging bug. A thousand is high enough that the loop below is one round trip
 * for any realistic basket and low enough not to drag a whole basket's BEEF
 * through one response.
 */
const TOKEN_LIST_PAGE = 1000

/**
 * Hard stop on the paging loop.
 *
 * `totalOutputs` is the wallet's own count, and the loop also stops on a short
 * or empty page — but a wallet that reports a total it never serves (or serves
 * the same page forever) must not spin a payment screen. A million outputs is
 * far past any real basket.
 */
const TOKEN_LIST_MAX_PAGES = 1000

/**
 * Every output of the token basket, page by page, merging each page's BEEF into
 * `into` as it goes.
 *
 * The BEEF accumulates across pages on purpose: an output's value lives in its
 * source transaction's script, so a coin from page two is unreadable — silently
 * skipped by the caller's `if (!script) continue` — unless page two's
 * transactions are merged before it is examined.
 */
async function* listTokenBasket(
  wallet: PayingWallet,
  basket: string,
  originator: string,
  into: Beef
): AsyncGenerator<ListOutputsOutcome['outputs'][number]> {
  let offset = 0
  for (let page = 0; page < TOKEN_LIST_MAX_PAGES; page++) {
    const listed = await wallet.listOutputs!(
      {
        basket,
        include: 'entire transactions',
        includeCustomInstructions: true,
        limit: TOKEN_LIST_PAGE,
        offset
      },
      originator
    )
    if (listed.BEEF) into.mergeBeef(listed.BEEF)
    const outputs = listed.outputs ?? []
    for (const out of outputs) yield out
    // An empty page always ends it — that, plus the page ceiling, is what keeps
    // a wallet that ignores `offset` from looping forever.
    if (outputs.length === 0) return
    offset += outputs.length
    if (typeof listed.totalOutputs === 'number') {
      // The wallet's own count is the authority when it reports one. A SHORT
      // page must not end the loop here: a wallet is free to cap `limit` below
      // what was asked for, and treating its cap as "end of basket" would
      // re-introduce the very truncation this loop exists to fix.
      if (offset >= listed.totalOutputs) return
    } else if (outputs.length < TOKEN_LIST_PAGE) {
      // No count to go by, so a short page is the only end-of-basket signal
      // there is.
      return
    }
  }
}

async function buildTokenPaymentFrame(
  wallet: PayingWallet,
  session: Session,
  asset: NonNullable<Session['asset']>,
  originator: string,
  amount: number,
  deps: TokenBuildDeps,
  note?: string
): Promise<BuiltPayment> {
  if (!wallet.listOutputs) throw new Error('this wallet cannot list token outputs')
  if (!wallet.createSignature) throw new Error('this wallet cannot sign token inputs')
  if (!wallet.revealSpecificKeyLinkage) throw new Error('this wallet cannot reveal token linkage')

  const basket = deps.basket ?? MANDALA_BASKET
  const keyID = `${session.derivationPrefix} ${session.derivationSuffix}`

  // `include: 'entire transactions'` is not an optimisation: the amount a token
  // output carries lives in its SCRIPT, not in `satoshis`, so the coins cannot
  // even be valued without their source transactions — and the same BEEF is
  // what the payee will walk to prove the chain.
  const sourceBeef = new Beef()
  const coins: SelectedTokenCoin[] = []
  for await (const out of listTokenBasket(wallet, basket, originator, sourceBeef)) {
    if (out.spendable === false) continue
    const [txid, voutText] = out.outpoint.split('.')
    const source = sourceBeef.findTxid(txid)?.tx
    const script = source?.outputs[Number(voutText)]?.lockingScript
    if (!script) continue
    let decoded: { assetId: string; amount: number }
    try {
      decoded = MandalaToken.decode(script)
    } catch {
      continue // a stray non-token output in the basket is not this asset's coin
    }
    if (decoded.assetId !== asset.id) continue
    const ci = parseCustomInstructions(out.customInstructions)
    coins.push({
      outpoint: out.outpoint,
      amount: decoded.amount,
      keyID: ci.keyID ?? '',
      counterparty: ci.counterparty ?? 'self'
    })
  }

  const { selected, total } = selectTokenCoins(coins, amount)
  const change = total - amount

  const payee = await deps.lockToPayee({
    assetId: asset.id,
    amount,
    recipientKey: session.identityKey,
    keyID
  })

  const outputs: Record<string, unknown>[] = [
    {
      satoshis: 1,
      lockingScript: payee.lockingScript,
      outputDescription: 'Nearby token payment',
      ...(payee.customInstructions === undefined ? {} : { customInstructions: payee.customInstructions })
    }
  ]
  // One keyID for the change, derived from the session's own nonces so a
  // resend rebuilds the same script rather than minting a second coin.
  const changeKeyID = `change ${keyID}`
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true }, originator)
  if (change > 0) {
    const changeScript = await new MandalaToken(wallet as never, originator).lockBRC29(
      asset.id,
      change,
      FT_PROTOCOL_ID,
      changeKeyID,
      identityKey
    )
    outputs.push({
      satoshis: 1,
      lockingScript: changeScript.toHex(),
      outputDescription: 'Token change',
      // Change comes back to THIS device, so it goes back in the basket. The
      // payee's output deliberately does not: it is not ours to track.
      basket,
      customInstructions: JSON.stringify({
        protocolID: FT_PROTOCOL_ID,
        keyID: changeKeyID,
        counterparty: identityKey,
        direction: 'change'
      })
    })
  }

  const created = await wallet.createAction(
    {
      // Same title discipline as the BSV path; the activity row overrides it
      // with "Sent <ticker>" from the settlement row unless a note was given
      // (WalletHomeScreen.tsx). The 'mandala' label is what makes the row
      // recognise a token row at all — the home screen keys off that label,
      // and without it a nearby token payment rendered as a BSV row — the
      // payee's key over "+0 sats" (2026-09-16). The payee key stays on as a
      // label for the resend path.
      description: note?.trim() || 'Sent token',
      labels: [PEERPAY_LABEL, session.identityKey, MANDALA_ACTION_LABEL],
      inputBEEF: sourceBeef.toBinary(),
      inputs: selected.map(coin => ({
        outpoint: coin.outpoint,
        unlockingScriptLength: 108,
        inputDescription: 'spend token'
      })),
      outputs,
      options: { randomizeOutputs: false, noSend: true, signAndProcess: false }
    },
    originator
  )

  const signable = created.signableTransaction
  if (!signable?.tx) throw new Error('createAction returned no signable token transaction')
  const signableTx = signable.tx

  return await releasingOnFailure(wallet, signable.reference, originator, async () => {
    const unsigned = Transaction.fromBEEF(signableTx)

    // Input order is caller order — `randomizeOutputs` shuffles outputs only, and
    // it is off here anyway — so our coins occupy indices 0..n-1 and the wallet's
    // own fee inputs follow. Each is signed individually rather than through
    // `tx.sign()`, which would also reach inputs that are the wallet's to sign.
    const spends: Record<string, { unlockingScript: string }> = {}
    for (let i = 0; i < selected.length; i++) {
      const script = await signTokenInput(wallet, unsigned, i, selected[i], sourceBeef, originator)
      spends[String(i)] = { unlockingScript: script.toHex() }
    }

    const signed = await wallet.signAction(
      { reference: signable.reference, spends, options: { noSend: true } },
      originator
    )
    if (!signed.tx) throw new Error('signAction returned no transaction')

    const tipTx = Transaction.fromAtomicBEEF(signed.tx)
    const tipTxid = signed.txid ?? tipTx.id('hex')

    // Promote the payee's blinding reservation (minted back in `lockToPayee`,
    // before this txid existed) now that one does. Best-effort and after the
    // fact: the payment is already signed, so a commit failure here must not
    // fail it — it only costs this device's own later recovery of r, and the
    // reservation is still there for `pruneBlindingReservations` to sweep.
    if (deps.commitBlinding) {
      try {
        await deps.commitBlinding(keyID, tipTxid)
      } catch (e) {
        console.warn('[localpay] blindingCommit failed:', messageOf(e))
      }
    }

    // The bundle covers the ANCESTORS; the tip's own payload is minted here,
    // because only this function knows which outputs it just created and under
    // which keys.
    const bundle = await assembleBundle({
      tipTx,
      assetId: asset.id,
      overlayIdentityKey: asset.overlayIdentityKey,
      store: deps.store
    })
    const tipLinkage = await mintTipLinkage(wallet, {
      inputs: selected,
      payeeLinkage: payee.linkage,
      changeKeyID: change > 0 ? changeKeyID : undefined,
      changeCounterparty: identityKey,
      overlayIdentityKey: asset.overlayIdentityKey,
      originator
    })

    const paid = tipTx.outputs[0]?.satoshis
    return {
      frame: {
        version: FRAME_VERSION,
        kind: 'token' as const,
        // A′, never A. `lockToPayee` is the only thing that knows it.
        senderIdentityKey: payee.senderIdentityKey,
        outputIndex: 0,
        derivationPrefix: session.derivationPrefix,
        derivationSuffix: session.derivationSuffix,
        token: {
          assetId: asset.id,
          overlayUrl: asset.overlayUrl,
          overlayIdentityKey: asset.overlayIdentityKey,
          certificates: deps.certificates ?? [],
          // The tip goes first: it is the one entry every recipient of this frame
          // needs, whatever else the chain behind it looks like.
          linkage: [{ txid: tipTxid, payload: tipLinkage }, ...bundle.linkage],
          admissions: bundle.admissions
        },
        ...(note?.trim() ? { note: note.trim() } : {}),
        transaction: new Uint8Array(signed.tx)
      },
      reference: signable.reference,
      txid: tipTxid,
      satoshis: typeof paid === 'number' ? paid : 1,
      tokenAmount: amount
    }
  })
}

function parseCustomInstructions(text?: string): { keyID?: string; counterparty?: string } {
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    return {
      keyID: typeof parsed.keyID === 'string' ? parsed.keyID : undefined,
      counterparty: typeof parsed.counterparty === 'string' ? parsed.counterparty : undefined
    }
  } catch {
    // A coin whose instructions are unreadable cannot be unlocked, but that is
    // the signer's failure to report, not this parser's — it would be worse to
    // drop the coin silently and tell the user they are short of funds.
    return {}
  }
}

/**
 * Signs one token input through the wallet (BRC-100 `createSignature`).
 *
 * `MandalaToken.unlock` in `@bsv/templates` signs with a raw `PrivateKey`,
 * which a BRC-100 wallet never exports. This is the same construction driven
 * through the wallet instead: the sighash preimage is built identically, the
 * wallet signs its double-SHA256 under the FT protocol and the coin's own
 * keyID, and the public key that goes in the script is the `forSelf: true`
 * derivation — the key the LOCKER hashed, by BRC-42 symmetry. For a coin
 * another party locked to us, only `forSelf: true` matches the pubKeyHash.
 */
async function signTokenInput(
  wallet: PayingWallet,
  tx: Transaction,
  inputIndex: number,
  coin: SelectedTokenCoin,
  sources: Beef,
  originator: string
): Promise<UnlockingScript> {
  const input = tx.inputs[inputIndex]
  if (!input) throw new Error(`the signable transaction has no input ${inputIndex}`)
  const [coinTxid, coinVout] = coin.outpoint.split('.')
  const sourceTx = input.sourceTransaction ?? sources.findTxid(coinTxid)?.tx
  const sourceOutput = sourceTx?.outputs[input.sourceOutputIndex ?? Number(coinVout)]
  if (!sourceOutput?.lockingScript || sourceOutput.satoshis == null) {
    throw new Error(`cannot sign token input ${inputIndex}: its source output is missing`)
  }

  const scope = TransactionSignature.SIGHASH_FORKID | TransactionSignature.SIGHASH_ALL
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTXID ?? coinTxid,
    sourceOutputIndex: input.sourceOutputIndex ?? Number(coinVout),
    sourceSatoshis: sourceOutput.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: sourceOutput.lockingScript,
    lockTime: tx.lockTime,
    scope
  })

  const { signature: der } = await (wallet.createSignature as NonNullable<PayingWallet['createSignature']>)(
    {
      hashToDirectlySign: Hash.hash256(preimage),
      protocolID: FT_PROTOCOL_ID,
      keyID: coin.keyID,
      counterparty: coin.counterparty
    },
    originator
  )
  const sig = Signature.fromDER([...der])
  const sigForScript = new TransactionSignature(sig.r, sig.s, scope).toChecksigFormat()
  const { publicKey } = await wallet.getPublicKey(
    { protocolID: FT_PROTOCOL_ID, keyID: coin.keyID, counterparty: coin.counterparty, forSelf: true },
    originator
  )
  const pubkey = Utils.toArray(publicKey, 'hex')
  return new UnlockingScript([
    { op: sigForScript.length, data: sigForScript },
    { op: pubkey.length, data: pubkey }
  ])
}

/**
 * The tip's own `MandalaLinkagePayload` — the exact off-chain bytes the
 * overlay's `/submit` consumes, UTF-8 JSON of
 * `{ inputs: [{index, linkage}], outputs: [{index, linkage}] }`.
 *
 * EVERY token output needs its own entry: an unlinked one is skipped by the
 * overlay's topic manager and breaks its conservation check, which refuses the
 * whole transaction. Inputs are revealed so the overlay can screen the SENDER
 * under an allowlist or denylist asset — omit them and a denylist asset still
 * admits, but sender screening silently degrades.
 *
 * The verifier on every reveal is the OVERLAY's key, never the payee's: these
 * are BRC-72 blobs only the prover and the named verifier can decrypt. The
 * payee carries them, forwards them verbatim on a re-spend, and can read none
 * of them.
 */
async function mintTipLinkage(
  wallet: PayingWallet,
  args: {
    inputs: SelectedTokenCoin[]
    payeeLinkage: unknown
    changeKeyID?: string
    changeCounterparty: string
    overlayIdentityKey: string
    originator: string
  }
): Promise<Uint8Array> {
  const reveal = wallet.revealSpecificKeyLinkage as NonNullable<PayingWallet['revealSpecificKeyLinkage']>
  const forOverlay = (keyID: string, counterparty: string) =>
    reveal(
      { counterparty, verifier: args.overlayIdentityKey, protocolID: FT_PROTOCOL_ID, keyID },
      args.originator
    )

  const outputs: { index: number; linkage: unknown }[] = [{ index: 0, linkage: args.payeeLinkage }]
  if (args.changeKeyID !== undefined) {
    outputs.push({ index: 1, linkage: await forOverlay(args.changeKeyID, args.changeCounterparty) })
  }
  const inputs: { index: number; linkage: unknown }[] = []
  for (let i = 0; i < args.inputs.length; i++) {
    inputs.push({ index: i, linkage: await forOverlay(args.inputs[i].keyID, args.inputs[i].counterparty) })
  }

  return new Uint8Array(Utils.toArray(JSON.stringify({ inputs, outputs }), 'utf8'))
}

/**
 * Releases the `noSend` payment identified by `txid` so this device broadcasts it.
 *
 * BRC-100 releases a previously withheld action by naming its txid in
 * `options.sendWith` on a follow-up `createAction` that creates nothing of its
 * own. Verified end to end in @bsv/wallet-toolbox-mobile / @bsv/sdk:
 *
 *  · sdk validationHelpers.js:458-460 — `isSendWith = sendWith.length > 0`, and
 *    `isNewTx` stays FALSE when there are no inputs and no outputs, so this
 *    builds nothing. `description` is still mandatory (5–2000 bytes, :438).
 *  · signer/methods/createAction.js:10-46 — with `isNewTx` false it skips
 *    straight to `processAction`, whose args carry `sendWith` and a null
 *    reference/txid/rawTx.
 *  · storage/methods/processAction.js:26 — the sendWith txids become
 *    `txidsOfReqsToShareWithWorld` and go to `shareReqsWithWorld`.
 *  · storage/storageProviderHelpers.js:14 — `readyToSendStatuses` includes
 *    'nosend', so a withheld req classifies as `readyToSend` (:28-35) →
 *    `SendWithResult.status = 'sending'` (processAction.js:64-66).
 *  · processAction.js:127-136 — on the default delayed path the req moves to
 *    'unsent' and the transaction to 'sending'. That is the escape from
 *    'nosend': monitor/tasks/TaskFailAbandoned.js:35 only ever sweeps
 *    ['unprocessed', 'unsigned'], so nothing else would have moved it.
 *
 * Reaching this through WalletPermissionsManager raises no prompt and cannot
 * abort the action: with no inputs or outputs the underlying createAction
 * returns no `signableTransaction`, and the manager returns at
 * WalletPermissionsManager.js:2856 before its spending-authorization gate.
 *
 * Throws when the toolbox reports 'failed' for this txid. Callers must treat
 * that as retryable, never as a failed payment — see finalizeDelivery.
 */
export async function broadcastPayment(
  wallet: PayingWallet,
  txid: string,
  originator: string
): Promise<SendWithStatus | undefined> {
  const result = await wallet.createAction(
    {
      // Mandatory even though this creates nothing; must be 5–2000 bytes.
      description: 'Broadcast a nearby payment',
      options: { sendWith: [txid] }
    },
    originator
  )
  const status = result.sendWithResults?.find(r => r.txid === txid)?.status
  if (status === 'failed') {
    throw new Error(`the wallet could not broadcast ${txid}`)
  }
  return status === 'unproven' || status === 'sending' ? status : undefined
}

/**
 * The payer's post-delivery decision. Extracted from the screen so the whole
 * state machine is testable, because it is the point where real money is
 * either released or reclaimed.
 *
 *   POSITIVE ack — the payee has DURABLY QUEUED the payment. Broadcast now.
 *     Never abort: the payee holds a copy and will internalize it, and freeing
 *     the inputs here lets this wallet respend them into a conflict.
 *
 *   NEGATIVE ack — the payee provably queued nothing (see DeclineReason).
 *     Abort to release the inputs, and never broadcast.
 *
 *   NO ack (a throw from the transport) — not this function's business. The
 *     caller must neither abort nor broadcast: a lost ack does not prove
 *     non-delivery, so the frame may still be with the payee.
 *
 * A broadcast failure after a positive ack returns `broadcast: 'pending'`, not
 * a failure. The money is safe at the payee; what is stuck is this device's
 * copy of the transaction, which is a retryable notice, not a failed payment.
 *
 * A positive ack always persists first (`deps.hold`) — including when online.
 * Online Done used to `sendWith` with no queue row and no `framePayload`, which
 * discarded the only copy of the derivation nonces. The drain already posts
 * when online; `sendWith` below runs only after that row exists.
 *
 * OFFLINE: with no network there is nothing to broadcast to, so a positive ack
 * enqueues and returns. The transaction is promoted from `nosend` to `unproven` by
 * the hold, which is what lets the payer fund a SECOND offline payment from this
 * one's change — `allocateChangeInput` excludes `nosend`
 * (storage/StorageExpoSQLite.ts:1284). The outcome is the existing
 * `broadcast: 'pending'`, which the UI already renders as "queued", so no new
 * state reaches the screens. `deps` is injected — not read from `@/utils/net/online`
 * or a database directly — so this stays unit-testable without either; the real
 * app supplies both at the NearbyFlow call site.
 */
export async function finalizeDelivery(
  wallet: PayingWallet,
  built: BuiltPayment,
  ack: Ack,
  originator: string,
  /**
   * Required, and so is `hold` inside it, because the offline branch cannot
   * honestly report a queue it has no way to make. A call site that omitted it
   * would leave the transaction at `nosend` — change unspendable, no queue row,
   * no monitor task that sweeps it — while telling the user it was waiting to be
   * broadcast. `online` stays optional: its default is the real probe, and
   * getting that wrong costs a retry rather than a stranded payment.
   */
  deps: {
    online?: () => Promise<boolean>
    /** Promotes the transaction to `unproven` and queues the txid for release. */
    hold: (txid: string) => Promise<void>
    /** Persist a failed decline-abort so wallet build can retry it. */
    queueFailedAbort?: (reference: string) => Promise<void>
    /**
     * P1-3: a negative ack is the payee's own unverifiable claim that nothing
     * was queued — this codebase's abort-chain-protection only refuses an
     * abort while a service is reachable AND the chain already knows the tx
     * (see core/mandala/abortGuard.ts), so a decline made offline, or a
     * dishonest one, still frees these inputs regardless. Policy is
     * detect-and-warn, never block: called for every decline this function
     * has a txid for (BSV or token, the guard chain protects neither),
     * whether or not the abort itself succeeded, so a later reappearance of
     * this exact txid on chain can be surfaced instead of missed. See
     * core/localpay/pendingAborts.ts's queueDeclinedAbortWatch /
     * verifyDeclinedAborts.
     */
    watchDeclinedAbort?: (entry: { txid: string; reference: string }) => Promise<void>
  }
): Promise<DeliveryOutcome> {
  if (!ack.ok) {
    if (built.reference) {
      // A failed abort is a stuck UTXO, not a lost payment, and must not
      // displace the decline reason the caller is about to show. `{ aborted:
      // false }` is a failure too — queue it for replay on the next wallet build.
      try {
        const result = await wallet.abortAction({ reference: built.reference }, originator)
        if (result?.aborted === false) throw new Error('abortAction returned aborted:false')
      } catch (e: unknown) {
        console.warn('[localpay] abortAction failed:', messageOf(e))
        if (deps.queueFailedAbort) {
          await deps.queueFailedAbort(built.reference).catch(() => undefined)
        }
      }
      // Watched regardless of whether the abort above succeeded: either way
      // these inputs are now free, and the only question left is whether the
      // payee's decline was honest. A failure to record the watch must not
      // turn an otherwise-normal decline into a reported failure.
      if (built.txid && deps.watchDeclinedAbort) {
        await deps.watchDeclinedAbort({ txid: built.txid, reference: built.reference }).catch(() => undefined)
      }
    }
    return { kind: 'declined', reason: ack.error }
  }

  if (!built.txid) {
    return { kind: 'sent', broadcast: 'pending', detail: 'the wallet returned no txid to broadcast' }
  }

  const online = deps?.online ?? getOnline
  // A failed connectivity probe must not change what this function does: assume
  // online and fall through to the ordinary broadcast, which is exactly what ran
  // before this branch existed. If the device is genuinely offline, that attempt
  // fails on its own and lands on the same `broadcast: 'pending'` the hold would
  // have returned anyway — so a probe failure costs nothing either way. This
  // mirrors the same guard already used around every other call to `getOnline`
  // in this codebase (`StorageExpoSQLite.attemptToPostReqsToNetwork`,
  // `processOfflineActions.probeOnline`).
  let isOnline = true
  try {
    isOnline = await online()
  } catch (e) {
    console.warn('[localpay] connectivity probe failed, assuming online:', messageOf(e))
  }

  // Persist before any sendWith, online or off. Skipping this on the online
  // path discarded the sealed frame after Done.
  if (typeof deps?.hold === 'function') {
    try {
      await deps.hold(built.txid)
    } catch (e) {
      // The payee holds a copy and will internalize it, so this is still a sent
      // payment — never a failure. sendWith runs only after the queue row
      // exists: broadcasting here would drop the only sealed-frame copy.
      // Nothing re-drives a hold that threw before its writes landed. See
      // `holdSentPaymentOffline` for why its queue-row insert runs before its
      // status promotion, which is what keeps a partial failure recoverable.
      return { kind: 'sent', broadcast: 'pending', detail: messageOf(e) }
    }
  } else if (!isOnline) {
    // The signature requires `hold`; this catches a JS caller or a cast that
    // got past it. Reported rather than ignored, and deliberately NOT fallen
    // through to the broadcast: offline, a delayed `sendWith` comes back
    // 'sending', which this function reports as `broadcast: 'ok'` — green on
    // the payer's screen for a transaction nothing has.
    return {
      kind: 'sent',
      broadcast: 'pending',
      detail: 'offline, and no hold was supplied to queue this payment with'
    }
  }

  // GUARD #1 (offline-settlement spec §4.3). A token payment is NEVER
  // broadcast from here, online or off.
  //
  // This is the structural half of "admission gates broadcast": `postTokenStep`
  // in the drain is the only path to a real broadcast for a token transaction,
  // and it gets there only after every ancestor in COVER's `mustSubmit` has
  // been admitted. Without this check the online payer falls straight through
  // to `sendWith` exactly as the BSV path does — with no `kind` check at all —
  // and puts an unadmitted token transaction on chain before any overlay has
  // seen it. The overlay can then only refuse it, and the coin is stranded
  // between "spent on chain" and "never admitted".
  //
  // Placed AFTER the hold on purpose: the hold is what creates the queue row
  // the drain owns and promotes `nosend → unproven` so this payment's change
  // can fund the next offline one. Skipping the broadcast is the whole change;
  // skipping the hold would strand the payment instead.
  if (built.frame?.kind === 'token') {
    return { kind: 'sent', broadcast: 'pending', detail: 'awaiting overlay admission' }
  }

  if (!isOnline) {
    return { kind: 'sent', broadcast: 'pending', detail: 'offline — queued until this device reconnects' }
  }

  try {
    await broadcastPayment(wallet, built.txid, originator)
    return { kind: 'sent', broadcast: 'ok' }
  } catch (e) {
    return { kind: 'sent', broadcast: 'pending', detail: messageOf(e) }
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}
