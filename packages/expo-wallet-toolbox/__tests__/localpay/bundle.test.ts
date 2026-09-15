/**
 * The AdmissionBundle walk (offline-settlement spec §1.1, §1.5, §1.6).
 *
 * What these pin is the ONE decision the walk makes per ancestor: a txid this
 * device holds a verifiable σ_I for is a BOTTOM (an admissions entry, no
 * recursion — the recipient will never submit it); anything else is a
 * FRONTIER (a linkage entry, if we hold the bytes, plus recursion into its own
 * token inputs). Getting that backwards either strands a recipient with no
 * evidence to walk, or ships linkage for a transaction nobody needs to submit.
 *
 * Every chain here is a real BEEF built from real MandalaToken scripts, not a
 * shape stub: the walk's whole job is deciding which inputs are token inputs,
 * and a stub would let FIX K (fee parents are not holes) pass by construction.
 */
import { Beef, LockingScript, P2PKH, Transaction, UnlockingScript } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import {
  MANDALA_BASKET,
  assembleBundle,
  coverFromFrame,
  type BundleStore,
  type CoverBundle,
  type CoverTip
} from '../../core/mandala/bundle'
import { FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import type { CoverResult, TokenAdmissionRow, TokenLinkageRow } from '../../core/mandala/types'

const ASSET = 'ab'.repeat(32) + '.0'
const OTHER_ASSET = 'cd'.repeat(32) + '.1'
const OVERLAY_KEY = '03'.padEnd(66, 'b')
const OTHER_KEY = '02'.padEnd(66, 'c')
const PKH = new Array(20).fill(9)
const FEE_ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

/** A token transaction: `amounts` token outputs of `assetId`, spending `spends`. */
function tokenTx(
  amounts: number[],
  spends: { tx: Transaction; vout: number }[] = [],
  assetId = ASSET
): Transaction {
  const tx = new Transaction()
  for (const s of spends) {
    tx.addInput({
      sourceTransaction: s.tx,
      sourceOutputIndex: s.vout,
      unlockingScript: new UnlockingScript([]),
      sequence: 0xffffffff
    })
  }
  for (const amount of amounts) {
    tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, amount, PKH) })
  }
  return tx
}

/** A plain BSV transaction — the payer's own unconfirmed change, funding the fee. */
function feeTx(): Transaction {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(FEE_ADDRESS) })
  return tx
}

function spendFee(tx: Transaction, fee: Transaction): Transaction {
  tx.addInput({
    sourceTransaction: fee,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript([]),
    sequence: 0xffffffff
  })
  return tx
}

/** The tip as it reaches a payee: re-parsed out of its own AtomicBEEF. */
function throughBeef(tip: Transaction): Transaction {
  const beef = new Beef()
  beef.mergeTransaction(tip)
  return Transaction.fromAtomicBEEF(beef.toBinaryAtomic(tip.id('hex')))
}

function atomicBeef(tip: Transaction): Uint8Array {
  const beef = new Beef()
  beef.mergeTransaction(tip)
  return new Uint8Array(beef.toBinaryAtomic(tip.id('hex')))
}

function admission(txid: string, signerKey = OVERLAY_KEY): TokenAdmissionRow {
  return {
    txid,
    outputsToAdmit: [0],
    signatureHex: '3006020101020102',
    signerKey,
    source: 'submitted',
    obtainedAt: '2026-01-01T00:00:00.000Z'
  }
}

