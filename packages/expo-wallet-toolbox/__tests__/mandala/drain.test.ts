/**
 * The submit-then-broadcast drain, and the evidence cache it re-derives.
 *
 * Two things are pinned here and nowhere else:
 *
 *  · FIX G — every row of the four settlement tables is re-derivable, offline
 *    and idempotently, from the frame bytes already durable in
 *    `localpay_pending` / `offline_actions.framePayload`. So the population
 *    step runs against REAL SQLite and is asserted to be a no-op on its second
 *    run rather than a duplicate-key throw.
 *  · FIX D — the overlay is the only authority on a FINAL refusal. A cover
 *    hole, a liftable refusal and a 503 all have to come back as
 *    `serviceError` and leave every row non-terminal; only `refused`/`evicted`
 *    may burn a row, and then the tip goes with it.
 */
import { DatabaseSync } from 'node:sqlite'
import { BigNumber, Beef, ECDSA, Hash, LockingScript, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { admissionDigestV2, payloadHash, verifyAdmission } from '@bsv/mandala'
import { createTables } from '../../core/storage/schema/createTables'
import { createSettlementStore, type SettlementDb } from '../../core/mandala/settlementStore'
import {
  deriveTokenEdges,
  listStuckSettlements,
  isRetriableInternalizeFailure,
  populateEvidenceFromFrame,
  postTokenStep,
  reconcileSettlements,
  type EvidenceFrame,
  type TokenStepDeps
} from '../../core/mandala/drain'
import {
  STUCK_AFTER_MS,
  type AdmissionEntryWire,
  type AdmissionVerifier,
  type CoverResult,
  type OverlayVerdict,
  type SettlementStore
} from '../../core/mandala/types'

function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]))
  }
}

const OVERLAY = 'https://overlay.issuer.example'
/**
 * A REAL overlay keypair, not a 66-hex placeholder.
 *
 * Every "this admission may skip a submit" assertion below is now a statement
 * about a signature that actually verifies — which is the whole of FIX H. A
 * fixed private key keeps the vectors deterministic.
 */
const OVERLAY_PRIV = PrivateKey.fromHex('11'.repeat(32))
const OVERLAY_KEY = OVERLAY_PRIV.toPublicKey().toString()

/** σ_I exactly as an overlay mints it: DER ECDSA over admissionDigestV2. */
function signAdmission(txid: string, outputsToAdmit: number[], priv = OVERLAY_PRIV): Uint8Array {
  const digest = admissionDigestV2(txid, outputsToAdmit)
  return new Uint8Array(ECDSA.sign(new BigNumber(digest, 16), priv).toDER() as number[])
}

/** The wallet's FIX H verifier, bound to the configured key like the runtime's. */
const verifier: AdmissionVerifier = (entry: AdmissionEntryWire) =>
  verifyAdmission({
    txid: entry.txid,
    outputsToAdmit: entry.outputsToAdmit,
    signature: Array.from(entry.signature),
    signerKey: entry.signerKey
  })

/** What every trusting caller passes: the configured key plus the verifier. */
const anchor = { overlayIdentityKey: OVERLAY_KEY, verifyAdmission: verifier }

const ASSET_ID = 'ab'.repeat(32) + '.0'
const OTHER_ASSET = 'cc'.repeat(32) + '.1'
const pkh = () => Hash.hash160(Utils.toArray(PrivateKey.fromRandom().toPublicKey().toString(), 'hex'))

const tokenScript = (amount: number, assetId = ASSET_ID) => new MandalaToken().lock(assetId, amount, pkh())

/** A transaction spending `parents`, with one token output and one plain output. */
function txSpending(parents: { tx: Transaction; vout: number }[], amount = 100, assetId = ASSET_ID): Transaction {
  const tx = new Transaction()
  for (const p of parents) {
    tx.addInput({
      sourceTransaction: p.tx,
      sourceOutputIndex: p.vout,
      unlockingScript: UnlockingScript.fromHex('')
    })
  }
  tx.addOutput({ satoshis: 1, lockingScript: tokenScript(amount, assetId) })
  tx.addOutput({ satoshis: 1000, lockingScript: LockingScript.fromHex('51') })
  return tx
}

/** A root token transaction: no inputs the walk can follow. */
function rootTx(amount = 100, assetId = ASSET_ID): Transaction {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: tokenScript(amount, assetId) })
  return tx
}

function beefOf(txs: Transaction[], tipTxid: string): Uint8Array {
  const beef = new Beef()
  for (const t of txs) beef.mergeTransaction(t)
  return new Uint8Array(beef.toBinaryAtomic(tipTxid))
}

