/**
 * The payer's nearby token path through the color module (plan 07 Task 15).
 *
 * The wallet no longer selects coins, signs token inputs or mints linkage:
 * the module does all of it inside `sendHandover` (lib 0.5.0), reached through
 * the runtime's `nearby.handover`. What is left here is binding:
 *
 *  · the hand-over is asked for with the SESSION's own remittance strings and
 *    exact bigint units, so the payee's output is derived from the very nonces
 *    the payee minted;
 *  · what comes back must carry those same strings and the payee output at
 *    index 0 — anything else is not this request's payment, so the signed
 *    action is released (by its reference) and the build throws;
 *  · the frame is v7 (IC §7.3): the receipt's A′, the AtomicBEEF and the
 *    v4 body's own members (decimal amount, sender mode, σ admissions and
 *    envelope linkage), with no overlay url/key;
 *  · nothing is created, broadcast or submitted by the builder itself, and
 *    `finalizeDelivery` never broadcasts a token payment (guard #1).
 */
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { handoverBody, receiptOfBody, type HandoverResult } from '@bsv/mandala'
import { buildPaymentFrame, finalizeDelivery, type TokenBuildDeps } from '../../core/localpay/build'
import { FRAME_VERSION, decodeFrame, encodeFrame } from '../../core/localpay/codec'
import { mintSession, type Session } from '../../core/localpay/session'

const ASSET = 'ab'.repeat(32) + '_0'
const PAYEE = new PrivateKey(11).toPublicKey().toString()
const BLINDED_SENDER = new PrivateKey(13).toPublicKey().toString()
const ADMIN = 'admin.example'
const PREFIX = 'cHJlZml4cHJlZml4cHJlZml4cHJlZml4cHJlZml4cHI='
const SUFFIX = 'c3VmZml4c3VmZml4c3VmZml4c3VmZml4c3VmZml4c3U='
const PKH = new Array(20).fill(9)
const SIGMA = {
  txid: 'cd'.repeat(32),
  outputs: [1],
  signer: new PrivateKey(5).toPublicKey().toString(),
  signature: '3006020101020101'
}

/** A 1-input tx whose output 0 is the 1-sat 1Color payee output. */
function handoverTx(units: bigint): { beef: number[]; txid: string } {
  const source = new Transaction()
  source.addOutput({ lockingScript: new P2PKH().lock(PKH), satoshis: 1000 })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(PKH) })
  tx.addOutput({ lockingScript: new OneColor().lock(ASSET, units, PKH), satoshis: 1 })
  tx.addOutput({ lockingScript: new P2PKH().lock(PKH), satoshis: 900 })
  return { beef: tx.toAtomicBEEF(), txid: tx.id('hex') }
}

function hand(
  units: bigint,
  over: Partial<HandoverResult> = {},
  receipt: Partial<HandoverResult['receipt']> = {}
): HandoverResult {
  const { beef, txid } = handoverTx(units)
  const body = handoverBody({
    assetId: ASSET,
    amount: units,
    outputIndex: 0,
    tx: beef,
    derivationPrefix: PREFIX,
    derivationSuffix: SUFFIX,
    senderIdentityKey: BLINDED_SENDER,
    senderMode: 'blinded',
    admissions: [SIGMA],
    linkage: [{ txid, offChainValues: [1, 2, 3] }]
  })
  return {
    txid,
    tx: beef,
    reference: 'ref-H',
    outputIndex: 0,
    offChainValues: [1, 2, 3],
    receipt: { ...receiptOfBody(body), ...receipt },
    body,
    ...over
  }
}

function tokenSession(units?: bigint): Session {
  return mintSession({
    identityKey: PAYEE,
    ...(units === undefined ? {} : { units }),
    asset: { id: ASSET, ticker: 'TUSD', decimals: 2 },
    derivationPrefix: PREFIX,
    derivationSuffix: SUFFIX,
    supportsAwdl: true
  })
}

function payer() {
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: new PrivateKey(7).toPublicKey().toString() })),
    createAction: jest.fn(),
    signAction: jest.fn(),
    abortAction: jest.fn(async () => ({ aborted: true }))
  }
}

