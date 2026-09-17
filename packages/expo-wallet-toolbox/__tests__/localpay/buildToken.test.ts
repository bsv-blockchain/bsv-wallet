/**
 * The payer's token path (offline-settlement spec §9, payer steps 4–6).
 *
 * The one thing that makes this different from the BSV path, and the reason
 * most of these tests exist: the payer hands over the frame and submits
 * NOTHING. Settlement is the recipient's job (rule 3), with the payer's own
 * drain submitting too, optionally, whenever it next reconnects (rule 6). A
 * payer that submitted first would block a face-to-face payment on
 * connectivity — which is the whole thing this design exists to avoid — and a
 * payer that BROADCAST first would put an unadmitted token transaction on
 * chain, which the overlay can then only refuse.
 */
import { Beef, LockingScript, P2PKH, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import {
  buildPaymentFrame,
  finalizeDelivery,
  selectTokenCoins,
  type TokenBuildDeps
} from '../../core/localpay/build'
import { FRAME_VERSION, decodeFrame, encodeFrame } from '../../core/localpay/codec'
import { mintSession, type Session } from '../../core/localpay/session'
import { MANDALA_ACTION_LABEL, MANDALA_BASKET, type BundleStore } from '../../core/mandala/bundle'
import { FT_PROTOCOL_ID } from '../../core/localpay/verify'
import type { TokenAdmissionRow } from '../../core/mandala/types'

const ASSET = 'ab'.repeat(32) + '.0'
const OVERLAY_KEY = '03'.padEnd(66, 'b')
const OVERLAY_URL = 'https://overlay.issuer.example'
const PAYEE = '02'.padEnd(66, 'e')
const BLINDED_SENDER = '02'.padEnd(66, 'd')
const PKH = new Array(20).fill(9)

function tokenSession(): Session {
  return mintSession({
    identityKey: PAYEE,
    amount: 250,
    asset: { id: ASSET, overlayUrl: OVERLAY_URL, overlayIdentityKey: OVERLAY_KEY },
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    supportsAwdl: true
  })
}

/** A funded token coin sitting in the payer's basket. */
function coinTx(amounts: number[]): Transaction {
  const tx = new Transaction()
  for (const a of amounts) {
    tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET, a, PKH) })
  }
  return tx
}

function beefOf(txs: Transaction[]): number[] {
  const beef = new Beef()
  for (const tx of txs) beef.mergeTransaction(tx)
  return beef.toBinary()
}

const CI = (keyID: string) => JSON.stringify({ protocolID: FT_PROTOCOL_ID, keyID, counterparty: 'self' })

/**
 * The signable transaction createAction would hand back: our inputs in caller
 * order, our outputs in order (randomizeOutputs is off on this path).
 */
function signableFrom(
  coins: { tx: Transaction; vout: number }[],
  outputs: { script: string }[]
): { tx: Transaction; beef: number[] } {
  const tx = new Transaction()
  for (const c of coins) {
    tx.addInput({
      sourceTransaction: c.tx,
      sourceOutputIndex: c.vout,
      unlockingScript: new UnlockingScript([]),
      sequence: 0xffffffff
    })
  }
  for (const o of outputs) {
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(o.script) })
  }
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { tx, beef: beef.toBinary() }
}

function recipientScript(amount: number): string {
  return new MandalaToken().lock(ASSET, amount, PKH).toHex()
}

const emptyStore = (): BundleStore => ({
  getAdmission: jest.fn(async () => undefined),
  getLinkage: jest.fn(async () => undefined)
})

const admittedStore = (txid: string): BundleStore => ({
  getAdmission: jest.fn(
    async (t: string): Promise<TokenAdmissionRow | undefined> =>
      t === txid
        ? {
            txid,
            outputsToAdmit: [0],
            signatureHex: '3006020101020102',
            signerKey: OVERLAY_KEY,
            source: 'submitted',
            obtainedAt: '2026-01-01T00:00:00.000Z'
          }
        : undefined
  ),
  getLinkage: jest.fn(async () => undefined)
})