let raw: DatabaseSync
let store: SettlementStore

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  await createTables(adapt(raw) as never)
  store = createSettlementStore(adapt(raw) as unknown as SettlementDb)
})

afterEach(() => raw.close())

// ─────────────────────────── evidence (FIX G) ───────────────────────────

describe('deriveTokenEdges', () => {
  it('records one edge per TOKEN input of the named asset, through the whole beef', () => {
    const g = rootTx(300)
    const x = txSpending([{ tx: g, vout: 0 }], 200)
    const t = txSpending([{ tx: x, vout: 0 }], 100)

    const edges = deriveTokenEdges(beefOf([g, x, t], t.id('hex')), ASSET_ID)

    expect(edges).toEqual(
      expect.arrayContaining([
        { childTxid: x.id('hex'), parentTxid: g.id('hex'), parentVout: 0 },
        { childTxid: t.id('hex'), parentTxid: x.id('hex'), parentVout: 0 }
      ])
    )
    expect(edges).toHaveLength(2)
  })

  // FIX K: a fresh BSV change output funding the fee is not a token ancestor.
  // Walking it would refuse the ordinary "the payer just spent their own
  // unconfirmed change" case.
  it('never walks a non-token input', () => {
    const fee = rootTx(1) // its vout 1 is a plain script
    const g = rootTx(300)
    const t = txSpending(
      [
        { tx: g, vout: 0 },
        { tx: fee, vout: 0 }
      ],
      100
    )
    // fee's vout 0 IS a token script, so swap it for a plain-script parent:
    const plain = new Transaction()
    plain.addOutput({ satoshis: 500, lockingScript: LockingScript.fromHex('51') })
    const t2 = txSpending(
      [
        { tx: g, vout: 0 },
        { tx: plain, vout: 0 }
      ],
      100
    )

    const edges = deriveTokenEdges(beefOf([g, plain, t2], t2.id('hex')), ASSET_ID)
    expect(edges).toEqual([{ childTxid: t2.id('hex'), parentTxid: g.id('hex'), parentVout: 0 }])
    expect(t.id('hex')).toEqual(expect.any(String))
  })

  it('never walks a token input of a DIFFERENT asset', () => {
    const other = rootTx(50, OTHER_ASSET)
    const t = txSpending([{ tx: other, vout: 0 }], 50, ASSET_ID)
    expect(deriveTokenEdges(beefOf([other, t], t.id('hex')), ASSET_ID)).toEqual([])
  })

  it('returns nothing rather than throwing for bytes that are not a beef', () => {
    expect(deriveTokenEdges(new Uint8Array([0, 1, 2]), ASSET_ID)).toEqual([])
  })
})