describe('buildPaymentFrame: token path through the module hand-over', () => {
  it('builds a v7 token frame from the module hand-over bound to the session remittance', async () => {
    const wallet = payer()
    const H = hand(1500n)
    const handover = jest.fn(async () => H)
    const built = await buildPaymentFrame(wallet as never, tokenSession(1500n), ADMIN, 1500n, { handover })
    expect(handover).toHaveBeenCalledWith({
      assetId: ASSET,
      units: 1500n,
      recipientKey: PAYEE,
      derivationPrefix: PREFIX,
      derivationSuffix: SUFFIX,
      note: undefined
    })
    expect(built.frame).toMatchObject({
      version: 7,
      kind: 'token',
      outputIndex: 0,
      senderIdentityKey: BLINDED_SENDER,
      derivationPrefix: PREFIX,
      derivationSuffix: SUFFIX,
      token: {
        assetId: ASSET,
        amount: '1500',
        senderMode: 'blinded',
        admissions: H.body.admissions,
        linkage: H.body.linkage,
        certificates: []
      }
    })
    expect(Array.from(built.frame.transaction)).toEqual(H.tx)
    expect(built.frame.token).not.toHaveProperty('overlayUrl')
    expect(built.frame.token).not.toHaveProperty('profileData')
    expect(built.tokenAmount).toBe(1500n)
    expect(built.reference).toBe('ref-H')
    expect(built.txid).toBe(H.txid)
    // The token output's own satoshis (BRC-92), never the payment.
    expect(built.satoshis).toBe(1)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('carries exact units above 2^53 to the hand-over and the built payment', async () => {
    const big = 18446744073709551615n
    const handover = jest.fn(async () => hand(big))
    const built = await buildPaymentFrame(payer() as never, tokenSession(big), ADMIN, big, { handover })
    expect(handover).toHaveBeenCalledWith(expect.objectContaining({ units: big }))
    expect(built.tokenAmount).toBe(big)
  })

  it('pays an open token request the payer’s own figure', async () => {
    const handover = jest.fn(async () => hand(42n))
    const built = await buildPaymentFrame(payer() as never, tokenSession(), ADMIN, 42n, { handover })
    expect(handover).toHaveBeenCalledWith(expect.objectContaining({ units: 42n }))
    expect(built.tokenAmount).toBe(42n)
  })

  it('passes the trimmed note to the hand-over and onto the frame', async () => {
    const handover = jest.fn(async () => hand(1500n))
    const built = await buildPaymentFrame(payer() as never, tokenSession(1500n), ADMIN, 1500n, { handover }, '  lunch ')
    expect(handover).toHaveBeenCalledWith(expect.objectContaining({ note: 'lunch' }))
    expect(built.frame.note).toBe('lunch')
  })

  it.each([
    ['another derivationPrefix', {}, { derivationPrefix: 'b3RoZXI=' }],
    ['another derivationSuffix', {}, { derivationSuffix: 'b3RoZXI=' }],
    ['another asset', {}, { assetId: 'cd'.repeat(32) + '_0' }],
    ['the payee output at index 1', { outputIndex: 1 }, {}]
  ])('aborts and throws when the hand-over carries %s', async (_label, over, receipt) => {
    const wallet = payer()
    const queueFailedAbort = jest.fn(async () => undefined)
    const handover = jest.fn(async () => hand(1500n, over, receipt))
    await expect(
      buildPaymentFrame(wallet as never, tokenSession(1500n), ADMIN, 1500n, { handover }, undefined, queueFailedAbort)
    ).rejects.toThrow(/session|output 0|asset/)
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-H' }, ADMIN)
    expect(queueFailedAbort).not.toHaveBeenCalled()
  })

  it('queues a failed release of a mismatched hand-over for replay', async () => {
    const wallet = payer()
    wallet.abortAction.mockResolvedValueOnce({ aborted: false })
    const queueFailedAbort = jest.fn(async () => undefined)
    const handover = jest.fn(async () => hand(1500n, { outputIndex: 1 }))
    await expect(
      buildPaymentFrame(wallet as never, tokenSession(1500n), ADMIN, 1500n, { handover }, undefined, queueFailedAbort)
    ).rejects.toThrow(/output 0/)
    expect(queueFailedAbort).toHaveBeenCalledWith('ref-H')
  })

  it('has nothing to release when the hand-over itself throws', async () => {
    const wallet = payer()
    const handover = jest.fn(async () => {
      throw Object.assign(new Error('frozen'), { name: 'ColorProviderError' })
    })
    await expect(buildPaymentFrame(wallet as never, tokenSession(1500n), ADMIN, 1500n, { handover })).rejects.toThrow(
      'frozen'
    )
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('refuses a token amount the payee did not ask for, before any hand-over', async () => {
    const handover = jest.fn(async () => hand(1n))
    await expect(buildPaymentFrame(payer() as never, tokenSession(1500n), ADMIN, 1499n, { handover })).rejects.toThrow(
      /does not match/
    )
    expect(handover).not.toHaveBeenCalled()
  })

  it.each([[0n], [-1n], [18446744073709551616n], [1500]])('refuses %p as a token amount', async amount => {
    const handover = jest.fn(async () => hand(1n))
    await expect(
      buildPaymentFrame(payer() as never, tokenSession(), ADMIN, amount as bigint, { handover })
    ).rejects.toThrow(/base units/)
    expect(handover).not.toHaveBeenCalled()
  })

  it('refuses to build a token payment without the deps that make it one', async () => {
    await expect(buildPaymentFrame(payer() as never, tokenSession(1500n), ADMIN, 1500n)).rejects.toThrow(
      /token build deps/
    )
  })

  it('refuses a bigint on a BSV session: satoshis and base units are not interchangeable', async () => {
    const bsv = mintSession({
      identityKey: PAYEE,
      amount: 777,
      derivationPrefix: PREFIX,
      derivationSuffix: SUFFIX,
      supportsAwdl: true
    })
    await expect(buildPaymentFrame(payer() as never, bsv, ADMIN, 777n)).rejects.toThrow(/satoshis/)
  })

  it('round-trips the frame it builds through the v7 codec', async () => {
    const built = await buildPaymentFrame(payer() as never, tokenSession(1500n), ADMIN, 1500n, {
      handover: async () => hand(1500n)
    })
    expect(built.frame.version).toBe(FRAME_VERSION)
    expect(decodeFrame(encodeFrame(built.frame))).toEqual(built.frame)
  })
})

describe('finalizeDelivery: guard #1 — a token payment is never broadcast here', () => {
  const tokenBuilt = {
    frame: { kind: 'token' } as never,
    reference: 'ref-1',
    txid: 'aa'.repeat(32),
    satoshis: 1,
    tokenAmount: 1500n
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

  it('finalizeDelivery never broadcasts a token payment', async () => {
    for (const online of [true, false]) {
      const w = payerStub()
      const hold = jest.fn(async () => undefined)
      const outcome = await finalizeDelivery(w as never, tokenBuilt, { ok: true }, ADMIN, {
        online: async () => online,
        hold
      })
      expect(hold).toHaveBeenCalledWith(tokenBuilt.txid)
      expect(outcome).toEqual({ kind: 'sent', broadcast: 'pending', detail: 'awaiting overlay admission' })
      expect(w.createAction).not.toHaveBeenCalled()
    }
  })

  it('reports a failed hold as pending, and still never broadcasts', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(w as never, tokenBuilt, { ok: true }, ADMIN, {
      online: async () => true,
      hold: jest.fn(async () => {
        throw new Error('db locked')
      })
    })
    expect(outcome).toMatchObject({ kind: 'sent', broadcast: 'pending' })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('a decline aborts the action, then reports the release so the journal can cancel it', async () => {
    const w = payerStub()
    const order: string[] = []
    w.abortAction.mockImplementation(async () => {
      order.push('abort')
      return { aborted: true }
    })
    const onReleased = jest.fn(async () => {
      order.push('released')
    })
    const outcome = await finalizeDelivery(w as never, tokenBuilt, { ok: false, error: 'not_covered' }, ADMIN, {
      online: async () => true,
      hold: jest.fn(async () => undefined),
      onReleased
    })
    expect(outcome).toEqual({ kind: 'declined', reason: 'not_covered' })
    expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(onReleased).toHaveBeenCalledWith(tokenBuilt.txid)
    expect(order).toEqual(['abort', 'released'])
  })

  it('a decline it parks instead of releasing is never reported as released', async () => {
    const w = payerStub()
    const onReleased = jest.fn(async () => undefined)
    const parkUnverifiable = jest.fn(async () => undefined)
    const outcome = await finalizeDelivery(w as never, tokenBuilt, { ok: false, error: 'not_covered' }, ADMIN, {
      online: async () => false,
      hold: jest.fn(async () => undefined),
      chainAlreadyKnows: async () => false,
      parkUnverifiable,
      onReleased
    })
    expect(outcome).toEqual({ kind: 'declined', reason: 'not_covered' })
    expect(parkUnverifiable).toHaveBeenCalledWith(tokenBuilt.txid)
    expect(w.abortAction).not.toHaveBeenCalled()
    expect(onReleased).not.toHaveBeenCalled()
  })

  it('a throwing release hook never turns a decline into a failure', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(w as never, tokenBuilt, { ok: false, error: 'not_covered' }, ADMIN, {
      hold: jest.fn(async () => undefined),
      onReleased: async () => {
        throw new Error('journal down')
      }
    })
    expect(outcome).toEqual({ kind: 'declined', reason: 'not_covered' })
  })

  it('leaves the BSV path broadcasting exactly as before', async () => {
    const w = payerStub()
    w.createAction = jest.fn(async () => ({ sendWithResults: [{ txid: bsvBuilt.txid, status: 'sending' }] }))
    const outcome = await finalizeDelivery(w as never, bsvBuilt, { ok: true }, ADMIN, {
      online: async () => true,
      hold: jest.fn(async () => undefined)
    })
    expect(outcome).toEqual({ kind: 'sent', broadcast: 'ok' })
    expect(w.createAction).toHaveBeenCalledTimes(1)
  })
})

// Type-level pin: the deps are exactly the runtime's `nearby.handover`.
const _depsShape: TokenBuildDeps = { handover: async () => hand(1n) }
void _depsShape