/** The D2 blinding seam. Returns A′ and the overlay-verifier linkage. */
function lockToPayee(): TokenBuildDeps['lockToPayee'] {
  return jest.fn(async (args: { assetId: string; amount: number }) => ({
    lockingScript: recipientScript(args.amount),
    senderIdentityKey: BLINDED_SENDER,
    linkage: { encryptedLinkage: [1, 2, 3], prover: BLINDED_SENDER },
    customInstructions: JSON.stringify({ direction: 'sent' })
  }))
}

function tokenWallet(coins: Transaction[], signable: { tx: Transaction; beef: number[] }) {
  const outs = coins.flatMap((tx, i) =>
    tx.outputs.map((o, vout) => ({
      outpoint: `${tx.id('hex')}.${vout}`,
      satoshis: 1,
      spendable: true,
      customInstructions: CI(`coin-${i}-${vout}`)
    }))
  )
  const signedBeef = () => {
    const beef = new Beef()
    beef.mergeTransaction(signable.tx)
    return Array.from(beef.toBinaryAtomic(signable.tx.id('hex')))
  }
  return {
    getPublicKey: jest.fn(async (args: { identityKey?: boolean }) =>
      args.identityKey ? { publicKey: '02'.padEnd(66, 'f') } : { publicKey: '03'.padEnd(66, 'a') }
    ),
    listOutputs: jest.fn(async (_args: unknown) => ({ totalOutputs: outs.length, outputs: outs, BEEF: beefOf(coins) })),
    createAction: jest.fn(async (_args: unknown) => ({
      signableTransaction: { reference: 'ref-token', tx: signable.beef }
    })),
    signAction: jest.fn(async (_args: unknown) => ({ tx: signedBeef(), txid: signable.tx.id('hex') })),
    abortAction: jest.fn(async () => ({ aborted: true })),
    createSignature: jest.fn(async (_args: unknown) => ({ signature: [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02] })),
    revealSpecificKeyLinkage: jest.fn(async (_args: unknown) => ({
      encryptedLinkage: [9],
      encryptedLinkageProof: [8],
      prover: '02'.padEnd(66, 'f'),
      verifier: OVERLAY_KEY,
      counterparty: 'self',
      protocolID: FT_PROTOCOL_ID,
      keyID: 'k',
      proofType: 0
    }))
  }
}

function deps(store: BundleStore = emptyStore()): TokenBuildDeps {
  return { store, lockToPayee: lockToPayee() }
}

describe('selectTokenCoins', () => {
  const coin = (amount: number, i: number) => ({
    outpoint: `${'aa'.repeat(32)}.${i}`,
    amount,
    keyID: `k${i}`,
    counterparty: 'self'
  })

  it('takes the fewest coins that cover the amount, largest first', () => {
    const { selected, total } = selectTokenCoins([coin(10, 0), coin(100, 1), coin(40, 2)], 45)
    expect(selected.map(s => s.amount)).toEqual([100])
    expect(total).toBe(100)
  })

  it('accumulates when no single coin covers it', () => {
    const { selected, total } = selectTokenCoins([coin(10, 0), coin(30, 1), coin(20, 2)], 45)
    expect(total).toBeGreaterThanOrEqual(45)
    expect(selected.length).toBeGreaterThan(1)
  })

  it('throws rather than under-funding', () => {
    expect(() => selectTokenCoins([coin(10, 0)], 45)).toThrow(/insufficient/i)
  })

  it('refuses an amount that is not a positive whole number of base units', () => {
    expect(() => selectTokenCoins([coin(100, 0)], 0)).toThrow()
    expect(() => selectTokenCoins([coin(100, 0)], 1.5)).toThrow()
  })
})