describe('populateEvidenceFromFrame', () => {
  const g = rootTx(300)
  const x = txSpending([{ tx: g, vout: 0 }], 200)
  const tip = txSpending([{ tx: x, vout: 0 }], 100)

  const frame = (over: Partial<EvidenceFrame['token']> = {}): EvidenceFrame => ({
    kind: 'token',
    transaction: beefOf([g, x, tip], tip.id('hex')),
    token: {
      assetId: ASSET_ID,
      overlayUrl: OVERLAY,
      overlayIdentityKey: OVERLAY_KEY,
      linkage: [{ txid: x.id('hex'), payload: new Uint8Array([7, 7, 7]) }],
      admissions: [
        { txid: g.id('hex'), outputsToAdmit: [0], signature: signAdmission(g.id('hex'), [0]), signerKey: OVERLAY_KEY }
      ],
      ...over
    }
  })

  it('caches admissions, linkage and edges from one frame', async () => {
    const r = await populateEvidenceFromFrame(store, frame(), anchor)

    expect(r).toMatchObject({ admissions: 1, linkage: 1, edges: 2, admissionsDropped: 0, errors: [] })
    expect(await store.getAdmission(g.id('hex'))).toMatchObject({
      outputsToAdmit: [0],
      signatureHex: Utils.toHex(Array.from(signAdmission(g.id('hex'), [0]))),
      signerKey: OVERLAY_KEY,
      source: 'bundle'
    })
    expect(await store.getLinkage(x.id('hex'))).toMatchObject({ overlayUrl: OVERLAY, source: 'forwarded' })
    expect(await store.parentsOf(tip.id('hex'))).toEqual([
      { childTxid: tip.id('hex'), parentTxid: x.id('hex'), parentVout: 0 }
    ])
  })

  // The crash-safety guarantee: the drain re-runs this on EVERY pass, in any
  // order, over any subset already done.
  it('is idempotent — a second pass writes nothing and throws nothing', async () => {
    await populateEvidenceFromFrame(store, frame(), anchor)
    const r = await populateEvidenceFromFrame(store, frame(), anchor)
    expect(r.errors).toEqual([])
    expect((raw.prepare('SELECT COUNT(*) AS n FROM token_admission_edges').get() as { n: number }).n).toBe(2)
    expect((raw.prepare('SELECT COUNT(*) AS n FROM token_admissions').get() as { n: number }).n).toBe(1)
  })

  it('ignores a frame with no token block', async () => {
    const r = await populateEvidenceFromFrame(store, { kind: 'bsv', transaction: new Uint8Array() })
    expect(r).toMatchObject({ admissions: 0, linkage: 0, edges: 0 })
  })

  // The v4 `admissions[]` field is landing concurrently in the codec. A v3
  // frame must still populate linkage and edges.
  it('works on a frame whose codec has no admissions[] field yet', async () => {
    const r = await populateEvidenceFromFrame(store, frame({ admissions: undefined }), anchor)
    expect(r).toMatchObject({ admissions: 0, linkage: 1, edges: 2 })
  })

  // FIX H. The cache is not a transcript of what a counterparty said: an entry
  // that lands here can later SKIP a /submit and is forwarded on to the next
  // hop as this device's own claim, so a forged one strands a payment that was
  // never admitted — and propagates the lie.
  it('drops an admission signed by a key that is not the configured overlay’s', async () => {
    const impostor = PrivateKey.fromHex('22'.repeat(32))
    const r = await populateEvidenceFromFrame(
      store,
      frame({
        admissions: [
          {
            txid: g.id('hex'),
            outputsToAdmit: [0],
            signature: signAdmission(g.id('hex'), [0], impostor),
            signerKey: impostor.toPublicKey().toString()
          }
        ]
      }),
      anchor
    )
    expect(r).toMatchObject({ admissions: 0, admissionsDropped: 1, errors: [] })
    expect(await store.getAdmission(g.id('hex'))).toBeUndefined()
  })

  // The dangerous shape: the right signer key, a signature that PARSES, and
  // nothing behind it. Only the cryptographic check separates this from the
  // real thing.
  it('drops a well-formed admission whose σ_I does not verify', async () => {
    const forged = signAdmission(g.id('hex'), [0], PrivateKey.fromHex('33'.repeat(32)))
    const r = await populateEvidenceFromFrame(
      store,
      frame({
        admissions: [
          { txid: g.id('hex'), outputsToAdmit: [0], signature: forged, signerKey: OVERLAY_KEY }
        ]
      }),
      anchor
    )
    expect(r).toMatchObject({ admissions: 0, admissionsDropped: 1, errors: [] })
    expect(await store.getAdmission(g.id('hex'))).toBeUndefined()
  })

  // A σ_I over a DIFFERENT admitted set than the one claimed — the phantom-coin
  // shape the digest binds against (FIX A).
  it('drops an admission whose signature covers a different output set', async () => {
    const r = await populateEvidenceFromFrame(
      store,
      frame({
        admissions: [
          { txid: g.id('hex'), outputsToAdmit: [0, 1], signature: signAdmission(g.id('hex'), [0]), signerKey: OVERLAY_KEY }
        ]
      }),
      anchor
    )
    expect(r).toMatchObject({ admissions: 0, admissionsDropped: 1 })
  })

  // "No verifier" is "no evidence" — never "trust it".
  it('caches nothing when no verifier is supplied, and still caches linkage and edges', async () => {
    const r = await populateEvidenceFromFrame(store, frame())
    expect(r).toMatchObject({ admissions: 0, admissionsDropped: 1, linkage: 1, edges: 2 })
    expect(await store.getAdmission(g.id('hex'))).toBeUndefined()
  })

  // Population is a cache step, never on the critical path between "frame
  // received" and "ack sent" — so it reports failures rather than throwing
  // them at a caller that has already promised the money.
  it('reports a store failure rather than throwing it', async () => {
    const broken: SettlementStore = {
      ...store,
      putAdmission: async () => {
        throw new Error('db locked')
      }
    }
    const r = await populateEvidenceFromFrame(broken, frame(), anchor)
    expect(r.errors.join(' ')).toMatch(/db locked/)
    expect(r.linkage).toBe(1)
  })
})