function linkage(txid: string): TokenLinkageRow {
  return {
    txid,
    payloadBytes: new Uint8Array([1, 2, 3]),
    overlayUrl: 'https://overlay.example',
    overlayIdentityKey: OVERLAY_KEY,
    source: 'forwarded',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

function storeOf(
  admissions: Record<string, TokenAdmissionRow>,
  linkages: Record<string, TokenLinkageRow>
): BundleStore {
  return {
    getAdmission: jest.fn(async (txid: string) => admissions[txid]),
    getLinkage: jest.fn(async (txid: string) => linkages[txid])
  }
}

const assemble = (tip: Transaction, store: BundleStore) =>
  assembleBundle({ tipTx: tip, assetId: ASSET, overlayIdentityKey: OVERLAY_KEY, store })

describe('MANDALA_BASKET', () => {
  // §8: the basket is renamed so the permission module can route it. The name
  // lives in exactly one place so the builder, the drain and the permission
  // module cannot drift apart.
  it('is the permission-routed name, in one place', () => {
    expect(MANDALA_BASKET).toBe('p mandala')
  })
})

describe('assembleBundle', () => {
  it('0-hop: an admitted parent is a bottom — one admissions entry, no linkage', async () => {
    const x0 = tokenTx([100])
    const tip = throughBeef(tokenTx([40, 60], [{ tx: x0, vout: 0 }]))
    const store = storeOf({ [x0.id('hex')]: admission(x0.id('hex')) }, {})

    const bundle = await assemble(tip, store)

    expect(bundle.admissions).toEqual([
      { txid: x0.id('hex'), outputsToAdmit: [0], signature: expect.any(Uint8Array), signerKey: OVERLAY_KEY }
    ])
    expect(bundle.linkage).toEqual([])
    // A bottom is never walked further: nothing asks the store about its parents.
    expect(store.getLinkage).not.toHaveBeenCalled()
  })

  it('0-hop: a tip with no token input at all carries neither', async () => {
    const tip = throughBeef(tokenTx([100]))
    const bundle = await assemble(tip, storeOf({}, {}))
    expect(bundle.admissions).toEqual([])
    expect(bundle.linkage).toEqual([])
  })

  it('1-hop: an unadmitted parent is a frontier — linkage for it, and its own parent is walked', async () => {
    const g = tokenTx([100])
    const x = tokenTx([100], [{ tx: g, vout: 0 }])
    const tip = throughBeef(tokenTx([40, 60], [{ tx: x, vout: 0 }]))
    const store = storeOf({ [g.id('hex')]: admission(g.id('hex')) }, { [x.id('hex')]: linkage(x.id('hex')) })

    const bundle = await assemble(tip, store)

    expect(bundle.linkage.map(l => l.txid)).toEqual([x.id('hex')])
    expect(bundle.admissions.map(a => a.txid)).toEqual([g.id('hex')])
  })

  it('3-hop: walks to the one covered bottom, forwarding linkage for every hop between', async () => {
    const x0 = tokenTx([100])
    const t1 = tokenTx([100], [{ tx: x0, vout: 0 }])
    const t2 = tokenTx([100], [{ tx: t1, vout: 0 }])
    const t3 = tokenTx([100], [{ tx: t2, vout: 0 }])
    const tip = throughBeef(t3)
    const store = storeOf(
      { [x0.id('hex')]: admission(x0.id('hex')) },
      { [t1.id('hex')]: linkage(t1.id('hex')), [t2.id('hex')]: linkage(t2.id('hex')) }
    )

    const bundle = await assemble(tip, store)

    expect(bundle.linkage.map(l => l.txid).sort()).toEqual([t1.id('hex'), t2.id('hex')].sort())
    expect(bundle.admissions.map(a => a.txid)).toEqual([x0.id('hex')])
  })

  // FIX K. The payer's own unconfirmed BSV change funds the fee. It is not a
  // token ancestor: walking it would make the ordinary case ("I just spent my
  // own change") look like a hole and refuse a perfectly good payment.
  it('ignores a non-token fee parent entirely — not a hole, not an entry', async () => {
    const x0 = tokenTx([100])
    const fee = feeTx()
    const tip = throughBeef(spendFee(tokenTx([100], [{ tx: x0, vout: 0 }]), fee))
    const store = storeOf({ [x0.id('hex')]: admission(x0.id('hex')) }, {})

    const bundle = await assemble(tip, store)

    expect(bundle.admissions.map(a => a.txid)).toEqual([x0.id('hex')])
    expect(bundle.linkage).toEqual([])
    expect(store.getAdmission).not.toHaveBeenCalledWith(fee.id('hex'))
  })

  it('ignores a parent output of a different asset', async () => {
    const other = tokenTx([100], [], OTHER_ASSET)
    const tip = throughBeef(tokenTx([100], [{ tx: other, vout: 0 }]))
    const store = storeOf({}, {})

    const bundle = await assemble(tip, store)

    expect(bundle.admissions).toEqual([])
    expect(bundle.linkage).toEqual([])
    expect(store.getAdmission).not.toHaveBeenCalled()
  })

  // FIX H's shape at assembly time: a cached admission signed by anyone other
  // than THIS session's overlay is not evidence. Treated as absent — the
  // ancestor becomes a frontier and is walked, never quietly accepted.
  it('treats an admission signed by a different key as absent', async () => {
    const g = tokenTx([100])
    const x = tokenTx([100], [{ tx: g, vout: 0 }])
    const tip = throughBeef(tokenTx([100], [{ tx: x, vout: 0 }]))
    const store = storeOf(
      { [x.id('hex')]: admission(x.id('hex'), OTHER_KEY), [g.id('hex')]: admission(g.id('hex')) },
      { [x.id('hex')]: linkage(x.id('hex')) }
    )

    const bundle = await assemble(tip, store)

    expect(bundle.admissions.map(a => a.txid)).toEqual([g.id('hex')])
    expect(bundle.linkage.map(l => l.txid)).toEqual([x.id('hex')])
  })

  it('walks a shared parent once, however many inputs reach it', async () => {
    const x0 = tokenTx([50, 50])
    const tip = throughBeef(tokenTx([100], [{ tx: x0, vout: 0 }, { tx: x0, vout: 1 }]))
    const store = storeOf({ [x0.id('hex')]: admission(x0.id('hex')) }, {})

    const bundle = await assemble(tip, store)

    expect(bundle.admissions).toHaveLength(1)
    expect(store.getAdmission).toHaveBeenCalledTimes(1)
  })

  it('carries a frontier with no stored linkage without inventing one, and still walks past it', async () => {
    const g = tokenTx([100])
    const x = tokenTx([100], [{ tx: g, vout: 0 }])
    const tip = throughBeef(tokenTx([100], [{ tx: x, vout: 0 }]))
    const store = storeOf({ [g.id('hex')]: admission(g.id('hex')) }, {})

    const bundle = await assemble(tip, store)

    expect(bundle.linkage).toEqual([])
    expect(bundle.admissions.map(a => a.txid)).toEqual([g.id('hex')])
  })

  it('reports the tip txid, asset and overlay it was assembled for', async () => {
    const tip = throughBeef(tokenTx([100]))
    const bundle = await assemble(tip, storeOf({}, {}))
    expect(bundle.tipTxid).toBe(tip.id('hex'))
    expect(bundle.assetId).toBe(ASSET)
    expect(bundle.overlayIdentityKey).toBe(OVERLAY_KEY)
  })

  it('decodes the stored signature hex into the wire entry’s DER bytes', async () => {
    const x0 = tokenTx([100])
    const tip = throughBeef(tokenTx([100], [{ tx: x0, vout: 0 }]))
    const store = storeOf({ [x0.id('hex')]: admission(x0.id('hex')) }, {})

    const bundle = await assemble(tip, store)

    expect(Array.from(bundle.admissions[0].signature)).toEqual([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02])
  })
})

describe('coverFromFrame', () => {
  const okVerifier = jest.fn(
    async (): Promise<CoverResult> => ({ ok: true, mustSubmit: ['tip'] })
  )

  function tokenFrame(tip: Transaction, patch: Partial<PaymentFrame['token']> = {}): PaymentFrame {
    return {
      version: FRAME_VERSION,
      kind: 'token',
      senderIdentityKey: '02'.padEnd(66, 'a'),
      outputIndex: 0,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      token: {
        assetId: ASSET,
        overlayUrl: 'https://overlay.example',
        overlayIdentityKey: OVERLAY_KEY,
        certificates: [],
        linkage: [],
        admissions: [],
        ...patch
      },
      transaction: atomicBeef(tip)
    }
  }

  beforeEach(() => okVerifier.mockClear())

  it('hands the verifier the tip, its whole BEEF, and the frame’s own evidence', async () => {
    const x0 = tokenTx([100])
    const tip = tokenTx([100], [{ tx: x0, vout: 0 }])
    const frame = tokenFrame(tip, {
      linkage: [{ txid: x0.id('hex'), payload: new Uint8Array([7]) }],
      admissions: [
        { txid: x0.id('hex'), outputsToAdmit: [0], signature: new Uint8Array([0x30]), signerKey: OVERLAY_KEY }
      ]
    })

    const result = await coverFromFrame(frame, okVerifier)

    expect(result).toEqual({ ok: true, mustSubmit: ['tip'] })
    const [tipArg, bundle] = okVerifier.mock.calls[0] as unknown as [CoverTip, CoverBundle]
    expect(tipArg.txid).toBe(tip.id('hex'))
    expect(bundle.assetId).toBe(ASSET)
    expect(bundle.overlayIdentityKey).toBe(OVERLAY_KEY)
    expect(bundle.beef.get(x0.id('hex'))).toBeDefined()
    expect(bundle.beef.get(tip.id('hex'))).toBeDefined()
    expect(bundle.admissions.get(x0.id('hex'))?.signerKey).toBe(OVERLAY_KEY)
    expect(Array.from(bundle.linkage.get(x0.id('hex')) as Uint8Array)).toEqual([7])
  })

  it('returns the verifier’s refusal verbatim', async () => {
    const verifier = jest.fn(async (): Promise<CoverResult> => ({ ok: false, reason: 'uncovered_ancestor' }))
    const result = await coverFromFrame(tokenFrame(tokenTx([100])), verifier)
    expect(result).toEqual({ ok: false, reason: 'uncovered_ancestor' })
  })

  // A frame that is not a token frame, or whose bytes are not a transaction,
  // never reaches the verifier: there is nothing to walk, and calling the
  // verifier with a fabricated tip would ask it to answer about nothing.
  it('refuses a non-token frame as a shape failure, without calling the verifier', async () => {
    const frame = { ...tokenFrame(tokenTx([100])), kind: 'bsv' as const, token: undefined }
    await expect(coverFromFrame(frame, okVerifier)).resolves.toEqual({ ok: false, reason: 'shape' })
    expect(okVerifier).not.toHaveBeenCalled()
  })

  it('refuses unreadable transaction bytes as a shape failure', async () => {
    const frame = { ...tokenFrame(tokenTx([100])), transaction: new Uint8Array([1, 2, 3]) }
    await expect(coverFromFrame(frame, okVerifier)).resolves.toEqual({ ok: false, reason: 'shape' })
    expect(okVerifier).not.toHaveBeenCalled()
  })

  // The verifier is injected and may be a third party's; a throw out of it is
  // a refusal, never an exception that escapes into the settle path.
  it('reports a throwing verifier as a shape refusal', async () => {
    const verifier = jest.fn(async (): Promise<CoverResult> => { throw new Error('boom') })
    await expect(coverFromFrame(tokenFrame(tokenTx([100])), verifier)).resolves.toEqual({
      ok: false,
      reason: 'shape'
    })
  })

  it('accepts a locking script the SDK cannot decode as a token without throwing', async () => {
    const tip = new Transaction()
    tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('76a914' + '00'.repeat(20) + '88ac') })
    await expect(coverFromFrame(tokenFrame(tip), okVerifier)).resolves.toEqual({ ok: true, mustSubmit: ['tip'] })
  })
})