describe('buildPaymentFrame: token path', () => {
  function setup(coinAmounts = [400]) {
    const coins = [coinTx(coinAmounts)]
    const total = coinAmounts.reduce((a, b) => a + b, 0)
    const outputs = [{ script: recipientScript(250) }]
    if (total > 250) outputs.push({ script: new MandalaToken().lock(ASSET, total - 250, PKH).toHex() })
    const signable = signableFrom(coins.map(tx => ({ tx, vout: 0 })), outputs)
    return { coins, signable, wallet: tokenWallet(coins, signable) }
  }

  it('selects from the permission-routed token basket, with whole ancestor transactions', async () => {
    const { wallet } = setup()
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    expect(wallet.listOutputs).toHaveBeenCalledWith(
      expect.objectContaining({ basket: MANDALA_BASKET, include: 'entire transactions' }),
      'admin.com'
    )
  })

  it('honours an explicit basket override', async () => {
    const { wallet } = setup()
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, {
      ...deps(),
      basket: 'p other'
    })
    expect(wallet.listOutputs.mock.calls[0][0]).toMatchObject({ basket: 'p other' })
  })

  it('builds the action noSend and abortable, exactly as the BSV path does', async () => {
    const { wallet } = setup()
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    const args = wallet.createAction.mock.calls[0][0] as { options: unknown }
    expect(args.options).toEqual({ randomizeOutputs: false, noSend: true, signAndProcess: false })
  })

  // The home screen recognises a token row by the 'mandala' label alone — the
  // same label the lib's own handle-rail transfer writes. Without it a nearby
  // stablecoin payment rendered as a BSV row: the payee's abbreviated key over
  // "+0 sats", instead of "Sent USDX" over the token figure (2026-09-16). The
  // payee key stays on as a label too, for the resend path.
  it('labels the action as a token transfer, beside the rail and the payee key', async () => {
    const { wallet } = setup()
    const s = tokenSession()
    await buildPaymentFrame(wallet as never, s, 'admin.com', 250, deps())
    const args = wallet.createAction.mock.calls[0][0] as { labels: string[]; description: string }
    expect(args.labels).toContain(MANDALA_ACTION_LABEL)
    expect(args.labels).toContain(s.identityKey)
    expect(args.description).toBe('Sent token')
  })

  it('uses the payer’s note as the description when one is given', async () => {
    const { wallet } = setup()
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps(), 'thanks!')
    const args = wallet.createAction.mock.calls[0][0] as { description: string }
    expect(args.description).toBe('thanks!')
  })

  it('carries the note on the token frame too', async () => {
    const { wallet } = setup()
    const { frame } = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps(), 'thanks!')
    expect(frame.note).toBe('thanks!')
  })

  it('omits the note from the token frame when none is given', async () => {
    const { wallet } = setup()
    const { frame } = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    expect(frame.note).toBeUndefined()
  })

  it('finalizes through signAction with the token inputs it signed, still noSend', async () => {
    const { wallet } = setup()
    const built = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    const args = wallet.signAction.mock.calls[0][0] as {
      reference: string
      spends: Record<string, { unlockingScript: string }>
      options: unknown
    }
    expect(args.reference).toBe('ref-token')
    expect(args.options).toEqual({ noSend: true })
    expect(Object.keys(args.spends)).toEqual(['0'])
    expect(args.spends['0'].unlockingScript.length).toBeGreaterThan(0)
    expect(built.reference).toBe('ref-token')
  })

  it('signs each token input under the FT protocol with that coin’s own keyID', async () => {
    const { wallet } = setup()
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    expect(wallet.createSignature).toHaveBeenCalledWith(
      expect.objectContaining({ protocolID: FT_PROTOCOL_ID, keyID: 'coin-0-0' }),
      'admin.com'
    )
  })

  it('emits a v4 token frame naming the asset, overlay and payee output', async () => {
    const { wallet } = setup()
    const { frame } = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    expect(frame.version).toBe(FRAME_VERSION)
    expect(frame.kind).toBe('token')
    expect(frame.outputIndex).toBe(0)
    expect(frame.token).toMatchObject({
      assetId: ASSET,
      overlayUrl: OVERLAY_URL,
      overlayIdentityKey: OVERLAY_KEY
    })
  })

  // D2: the recipient derives against A′ and cannot join this payer's later
  // payments. The real identity key must never reach the wire in token mode.
  it('puts the blinded sender key on the wire, not the real identity key', async () => {
    const { wallet } = setup()
    const { frame } = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    expect(frame.senderIdentityKey).toBe(BLINDED_SENDER)
    expect(frame.senderIdentityKey).not.toBe('02'.padEnd(66, 'f'))
  })

  it('locks the payee output with the session’s own nonces as keyID', async () => {
    const { wallet } = setup()
    const session = tokenSession()
    const d = deps()
    await buildPaymentFrame(wallet as never, session, 'admin.com', 250, d)
    expect(d.lockToPayee).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: ASSET,
        amount: 250,
        recipientKey: session.identityKey,
        keyID: `${session.derivationPrefix} ${session.derivationSuffix}`
      })
    )
  })

  it('reports the token amount it actually sent, alongside the output’s satoshis', async () => {
    const { wallet } = setup()
    const built = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    expect(built.tokenAmount).toBe(250)
    expect(built.satoshis).toBe(1)
  })

  it('locks change back to this device when the coins overshoot', async () => {
    const { wallet } = setup([400])
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    const args = wallet.createAction.mock.calls[0][0] as { outputs: { basket?: string }[] }
    expect(args.outputs).toHaveLength(2)
    expect(args.outputs[1].basket).toBe(MANDALA_BASKET)
  })

  it('creates no change output on an exact-fit selection', async () => {
    const coins = [coinTx([250])]
    const signable = signableFrom([{ tx: coins[0], vout: 0 }], [{ script: recipientScript(250) }])
    const wallet = tokenWallet(coins, signable)
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    const args = wallet.createAction.mock.calls[0][0] as { outputs: unknown[] }
    expect(args.outputs).toHaveLength(1)
  })

  // §1.1: the bundle is assembled from THIS device's own tables, for every
  // ancestor in the transfer's own BEEF.
  it('carries the assembled AdmissionBundle: σ_I for the covered ancestor', async () => {
    const { wallet, coins } = setup()
    const store = admittedStore(coins[0].id('hex'))
    const { frame } = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps(store))
    expect(frame.token!.admissions.map(a => a.txid)).toEqual([coins[0].id('hex')])
    expect(frame.token!.admissions[0].signerKey).toBe(OVERLAY_KEY)
  })

  it('carries the tip’s own linkage payload, so the recipient can submit it', async () => {
    const { wallet, signable } = setup()
    const { frame } = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    const tip = frame.token!.linkage.find(l => l.txid === signable.tx.id('hex'))
    expect(tip).toBeDefined()
    const payload = JSON.parse(new TextDecoder().decode(tip!.payload)) as {
      inputs: { index: number }[]
      outputs: { index: number }[]
    }
    expect(payload.inputs.map(i => i.index)).toEqual([0])
    expect(payload.outputs.map(o => o.index)).toEqual([0, 1])
  })

  it('reveals input and change linkage to the overlay, never to the payee', async () => {
    const { wallet } = setup()
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    for (const call of wallet.revealSpecificKeyLinkage.mock.calls) {
      expect((call[0] as { verifier: string }).verifier).toBe(OVERLAY_KEY)
    }
  })

  it('has no recipientLinkage: v4 removed it', async () => {
    const { wallet } = setup()
    const { frame } = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    expect('recipientLinkage' in (frame.token as object)).toBe(false)
  })

  // The point of the whole revision (§9 payer step 5).
  it('submits nothing and broadcasts nothing: exactly two wallet actions, both local', async () => {
    const { wallet } = setup()
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    expect(wallet.createAction.mock.calls[0][0]).not.toHaveProperty('options.sendWith')
    expect(wallet.signAction).toHaveBeenCalledTimes(1)
  })

  it('refuses a token amount the payee did not ask for', async () => {
    const { wallet } = setup()
    await expect(buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 999, deps())).rejects.toThrow(
      /does not match/i
    )
  })

  it('refuses to build a token payment without the deps that make it one', async () => {
    const { wallet } = setup()
    await expect(buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250)).rejects.toThrow(
      /token/i
    )
  })

  it('refuses when the basket holds no coin of this asset', async () => {
    const coins = [coinTx([400])]
    const signable = signableFrom([{ tx: coins[0], vout: 0 }], [{ script: recipientScript(250) }])
    const wallet = tokenWallet(coins, signable)
    wallet.listOutputs = jest.fn(async (_args: unknown) => ({ totalOutputs: 0, outputs: [], BEEF: beefOf([]) })) as never
    await expect(
      buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    ).rejects.toThrow(/insufficient/i)
  })

  it('ignores a basket output of another asset when selecting', async () => {
    const mine = coinTx([400])
    const other = new Transaction()
    other.addOutput({
      satoshis: 1,
      lockingScript: new MandalaToken().lock('cd'.repeat(32) + '.1', 9999, PKH)
    })
    const coins = [mine, other]
    const signable = signableFrom([{ tx: mine, vout: 0 }], [
      { script: recipientScript(250) },
      { script: new MandalaToken().lock(ASSET, 150, PKH).toHex() }
    ])
    const wallet = tokenWallet(coins, signable)
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    const args = wallet.createAction.mock.calls[0][0] as { inputs: { outpoint: string }[] }
    expect(args.inputs).toHaveLength(1)
    expect(args.inputs[0].outpoint.startsWith(mine.id('hex'))).toBe(true)
  })

  // 2026-09-16: `assembleBundle` threw AFTER `signAction(noSend)`, the caller
  // assumed nothing had been built, and the signed action kept the just-received
  // coin locked — the sweeper never reaps 'nosend'. The build owns its action
  // until it hands the frame back, so it is the build that must release it.
  describe('releasing the action when a later step fails', () => {
    const unreadableStore = (): BundleStore => ({
      getAdmission: jest.fn(async () => undefined),
      getLinkage: jest.fn(async () => {
        throw new Error('token_linkage_payloads.payloadBytes is not readable as bytes')
      })
    })

    it('aborts the signed action exactly once, by its reference, and rejects with the original error', async () => {
      const { wallet } = setup()
      await expect(
        buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps(unreadableStore()))
      ).rejects.toThrow('token_linkage_payloads.payloadBytes is not readable as bytes')
      expect(wallet.signAction).toHaveBeenCalledTimes(1)
      expect(wallet.abortAction).toHaveBeenCalledTimes(1)
      expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-token' }, 'admin.com')
    })

    it('never lets a failed abort mask the error that caused it', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { wallet } = setup()
        wallet.abortAction = jest.fn(async () => {
          throw new Error('storage locked')
        })
        await expect(
          buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps(unreadableStore()))
        ).rejects.toThrow('token_linkage_payloads.payloadBytes is not readable as bytes')
        expect(wallet.abortAction).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    })

    it('has nothing to abort when the failure comes before an action exists', async () => {
      const { wallet } = setup()
      const d = deps()
      d.lockToPayee = jest.fn(async () => {
        throw new Error('blinding unavailable')
      })
      await expect(buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, d)).rejects.toThrow(
        'blinding unavailable'
      )
      expect(wallet.createAction).not.toHaveBeenCalled()
      expect(wallet.abortAction).not.toHaveBeenCalled()
    })

    it('leaves a successful build’s action alone', async () => {
      const { wallet } = setup()
      await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
      expect(wallet.abortAction).not.toHaveBeenCalled()
    })

    it('does the same on the BSV path when the signed bytes will not parse', async () => {
      const wallet = {
        getPublicKey: jest.fn(async () => ({ publicKey: '03'.padEnd(66, 'f') })),
        createAction: jest.fn(async () => ({ signableTransaction: { reference: 'ref-bsv' } })),
        signAction: jest.fn(async () => ({ tx: [1, 2, 3], txid: 'bsv-tx' })),
        abortAction: jest.fn(async () => ({ aborted: true }))
      }
      const bsvSession = mintSession({
        identityKey: PAYEE,
        amount: 777,
        derivationPrefix: 'cHJlZml4',
        derivationSuffix: 'c3VmZml4',
        supportsAwdl: true
      })
      await expect(buildPaymentFrame(wallet as never, bsvSession, 'admin.com', 777)).rejects.toThrow()
      expect(wallet.abortAction).toHaveBeenCalledTimes(1)
      expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-bsv' }, 'admin.com')
    })
  })

  it('still builds a BSV frame when the session names no asset', async () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 777, lockingScript: new P2PKH().lock('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2') })
    const wallet = {
      getPublicKey: jest.fn(async () => ({ publicKey: '03'.padEnd(66, 'f') })),
      createAction: jest.fn(async () => ({ signableTransaction: { reference: 'ref-bsv' } })),
      signAction: jest.fn(async () => ({ tx: Array.from(tx.toAtomicBEEF()), txid: 'bsv-tx' })),
      abortAction: jest.fn()
    }
    const bsvSession = mintSession({
      identityKey: PAYEE,
      amount: 777,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: true
    })
    const { frame } = await buildPaymentFrame(wallet as never, bsvSession, 'admin.com', 777)
    expect(frame.kind).toBe('bsv')
    expect(frame.token).toBeUndefined()
  })
})