describe('reconcileSettlements', () => {
  const g = rootTx(300)
  const tip = txSpending([{ tx: g, vout: 0 }], 100)
  const source = {
    txid: tip.id('hex'),
    role: 'received' as const,
    frame: {
      kind: 'token',
      transaction: beefOf([g, tip], tip.id('hex')),
      token: {
        assetId: ASSET_ID,
        overlayUrl: OVERLAY,
        overlayIdentityKey: OVERLAY_KEY,
        linkage: [],
        admissions: []
      }
    } as EvidenceFrame
  }

  // FIX I: a settlement row is owned by the drain, so a frame that lost its
  // row (or never got one) has it re-derived rather than being abandoned.
  it('derives a missing settlement row from the frame', async () => {
    const r = await reconcileSettlements({ store, sources: [source] })
    expect(r.derived).toBe(1)
    expect(await store.getSettlement(tip.id('hex'))).toMatchObject({
      role: 'received',
      state: 'held',
      assetId: ASSET_ID,
      overlayUrl: OVERLAY,
      overlayIdentityKey: OVERLAY_KEY
    })
  })

  it('defaults a payer-side frame to handed_over', async () => {
    await reconcileSettlements({ store, sources: [{ ...source, role: 'sent' }] })
    expect((await store.getSettlement(tip.id('hex')))?.state).toBe('handed_over')
  })

  it('leaves an existing row’s state alone on every later pass', async () => {
    await reconcileSettlements({ store, sources: [source] })
    await store.advanceSettlement(tip.id('hex'), ['held'], 'admitted')
    const r = await reconcileSettlements({ store, sources: [source] })
    expect(r.derived).toBe(0)
    expect((await store.getSettlement(tip.id('hex')))?.state).toBe('admitted')
  })

  it('carries on past a source it cannot read', async () => {
    const bad = { ...source, txid: 'ff'.repeat(32), frame: { ...source.frame, transaction: new Uint8Array([1]) } }
    const r = await reconcileSettlements({ store, sources: [bad, source] })
    expect(r.derived).toBe(2)
  })
})

// ───────────────────────────── the drain ─────────────────────────────

const TIP = 'aa'.repeat(32)
const ANCESTOR = 'bb'.repeat(32)

/** A real σ_I: the drain now refuses an admitted verdict its anchor cannot verify. */
const admitted = (txid: string): OverlayVerdict => ({
  kind: 'admitted',
  outputsToAdmit: [0],
  signatureHex: Utils.toHex(Array.from(signAdmission(txid, [0]))),
  signerKey: OVERLAY_KEY
})

async function seed(state: 'held' | 'handed_over' = 'held', role: 'sent' | 'received' = 'received') {
  await store.upsertSettlement({
    txid: TIP,
    role,
    assetId: ASSET_ID,
    state,
    overlayUrl: OVERLAY,
    overlayIdentityKey: OVERLAY_KEY
  })
  await store.upsertSettlement({
    txid: ANCESTOR,
    role,
    assetId: ASSET_ID,
    state,
    overlayUrl: OVERLAY,
    overlayIdentityKey: OVERLAY_KEY
  })
  return (await store.getSettlement(TIP))!
}

function deps(over: Partial<TokenStepDeps> = {}): TokenStepDeps & {
  submitted: string[]
  broadcasts: string[]
} {
  const submitted: string[] = []
  const broadcasts: string[] = []
  return {
    store,
    cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [ANCESTOR, TIP] }),
    submit: async (txid: string) => {
      submitted.push(txid)
      return admitted(txid)
    },
    broadcast: async (txid: string) => {
      broadcasts.push(txid)
      return 'success' as const
    },
    submitted,
    broadcasts,
    ...over
  }
}

const step = { txid: TIP, owned: true }