describe('finalizeDelivery: guard #1 — a token payment is never broadcast here', () => {
  const tokenBuilt = {
    frame: { kind: 'token' } as never,
    reference: 'ref-1',
    txid: 'aa'.repeat(32),
    satoshis: 1
  }
  const bsvBuilt = { frame: { kind: 'bsv' } as never, reference: 'ref-1', txid: 'bb'.repeat(32), satoshis: 700 }

  function payerStub() {
    return {
      getPublicKey: jest.fn(),
      createAction: jest.fn(async () => ({ sendWithResults: [{ txid: 'aa'.repeat(32), status: 'sending' }] })),
      signAction: jest.fn(),
      abortAction: jest.fn(async () => ({ aborted: true }))
    }
  }

  // SM-3.1: today's online payer falls straight through to sendWith with no
  // kind check at all, putting an unadmitted token transaction on chain before
  // any overlay has seen it. The overlay can then only refuse it.
  it('holds, then returns pending — ONLINE — instead of releasing the transaction', async () => {
    const w = payerStub()
    const hold = jest.fn(async () => undefined)
    const outcome = await finalizeDelivery(w as never, tokenBuilt, { ok: true }, 'admin.com', {
      online: async () => true,
      hold
    })
    expect(hold).toHaveBeenCalledWith(tokenBuilt.txid)
    expect(outcome).toEqual({ kind: 'sent', broadcast: 'pending', detail: 'awaiting overlay admission' })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('holds, then returns pending — OFFLINE — with the same detail', async () => {
    const w = payerStub()
    const hold = jest.fn(async () => undefined)
    const outcome = await finalizeDelivery(w as never, tokenBuilt, { ok: true }, 'admin.com', {
      online: async () => false,
      hold
    })
    expect(hold).toHaveBeenCalledWith(tokenBuilt.txid)
    expect(outcome).toEqual({ kind: 'sent', broadcast: 'pending', detail: 'awaiting overlay admission' })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  // A negative ack still releases the inputs: the payee queued nothing, and the
  // guard is about broadcasting, not about unwinding.
  it('still aborts a declined token payment', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(
      w as never,
      tokenBuilt,
      { ok: false, error: 'not_covered' },
      'admin.com',
      { online: async () => true, hold: jest.fn(async () => undefined) }
    )
    expect(outcome).toEqual({ kind: 'declined', reason: 'not_covered' })
    expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
  })

  it('reports a failed hold as pending, and still never broadcasts', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(w as never, tokenBuilt, { ok: true }, 'admin.com', {
      online: async () => true,
      hold: jest.fn(async () => {
        throw new Error('db locked')
      })
    })
    expect(outcome).toMatchObject({ kind: 'sent', broadcast: 'pending' })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('leaves the BSV path broadcasting exactly as before', async () => {
    const w = payerStub()
    w.createAction = jest.fn(async () => ({ sendWithResults: [{ txid: bsvBuilt.txid, status: 'sending' }] }))
    const outcome = await finalizeDelivery(w as never, bsvBuilt, { ok: true }, 'admin.com', {
      online: async () => true,
      hold: jest.fn(async () => undefined)
    })
    expect(outcome).toEqual({ kind: 'sent', broadcast: 'ok' })
    expect(w.createAction).toHaveBeenCalledTimes(1)
  })
})

describe('the token frame a real build produces decodes', () => {
  it('round-trips through the v4 codec', async () => {
    const coins = [coinTx([400])]
    const signable = signableFrom([{ tx: coins[0], vout: 0 }], [
      { script: recipientScript(250) },
      { script: new MandalaToken().lock(ASSET, 150, PKH).toHex() }
    ])
    const wallet = tokenWallet(coins, signable)
    const { frame } = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame)
    expect(Utils.toHex(Array.from(frame.transaction.slice(0, 1)))).toBeDefined()
  })
})

// ───────────────────── coin selection reads the WHOLE basket ─────────────────────
//
// BRC-100's `listOutputs` defaults to a limit of TEN. Coin selection asked for
// no limit and treated the one page it got back as the payer's entire balance —
// so a wallet holding twelve coins whose eleventh and twelfth were the ones
// that covered the amount was told `insufficient token balance` for money it
// plainly had, with a partial total in the message that read as a wallet bug.
describe('buildPaymentFrame: token coin selection pages the basket', () => {
  const DEFAULT_LIMIT = 10

  /**
   * A BRC-100-shaped `listOutputs`: it honours `limit`/`offset` and defaults
   * `limit` to ten, and — crucially — each page's `BEEF` carries only that
   * page's own transactions, so a caller that does not accumulate them cannot
   * value a coin from page two.
   */
  function pagingWallet(coins: Transaction[], signable: { tx: Transaction; beef: number[] }) {
    const base = tokenWallet(coins, signable)
    const all = coins.map((tx, i) => ({
      outpoint: `${tx.id('hex')}.0`,
      satoshis: 1,
      spendable: true,
      customInstructions: CI(`coin-${i}-0`)
    }))
    return {
      ...base,
      listOutputs: jest.fn(async (args: { limit?: number; offset?: number }) => {
        const limit = args.limit ?? DEFAULT_LIMIT
        const offset = args.offset ?? 0
        const page = all.slice(offset, offset + limit)
        return {
          totalOutputs: all.length,
          outputs: page,
          BEEF: beefOf(coins.slice(offset, offset + limit))
        }
      })
    }
  }

  /**
   * Twelve one-coin transactions of 24 base units each. The session asks for
   * 250, so ten coins (240) are NOT enough and the eleventh is required —
   * which is exactly the coin the unpaged read could never see.
   */
  function setup() {
    const coins = Array.from({ length: 12 }, () => coinTx([24]))
    const spent = coins.slice(0, 11)
    const signable = signableFrom(
      spent.map(tx => ({ tx, vout: 0 })),
      [{ script: recipientScript(250) }, { script: new MandalaToken().lock(ASSET, 14, PKH).toHex() }]
    )
    return { coins, wallet: pagingWallet(coins, signable) }
  }

  it('reaches the eleventh coin rather than reporting a short balance', async () => {
    const { wallet } = setup()

    const built = await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())

    expect(built.frame.kind).toBe('token')
    // Eleven inputs: every coin the basket holds up to the amount, not the ten
    // the first page happened to contain.
    const args = wallet.signAction.mock.calls[0][0] as { spends: Record<string, unknown> }
    expect(Object.keys(args.spends)).toHaveLength(11)
  })

  it('asks for a page far larger than the default, and stops once the basket is exhausted', async () => {
    const { wallet } = setup()
    await buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())

    // One round trip for any realistic basket: the first page already covers
    // `totalOutputs`, so there is no second call.
    expect(wallet.listOutputs).toHaveBeenCalledTimes(1)
    expect(wallet.listOutputs.mock.calls[0][0]).toMatchObject({ limit: 1000, offset: 0 })
  })

  it('accumulates each page’s BEEF, so a coin from a later page is still valuable', async () => {
    const { coins } = setup()
    const spent = coins.slice(0, 11)
    const signable = signableFrom(
      spent.map(tx => ({ tx, vout: 0 })),
      [{ script: recipientScript(250) }, { script: new MandalaToken().lock(ASSET, 14, PKH).toHex() }]
    )
    const wallet = pagingWallet(coins, signable)
    // Force real paging: five outputs per page, four pages.
    const paged = wallet.listOutputs
    wallet.listOutputs = jest.fn(async (args: { offset?: number }) => paged({ limit: 5, offset: args.offset ?? 0 }))

    await expect(buildPaymentFrame(wallet as never, tokenSession(), 'admin.com', 250, deps())).resolves.toMatchObject({
      frame: { kind: 'token' }
    })
    // Pages of five over twelve outputs: 5, 5, 2 — the short page ends it.
    expect(wallet.listOutputs).toHaveBeenCalledTimes(3)
  })
})