describe('postTokenStep', () => {
  it('submits every ancestor parents-first, then broadcasts the tip exactly once', async () => {
    const settlement = await seed()
    const d = deps()

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('success')

    expect(d.submitted).toEqual([ANCESTOR, TIP])
    expect(d.broadcasts).toEqual([TIP])
    expect((await store.getSettlement(TIP))?.state).toBe('broadcast')
    expect(await store.getSettlement(ANCESTOR)).toMatchObject({ state: 'admitted' })
  })

  it('records every admission it is handed, as first-hand evidence', async () => {
    const settlement = await seed()
    await postTokenStep(deps(), settlement, step)
    expect(await store.getAdmission(TIP)).toMatchObject({ source: 'submitted', signerKey: OVERLAY_KEY })
    const verdict = admitted(TIP)
    expect((await store.getSettlement(TIP))?.admissionSignatureHex).toBe(
      verdict.kind === 'admitted' ? verdict.signatureHex : ''
    )
  })

  // FIX D: a hole in the local evidence is never a local refusal. The row
  // stays exactly where it was and the next pass tries again.
  it('returns serviceError and touches nothing when COVER does not close', async () => {
    const settlement = await seed()
    const d = deps({ cover: async (): Promise<CoverResult> => ({ ok: false, reason: 'uncovered_ancestor' }) })

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('serviceError')
    expect(d.submitted).toEqual([])
    expect(d.broadcasts).toEqual([])
    expect((await store.getSettlement(TIP))?.state).toBe('held')
  })

  // 2026-09-16 incident: a tip the overlay had already ADMITTED sat at
  // `admitted` forever because COVER kept reporting a hole in its ancestry.
  // The overlay's σ_I over the tip is its ruling on that whole ancestry — a
  // hole in local evidence cannot outrank it. Broadcast, do not re-walk.
  it('broadcasts a tip whose own cached σ_I verifies, even when COVER does not close', async () => {
    const settlement = await seed('handed_over', 'sent')
    await store.advanceSettlement(TIP, ['handed_over'], 'admitted')
    await store.putAdmission({
      txid: TIP,
      outputsToAdmit: [0],
      signatureHex: Utils.toHex(Array.from(signAdmission(TIP, [0]))),
      signerKey: OVERLAY_KEY,
      source: 'submitted',
      obtainedAt: 'now'
    })
    const d = deps({ ...anchor, cover: async (): Promise<CoverResult> => ({ ok: false, reason: 'uncovered_ancestor' }) })

    await expect(postTokenStep(d, (await store.getSettlement(TIP))!, step)).resolves.toBe('success')
    expect(d.submitted).toEqual([])
    expect(d.broadcasts).toEqual([TIP])
    expect((await store.getSettlement(TIP))?.state).toBe('broadcast')
  })

  it('still walks COVER when the tip’s cached σ_I does not verify', async () => {
    const settlement = await seed('handed_over', 'sent')
    await store.advanceSettlement(TIP, ['handed_over'], 'admitted')
    await store.putAdmission({
      txid: TIP,
      outputsToAdmit: [0],
      signatureHex: Utils.toHex(Array.from(signAdmission(TIP, [0], PrivateKey.fromHex('44'.repeat(32))))),
      signerKey: OVERLAY_KEY,
      source: 'submitted',
      obtainedAt: 'now'
    })
    const d = deps({ ...anchor, cover: async (): Promise<CoverResult> => ({ ok: false, reason: 'uncovered_ancestor' }) })

    await expect(postTokenStep(d, (await store.getSettlement(TIP))!, step)).resolves.toBe('serviceError')
    expect(d.broadcasts).toEqual([])
    void settlement
  })

  /** Cache one admission for ANCESTOR, exactly as a bundle or a submit would. */
  const cacheAdmission = async (signature: Uint8Array, signerKey = OVERLAY_KEY, outputsToAdmit = [0]) =>
    await store.putAdmission({
      txid: ANCESTOR,
      outputsToAdmit,
      signatureHex: Utils.toHex(Array.from(signature)),
      signerKey,
      source: 'bundle',
      obtainedAt: 'now'
    })

  // The only skip the drain is allowed: a σ_I that VERIFIES, against the
  // wallet's own configured key. Signed here for real, so this test fails if
  // the cryptographic check is ever removed again.
  it('skips an ancestor whose cached σ_I verifies against the configured overlay key', async () => {
    const settlement = await seed()
    await cacheAdmission(signAdmission(ANCESTOR, [0]))
    const d = deps(anchor)

    await postTokenStep(d, settlement, step)

    expect(d.submitted).toEqual([TIP])
    expect((await store.getSettlement(ANCESTOR))?.state).toBe('admitted')
  })

  // FIX H, the case a structural check cannot see: right signer key, DER that
  // parses, and no overlay behind it. Skipping here would mark an ancestor
  // `admitted` from a lie and broadcast a chain the overlay has never seen.
  it('submits anyway when a well-formed cached signature does not verify', async () => {
    const settlement = await seed()
    await cacheAdmission(signAdmission(ANCESTOR, [0], PrivateKey.fromHex('44'.repeat(32))))
    const d = deps(anchor)

    await postTokenStep(d, settlement, step)

    expect(d.submitted).toEqual([ANCESTOR, TIP])
    expect((await store.getSettlement(ANCESTOR))?.state).toBe('admitted')
  })

  // The signature is genuine but covers a different admitted set than the row
  // claims — the phantom-coin shape the digest binds against (FIX A).
  it('submits anyway when the cached signature covers a different output set', async () => {
    const settlement = await seed()
    await cacheAdmission(signAdmission(ANCESTOR, [0]), OVERLAY_KEY, [0, 1])
    const d = deps(anchor)
    await postTokenStep(d, settlement, step)
    expect(d.submitted).toEqual([ANCESTOR, TIP])
  })

  it('does not skip on an admission signed by a key that is not the configured overlay’s', async () => {
    const settlement = await seed()
    const impostor = PrivateKey.fromHex('55'.repeat(32))
    await cacheAdmission(signAdmission(ANCESTOR, [0], impostor), impostor.toPublicKey().toString())
    const d = deps(anchor)
    await postTokenStep(d, settlement, step)
    expect(d.submitted).toEqual([ANCESTOR, TIP])
  })

  // Absent a verifier there is nothing to check a σ_I with, so nothing may be
  // believed. Submitting is free — /submit is idempotent (FIX C) — and always
  // correct; skipping on an unchecked value never is.
  it('never skips when no verifier is injected, even for a genuine σ_I', async () => {
    const settlement = await seed()
    await cacheAdmission(signAdmission(ANCESTOR, [0]))
    const d = deps()

    await postTokenStep(d, settlement, step)

    expect(d.submitted).toEqual([ANCESTOR, TIP])
  })

  // Wire contract §9.10: the anchor is the wallet's CONFIGURED key. The row's
  // own `overlayIdentityKey` is re-derived from counterparty frame bytes, so a
  // frame that names its own signer must not be able to nominate itself.
  it('anchors on deps.overlayIdentityKey, never on the settlement row’s own column', async () => {
    const impostor = PrivateKey.fromHex('66'.repeat(32))
    const impostorKey = impostor.toPublicKey().toString()
    // The row claims the impostor IS the overlay, and the cached σ_I verifies
    // against that claim perfectly.
    await store.upsertSettlement({
      txid: TIP,
      role: 'received',
      assetId: ASSET_ID,
      state: 'held',
      overlayUrl: OVERLAY,
      overlayIdentityKey: impostorKey
    })
    await store.upsertSettlement({
      txid: ANCESTOR,
      role: 'received',
      assetId: ASSET_ID,
      state: 'held',
      overlayUrl: OVERLAY,
      overlayIdentityKey: impostorKey
    })
    await cacheAdmission(signAdmission(ANCESTOR, [0], impostor), impostorKey)
    const d = deps(anchor)

    await postTokenStep(d, (await store.getSettlement(TIP))!, step)

    expect(d.submitted).toEqual([ANCESTOR, TIP])
  })

  // A liftable refusal or a 503 must not partially advance a chain — the whole
  // prefix is retried next pass, which is safe because /submit is idempotent.
  it('stops the whole step on an unavailable verdict and restores the ancestor’s own state', async () => {
    const settlement = await seed()
    const d = deps({
      submit: async (txid: string): Promise<OverlayVerdict> =>
        txid === ANCESTOR ? { kind: 'unavailable', code: 'ERR_PAUSED', retryable: true } : admitted(txid)
    })

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('serviceError')
    expect(d.broadcasts).toEqual([])
    expect((await store.getSettlement(ANCESTOR))?.state).toBe('held')
    expect((await store.getSettlement(TIP))?.state).toBe('held')
  })

  it('refuses the step and poisons the tip when an ancestor is refused', async () => {
    const settlement = await seed()
    const d = deps({
      submit: async (txid: string): Promise<OverlayVerdict> =>
        txid === ANCESTOR ? { kind: 'refused', code: 'ERR_CONSERVATION' } : admitted(txid)
    })

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('invalidTx')
    expect(d.broadcasts).toEqual([])
    expect(await store.getSettlement(ANCESTOR)).toMatchObject({ state: 'refused', refusedCode: 'ERR_CONSERVATION' })
    expect(await store.getSettlement(TIP)).toMatchObject({ state: 'orphaned', poisonedByTxid: ANCESTOR })
  })

  // Amendment §9.1/§9.3: a persisted refusal is keyed by (txid, payloadHash),
  // not by txid alone, so the row that owns the token payment's state needs
  // to know WHICH payload was refused, not only that the txid was.
  it('records the payloadHash of the refused ancestor’s own linkage bytes, so the UI can show "refused for this payload"', async () => {
    const settlement = await seed()
    const payloadBytes = Uint8Array.from([9, 8, 7, 6])
    await store.putLinkage({
      txid: ANCESTOR,
      payloadBytes,
      overlayUrl: OVERLAY,
      overlayIdentityKey: OVERLAY_KEY,
      source: 'forwarded',
      createdAt: new Date().toISOString()
    })
    const d = deps({
      submit: async (txid: string): Promise<OverlayVerdict> =>
        txid === ANCESTOR ? { kind: 'refused', code: 'ERR_CONSERVATION' } : admitted(txid)
    })

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('invalidTx')
    expect(await store.getSettlement(ANCESTOR)).toMatchObject({
      state: 'refused',
      refusedCode: 'ERR_CONSERVATION',
      refusedPayloadHash: payloadHash(payloadBytes)
    })
  })

  it('leaves refusedPayloadHash unset — never a guess — when this device holds no linkage bytes for the refused ancestor', async () => {
    const settlement = await seed()
    const d = deps({
      submit: async (txid: string): Promise<OverlayVerdict> =>
        txid === ANCESTOR ? { kind: 'refused', code: 'ERR_CONSERVATION' } : admitted(txid)
    })

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('invalidTx')
    expect((await store.getSettlement(ANCESTOR))?.refusedPayloadHash).toBeUndefined()
  })

  it('orphans the tip when an ancestor was admitted and then evicted', async () => {
    const settlement = await seed()
    const d = deps({
      submit: async (txid: string): Promise<OverlayVerdict> =>
        txid === ANCESTOR ? { kind: 'evicted' } : admitted(txid)
    })

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('doubleSpend')
    expect((await store.getSettlement(ANCESTOR))?.state).toBe('orphaned')
    expect(await store.getSettlement(TIP)).toMatchObject({ state: 'orphaned', poisonedByTxid: ANCESTOR })
  })

  it('refuses the tip itself without inventing a poisoner', async () => {
    const settlement = await seed()
    const d = deps({
      submit: async (txid: string): Promise<OverlayVerdict> =>
        txid === TIP ? { kind: 'refused', code: 'ERR_LINKAGE' } : admitted(txid)
    })

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('invalidTx')
    expect(await store.getSettlement(TIP)).toMatchObject({ state: 'refused', refusedCode: 'ERR_LINKAGE' })
    expect((await store.getSettlement(TIP))?.poisonedByTxid).toBeUndefined()
  })

  // The tip is broadcast EXACTLY as a BSV tx: whatever the injected post
  // reports is what the step reports, so the unchanged applyOutcome/cascade
  // sees the shape it already handles.
  it('passes a failed broadcast straight through and leaves the row short of broadcast', async () => {
    const settlement = await seed()
    const d = deps({ broadcast: async () => 'serviceError' as const })

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('serviceError')
    expect((await store.getSettlement(TIP))?.state).toBe('admitted')
  })

  /**
   * The lib's tx journal, and who is allowed to clear an entry from it.
   *
   * `@bsv/mandala` journals `'accepted'` and then broadcasts through
   * `createAction({ sendWith })` — which in this wallet is HELD by guard #2,
   * because the drain owns the broadcast. So the only honest place to clear
   * the entry is here, the moment the tip really reaches the network. Clearing
   * it anywhere else is the 2026-09-15 bug (an entry cleared for a broadcast
   * that never happened, and a live noSend action the next sweep took for
   * abandoned); never clearing it is a reconcile pass that rebroadcasts behind
   * the drain's back.
   */
  describe('the lib’s journal entry', () => {
    it('is cleared for a tip this step really broadcast', async () => {
      const settlement = await seed()
      const journalRemove = jest.fn(async () => undefined)
      const d = deps({ journalRemove })

      await expect(postTokenStep(d, settlement, step)).resolves.toBe('success')
      expect(journalRemove).toHaveBeenCalledTimes(1)
      expect(journalRemove).toHaveBeenCalledWith(TIP)
    })

    it('is left alone when the broadcast did not happen', async () => {
      const settlement = await seed()
      const journalRemove = jest.fn(async () => undefined)
      const d = deps({ journalRemove, broadcast: async () => 'serviceError' as const })

      await expect(postTokenStep(d, settlement, step)).resolves.toBe('serviceError')
      expect(journalRemove).not.toHaveBeenCalled()
    })

    it('is left alone when a verdict burned the row before any broadcast', async () => {
      const settlement = await seed()
      const journalRemove = jest.fn(async () => undefined)
      const d = deps({
        journalRemove,
        submit: async () => ({ kind: 'refused', code: 'ERR_CONSERVATION' }) as OverlayVerdict
      })

      await expect(postTokenStep(d, settlement, step)).resolves.toBe('invalidTx')
      expect(journalRemove).not.toHaveBeenCalled()
    })

    it('never turns a delivered payment into a failure when the clear throws', async () => {
      const settlement = await seed()
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const d = deps({
        journalRemove: async () => {
          throw new Error('the wallet database is not open')
        }
      })

      await expect(postTokenStep(d, settlement, step)).resolves.toBe('success')
      expect((await store.getSettlement(TIP))?.state).toBe('broadcast')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(TIP), expect.any(String))
      warn.mockRestore()
    })
  })

  it('resumes a row interrupted mid-submit', async () => {
    const settlement = await seed()
    await store.advanceSettlement(TIP, ['held'], 'submitting')
    const d = deps()
    await expect(postTokenStep(d, { ...settlement, state: 'submitting' }, step)).resolves.toBe('success')
    expect((await store.getSettlement(TIP))?.state).toBe('broadcast')
  })

  // FIX F: a parked payment is one the payer walked away from. A drain that
  // submitted it would send money that was deliberately withheld.
  it('never submits a parked ancestor — it stalls the whole step instead', async () => {
    const settlement = await seed()
    raw.prepare('UPDATE token_settlements SET state = ? WHERE txid = ?').run('parked', ANCESTOR)
    const d = deps()

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('serviceError')
    expect(d.submitted).toEqual([])
    expect(d.broadcasts).toEqual([])
    expect((await store.getSettlement(ANCESTOR))?.state).toBe('parked')
  })

  // "Verdict wins": re-submitting would only fetch the same persisted refusal
  // back, so the tip is poisoned from local knowledge and no call is made.
  it('poisons the tip from an ancestor already known refused, without a network call', async () => {
    const settlement = await seed()
    await store.advanceSettlement(ANCESTOR, ['held'], 'refused', { refusedCode: 'ERR_SHAPE' })
    const d = deps()

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('invalidTx')
    expect(d.submitted).toEqual([])
    expect(await store.getSettlement(TIP)).toMatchObject({ state: 'orphaned', poisonedByTxid: ANCESTOR })
  })

  it('still submits an ancestor this device has no row for at all', async () => {
    const settlement = await seed()
    const foreign = 'cc'.repeat(32)
    const d = deps({ cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [foreign, TIP] }) })

    await expect(postTokenStep(d, settlement, step)).resolves.toBe('success')
    expect(d.submitted).toEqual([foreign, TIP])
    expect(await store.getAdmission(foreign)).toMatchObject({ source: 'submitted' })
  })
})

// ───────────────────────── FIX I / FIX M helpers ─────────────────────────

describe('isRetriableInternalizeFailure', () => {
  it('classifies a fresh-block header lag as retriable, never as abandonment', () => {
    expect(isRetriableInternalizeFailure('Block header not found for height 123456')).toBe(true)
    expect(isRetriableInternalizeFailure('Network request failed')).toBe(true)
  })

  it('does not excuse a structurally bad frame', () => {
    expect(isRetriableInternalizeFailure('invalid BEEF: unknown version')).toBe(false)
    expect(isRetriableInternalizeFailure(undefined)).toBe(false)
  })
})

describe('listStuckSettlements', () => {
  const old = new Date(Date.now() - STUCK_AFTER_MS - 1000).toISOString()

  async function row(txid: string, state: 'held' | 'broadcast' | 'refused', createdAt: string) {
    await store.upsertSettlement({
      txid,
      role: 'received',
      assetId: ASSET_ID,
      state,
      overlayUrl: OVERLAY,
      overlayIdentityKey: OVERLAY_KEY,
      createdAt
    })
  }

  it('surfaces a non-terminal row that has been waiting past the bound', async () => {
    await row(TIP, 'held', old)
    expect((await listStuckSettlements(store)).map(r => r.txid)).toEqual([TIP])
  })

  it('never names a terminal row, however old', async () => {
    await row(TIP, 'broadcast', old)
    await row(ANCESTOR, 'refused', old)
    expect(await listStuckSettlements(store)).toEqual([])
  })

  it('never names a row that is merely young', async () => {
    await row(TIP, 'held', new Date().toISOString())
    expect(await listStuckSettlements(store)).toEqual([])
  })
})
