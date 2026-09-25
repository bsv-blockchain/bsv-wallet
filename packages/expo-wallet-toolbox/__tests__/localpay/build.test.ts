import { broadcastPayment, buildPaymentFrame, finalizeDelivery } from '../../core/localpay/build'
import { mintSession } from '../../core/localpay/session'
import { PEERPAY_PROTOCOL_ID } from '../../core/localpay/pending'

const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

// buildPaymentFrame now reads the real paid amount off output 0 of the signed
// transaction (send-max support), so every mocked `tx` must be a genuine
// AtomicBEEF the SDK can parse — not an arbitrary byte array.
function atomicBeefWithOutput(satoshis: number): number[] {
  const { Transaction, P2PKH } = require('@bsv/sdk')
  const tx = new Transaction()
  tx.addOutput({ lockingScript: new P2PKH().lock(ADDRESS), satoshis })
  return Array.from(tx.toAtomicBEEF() as number[])
}

const session = () =>
  mintSession({
    identityKey: '02'.padEnd(66, 'e'),
    amount: 777,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    supportsAwdl: true
  })

// Mirrors WalletPermissionsManager with `signAndProcess: false`: createAction
// returns a signableTransaction (carrying the reference) rather than a final tx,
// and buildPaymentFrame finalizes it through signAction.
function walletStub() {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: '03'.padEnd(66, 'f') }),
    createAction: jest.fn().mockResolvedValue({ signableTransaction: { reference: 'ref-123' } }),
    signAction: jest.fn().mockResolvedValue({ tx: atomicBeefWithOutput(777), txid: 'finalized' }),
    abortAction: jest.fn().mockResolvedValue({ aborted: true })
  }
}

describe('buildPaymentFrame', () => {
  it('echoes the session derivation nonces', async () => {
    const s = session()
    const { frame } = await buildPaymentFrame(walletStub() as never, s, 'admin.com', 777)
    expect(frame.derivationPrefix).toBe(s.derivationPrefix)
    expect(frame.derivationSuffix).toBe(s.derivationSuffix)
  })

  // A nearby payment must stay resendable after its session dies: the sealed
  // frame needs the payee's PSK to read, so the payee's key and the derivation
  // data have to live on the action itself.
  it('labels the action with the payee identity key so a resend knows the recipient', async () => {
    const w = walletStub()
    const s = session()
    await buildPaymentFrame(w as never, s, 'admin.com', 777)
    const args = w.createAction.mock.calls[0][0]
    expect(args.labels).toContain(s.identityKey)
  })

  // The activity list shows the action description as the row title. It names
  // what happened — the counterparty is drawn from the identity-key label as a
  // sigil, and its abbreviated key as a title told the user nothing about a
  // blinded transfer (2026-09-16).
  it('describes the action as a sent BSV payment', async () => {
    const w = walletStub()
    const s = session()
    await buildPaymentFrame(w as never, s, 'admin.com', 777)
    const args = w.createAction.mock.calls[0][0]
    expect(args.description).toBe('Sent BSV')
  })

  it('uses the payer’s note as the description when one is given', async () => {
    const w = walletStub()
    await buildPaymentFrame(w as never, session(), 'admin.com', 777, undefined, 'lunch split')
    expect(w.createAction.mock.calls[0][0].description).toBe('lunch split')
  })

  it('carries the note on the frame so the payee can show it too', async () => {
    const { frame } = await buildPaymentFrame(
      walletStub() as never,
      session(),
      'admin.com',
      777,
      undefined,
      'lunch split'
    )
    expect(frame.note).toBe('lunch split')
  })

  it('omits the note from the frame, and keeps the fixed description, when none is given', async () => {
    const w = walletStub()
    const { frame } = await buildPaymentFrame(w as never, session(), 'admin.com', 777)
    expect(frame.note).toBeUndefined()
    expect(w.createAction.mock.calls[0][0].description).toBe('Sent BSV')
  })

  it('writes the derivation data as customInstructions so a resend can rebuild the token', async () => {
    const w = walletStub()
    const s = session()
    await buildPaymentFrame(w as never, s, 'admin.com', 777)
    const args = w.createAction.mock.calls[0][0]
    expect(JSON.parse(args.outputs[0].customInstructions)).toEqual({
      derivationPrefix: s.derivationPrefix,
      derivationSuffix: s.derivationSuffix,
      type: 'BRC29'
    })
  })

  it('uses the local identity key as sender', async () => {
    const { frame } = await buildPaymentFrame(walletStub() as never, session(), 'admin.com', 777)
    expect(frame.senderIdentityKey).toBe('03'.padEnd(66, 'f'))
  })

  it('carries the transaction bytes', async () => {
    const { frame } = await buildPaymentFrame(walletStub() as never, session(), 'admin.com', 777)
    expect(Array.from(frame.transaction)).toEqual(atomicBeefWithOutput(777))
  })

  it('propagates a createAction failure', async () => {
    const w = walletStub()
    w.createAction.mockRejectedValue(new Error('insufficient funds'))
    await expect(buildPaymentFrame(w as never, session(), 'admin.com', 777)).rejects.toThrow('insufficient funds')
  })

  // Money-safety: a wrong protocolID, malformed keyID, wrong counterparty, or
  // flipped forSelf all still produce *a* frame that passes the tests above —
  // but the payee derives a different key and the output is unspendable by
  // them. These assertions pin the exact derivation call the payee's
  // internalizeAction depends on.
  it('derives the payee key with the session nonces, protocol, and counterparty', async () => {
    const s = session()
    const w = walletStub()
    await buildPaymentFrame(w as never, s, 'admin.com', s.amount as number)
    const derivationArgs = w.getPublicKey.mock.calls[1][0]
    expect(derivationArgs).toEqual({
      protocolID: PEERPAY_PROTOCOL_ID,
      keyID: `${s.derivationPrefix} ${s.derivationSuffix}`,
      counterparty: s.identityKey,
      forSelf: false
    })
  })

  it('builds the derivation keyID from the session nonces verbatim, not regenerated locally', async () => {
    const s = mintSession({
      identityKey: '02'.padEnd(66, 'b'),
      amount: 555,
      derivationPrefix: 'uniquePrefix123',
      derivationSuffix: 'uniqueSuffix456',
      supportsAwdl: true
    })
    const w = walletStub()
    await buildPaymentFrame(w as never, s, 'admin.com', s.amount as number)
    const derivationArgs = w.getPublicKey.mock.calls[1][0]
    expect(derivationArgs.keyID).toBe('uniquePrefix123 uniqueSuffix456')
    expect(derivationArgs.counterparty).toBe('02'.padEnd(66, 'b'))
  })

  it('creates the action with randomizeOutputs disabled and noSend so the payee broadcasts', async () => {
    const w = walletStub()
    await buildPaymentFrame(w as never, session(), 'admin.com', 777)
    const createArgs = w.createAction.mock.calls[0][0]
    expect(createArgs.options).toEqual({ randomizeOutputs: false, noSend: true, signAndProcess: false })
  })

  // The reference is the ONLY handle that can release the inputs a `noSend`
  // action holds. WalletPermissionsManager swallows it unless signAndProcess is
  // explicitly false, and TaskFailAbandoned never sweeps 'nosend' — so losing it
  // locks amount + fee in the payer's wallet permanently.
  it('asks for the deferred result so the abort reference survives', async () => {
    const w = walletStub()
    await buildPaymentFrame(w as never, session(), 'admin.com', 777)
    expect(w.createAction.mock.calls[0][0].options.signAndProcess).toBe(false)
  })

  it('returns the createAction reference alongside the frame', async () => {
    const built = await buildPaymentFrame(walletStub() as never, session(), 'admin.com', 777)
    expect(built.reference).toBe('ref-123')
  })

  it('returns no reference when a wallet finalizes createAction itself', async () => {
    const w = walletStub()
    const tx = atomicBeefWithOutput(777)
    w.createAction.mockResolvedValue({ tx, txid: 'deadbeef' })
    const built = await buildPaymentFrame(w as never, session(), 'admin.com', 777)
    expect(built.reference).toBeUndefined()
    expect(Array.from(built.frame.transaction)).toEqual(tx)
    expect(w.signAction).not.toHaveBeenCalled()
  })

  it('forwards the originator to every wallet call', async () => {
    const w = walletStub()
    await buildPaymentFrame(w as never, session(), 'admin.com', 777)
    expect(w.getPublicKey.mock.calls[0][1]).toBe('admin.com')
    expect(w.getPublicKey.mock.calls[1][1]).toBe('admin.com')
    expect(w.createAction.mock.calls[0][1]).toBe('admin.com')
    expect(w.signAction.mock.calls[0][1]).toBe('admin.com')
  })

  it('finalizes a signableTransaction via signAction with empty spends and noSend', async () => {
    const w = walletStub()
    const built = await buildPaymentFrame(w as never, session(), 'admin.com', 777)
    expect(w.signAction).toHaveBeenCalledWith(
      { reference: 'ref-123', spends: {}, options: { noSend: true } },
      'admin.com'
    )
    expect(Array.from(built.frame.transaction)).toEqual(atomicBeefWithOutput(777))
  })

  // `options.sendWith` addresses a withheld action by TXID, not by reference,
  // so without this the payer has no handle to broadcast with and the action
  // stays 'nosend' forever — nothing in storage ever sweeps that status.
  it('returns the signed txid so the payment can be broadcast later', async () => {
    const built = await buildPaymentFrame(walletStub() as never, session(), 'admin.com', 777)
    expect(built.txid).toBe('finalized')
  })

  it('takes the txid from createAction when the wallet finalizes it itself', async () => {
    const w = walletStub()
    w.createAction.mockResolvedValue({ tx: atomicBeefWithOutput(777), txid: 'deadbeef' })
    const built = await buildPaymentFrame(w as never, session(), 'admin.com', 777)
    expect(built.txid).toBe('deadbeef')
  })

  // ── The amount is an argument, not a session field ──
  //
  // On an OPEN request the session carries no figure at all, so the one number
  // that becomes a real output has to come from the payer. These pin that it is
  // the argument — not `session.amount` — that sizes the output. The frame
  // carries no figure of its own to disagree with it: the payee reads the
  // output's satoshis (see utils/localpay/verify.ts).

  const openSession = () =>
    mintSession({
      identityKey: '02'.padEnd(66, 'e'),
      amount: undefined,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: true
    })

  it('uses the payer’s amount for the output on an open session', async () => {
    const w = walletStub()
    await buildPaymentFrame(w as never, openSession(), 'admin.com', 4200)
    expect(w.createAction.mock.calls[0][0].outputs[0].satoshis).toBe(4200)
  })

  it('carries no amount of its own on the frame', async () => {
    const w = walletStub()
    const built = await buildPaymentFrame(w as never, session(), 'admin.com', 777)
    expect(w.createAction.mock.calls[0][0].outputs[0].satoshis).toBe(777)
    expect('amount' in (built.frame as unknown as Record<string, unknown>)).toBe(false)
  })

  // Send-max: the requested `amount` argument is the sentinel, and the wallet
  // rewrites output 0 to whatever it could actually fund. Confirmation screens
  // must show `built.satoshis`, not the amount they asked for — this is what
  // makes that real figure available.
  it('reads the real paid satoshis off output 0, not the requested amount', async () => {
    const w = walletStub()
    w.signAction.mockResolvedValue({ tx: atomicBeefWithOutput(654321), txid: 'finalized' })
    const built = await buildPaymentFrame(w as never, openSession(), 'admin.com', 2099999999999999)
    expect(built.satoshis).toBe(654321)
  })

  // The payee's settle path refuses a frame whose amount contradicts a figure
  // they actually asked for. Catching it here means nothing is built, so there
  // is no `noSend` action left holding inputs.
  it('refuses an amount that contradicts the payee’s request, before building', async () => {
    const w = walletStub()
    await expect(buildPaymentFrame(w as never, session(), 'admin.com', 778)).rejects.toThrow(/does not match/)
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])('refuses a non-satoshi amount %p', async amount => {
    const w = walletStub()
    await expect(buildPaymentFrame(w as never, openSession(), 'admin.com', amount)).rejects.toThrow(
      /positive whole number/
    )
    expect(w.createAction).not.toHaveBeenCalled()
  })

  // XR-088. `createAction` reserved this reference's inputs before any of these
  // failures happened, and TaskFailAbandoned never sweeps a signed `nosend`
  // action — the 2026-09-16 incident. Its own abortAction call failing used to
  // only console.warn and rethrow the original build error, leaving no durable
  // retry record at all: releasingOnFailure now also queues the reference for
  // replay when supplied a queueFailedAbort dependency, same as
  // finalizeDelivery's decline path already does.
  describe('XR-088: a failed release during the build is durably queued for retry', () => {
    it('queues the reference when the build fails AND the release itself fails', async () => {
      const w = walletStub()
      w.signAction.mockRejectedValue(new Error('signing blew up'))
      w.abortAction.mockRejectedValue(new Error('abort also failed'))
      const queueFailedAbort = jest.fn().mockResolvedValue(undefined)
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(
        buildPaymentFrame(w as never, session(), 'admin.com', 777, undefined, undefined, queueFailedAbort)
      ).rejects.toThrow('signing blew up')

      expect(queueFailedAbort).toHaveBeenCalledWith('ref-123')
      warn.mockRestore()
    })

    it('also queues when abortAction resolves aborted:false rather than throwing', async () => {
      const w = walletStub()
      w.signAction.mockRejectedValue(new Error('signing blew up'))
      w.abortAction.mockResolvedValue({ aborted: false })
      const queueFailedAbort = jest.fn().mockResolvedValue(undefined)
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(
        buildPaymentFrame(w as never, session(), 'admin.com', 777, undefined, undefined, queueFailedAbort)
      ).rejects.toThrow('signing blew up')

      expect(queueFailedAbort).toHaveBeenCalledWith('ref-123')
      warn.mockRestore()
    })

    it('does not queue anything when the release itself succeeds', async () => {
      const w = walletStub()
      w.signAction.mockRejectedValue(new Error('signing blew up'))
      const queueFailedAbort = jest.fn().mockResolvedValue(undefined)

      await expect(
        buildPaymentFrame(w as never, session(), 'admin.com', 777, undefined, undefined, queueFailedAbort)
      ).rejects.toThrow('signing blew up')

      expect(queueFailedAbort).not.toHaveBeenCalled()
    })

    it('never throws from a queueFailedAbort failure, and still reports the original build error', async () => {
      const w = walletStub()
      w.signAction.mockRejectedValue(new Error('signing blew up'))
      w.abortAction.mockRejectedValue(new Error('abort also failed'))
      const queueFailedAbort = jest.fn().mockRejectedValue(new Error('storage down'))
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(
        buildPaymentFrame(w as never, session(), 'admin.com', 777, undefined, undefined, queueFailedAbort)
      ).rejects.toThrow('signing blew up')

      warn.mockRestore()
    })

    it('is a no-op for a caller that omits queueFailedAbort — only logs, exactly as before', async () => {
      const w = walletStub()
      w.signAction.mockRejectedValue(new Error('signing blew up'))
      w.abortAction.mockRejectedValue(new Error('abort also failed'))
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(buildPaymentFrame(w as never, session(), 'admin.com', 777)).rejects.toThrow('signing blew up')

      expect(warn).toHaveBeenCalledWith('[localpay] could not release the failed build:', 'abort also failed')
      warn.mockRestore()
    })
  })
})

describe('broadcastPayment', () => {
  function releaseStub(sendWithResults?: { txid: string; status: string }[]) {
    return {
      getPublicKey: jest.fn(),
      createAction: jest.fn().mockResolvedValue({ sendWithResults }),
      signAction: jest.fn(),
      abortAction: jest.fn().mockResolvedValue({ aborted: true })
    }
  }

  // Verified against @bsv/sdk validationHelpers.js:458-460 — sendWith with no
  // inputs and no outputs leaves isNewTx false, so this builds nothing; and
  // :438 — description is mandatory anyway (5-2000 bytes).
  it('releases the txid through a createAction that builds nothing', async () => {
    const w = releaseStub([{ txid: 'abc', status: 'sending' }])
    await broadcastPayment(w as never, 'abc', 'admin.com')

    const [args, originator] = w.createAction.mock.calls[0]
    expect(args.options).toEqual({ sendWith: ['abc'] })
    expect(args.inputs).toBeUndefined()
    expect(args.outputs).toBeUndefined()
    expect(String(args.description).length).toBeGreaterThanOrEqual(5)
    expect(originator).toBe('admin.com')
  })

  it('returns the toolbox status for this txid', async () => {
    const w = releaseStub([
      { txid: 'other', status: 'failed' },
      { txid: 'abc', status: 'unproven' }
    ])
    await expect(broadcastPayment(w as never, 'abc', 'admin.com')).resolves.toBe('unproven')
  })

  it('throws when the toolbox reports failed for this txid', async () => {
    const w = releaseStub([{ txid: 'abc', status: 'failed' }])
    await expect(broadcastPayment(w as never, 'abc', 'admin.com')).rejects.toThrow('abc')
  })
})

// The payer's money decision, in full. Every branch here either releases real
// money onto the network or reclaims inputs that are otherwise locked forever.
describe('finalizeDelivery', () => {
  function payerStub() {
    return {
      getPublicKey: jest.fn(),
      createAction: jest.fn().mockResolvedValue({ sendWithResults: [{ txid: 'tx-1', status: 'sending' }] }),
      signAction: jest.fn(),
      abortAction: jest.fn().mockResolvedValue({ aborted: true })
    }
  }

  const built = { frame: {} as never, reference: 'ref-1', txid: 'tx-1', satoshis: 700 }
  // These tests are pinning the ONLINE path, so connectivity is injected rather
  // than left to the real default (`@/utils/net/online`'s `getOnline`, which
  // calls the native NetInfo module and has nothing to answer with under Jest).
  // Hold runs on every positive ack (the frame must be persisted before sendWith).
  const online = {
    online: async () => true,
    hold: jest.fn().mockResolvedValue(undefined)
  }

  beforeEach(() => {
    ;(online.hold as jest.Mock).mockClear()
  })

  it('broadcasts on a positive ack', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(w as never, built, { ok: true }, 'admin.com', online)

    expect(outcome).toEqual({ kind: 'sent', broadcast: 'ok' })
    expect(online.hold).toHaveBeenCalledWith('tx-1')
    expect(w.createAction).toHaveBeenCalledTimes(1)
    expect(w.createAction.mock.calls[0][0].options).toEqual({ sendWith: ['tx-1'] })
    // Aborting after a positive ack frees inputs the payee is about to spend.
    expect(w.abortAction).not.toHaveBeenCalled()
  })

  it('does NOT broadcast on a negative ack, and releases the inputs instead', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', online)

    expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
    expect(w.createAction).not.toHaveBeenCalled()
    expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
  })

  it('still declines cleanly when there is no reference to abort', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(
      w as never,
      { ...built, reference: undefined },
      { ok: false },
      'admin.com',
      online
    )

    expect(outcome).toEqual({ kind: 'declined', reason: undefined })
    expect(w.createAction).not.toHaveBeenCalled()
    expect(w.abortAction).not.toHaveBeenCalled()
  })

  // A broadcast failure after a positive ack is NOT a failed payment: the
  // payee holds the frame and will internalize it. Reporting failure would put
  // the payer on a retry that mints a second transaction for the same request.
  it('reports a thrown broadcast as sent-but-pending, never as failed', async () => {
    const w = payerStub()
    w.createAction.mockRejectedValue(new Error('no network'))
    const outcome = await finalizeDelivery(w as never, built, { ok: true }, 'admin.com', online)

    expect(outcome.kind).toBe('sent')
    expect(outcome).toMatchObject({ broadcast: 'pending', detail: 'no network' })
    expect(w.abortAction).not.toHaveBeenCalled()
  })

  it('reports a toolbox-rejected broadcast as sent-but-pending', async () => {
    const w = payerStub()
    w.createAction.mockResolvedValue({ sendWithResults: [{ txid: 'tx-1', status: 'failed' }] })
    const outcome = await finalizeDelivery(w as never, built, { ok: true }, 'admin.com', online)

    expect(outcome).toMatchObject({ kind: 'sent', broadcast: 'pending' })
    expect(w.abortAction).not.toHaveBeenCalled()
  })

  it('reports sent-but-pending when there is no txid to broadcast', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(w as never, { ...built, txid: undefined }, { ok: true }, 'admin.com', online)

    expect(outcome).toMatchObject({ kind: 'sent', broadcast: 'pending' })
    expect(w.createAction).not.toHaveBeenCalled()
    expect(w.abortAction).not.toHaveBeenCalled()
  })

  it('does not let a failed abort mask the decline', async () => {
    const w = payerStub()
    w.abortAction.mockRejectedValue(new Error('storage down'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      finalizeDelivery(w as never, built, { ok: false, error: 'already_paid' }, 'admin.com', online)
    ).resolves.toEqual({ kind: 'declined', reason: 'already_paid' })
    warn.mockRestore()
  })

  // P1-3: a decline is the payee's own unverifiable claim that nothing was
  // queued. The abort releases the inputs regardless, but the txid is worth
  // watching in case the payee's claim turns out to be wrong (or dishonest).
  describe('watching a declined txid', () => {
    it('watches the txid after a successful decline-abort', async () => {
      const w = payerStub()
      const watchDeclinedAbort = jest.fn().mockResolvedValue(undefined)
      const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', {
        ...online,
        watchDeclinedAbort
      })

      expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
      expect(watchDeclinedAbort).toHaveBeenCalledWith({ txid: 'tx-1', reference: 'ref-1' })
    })

    it('watches the txid even when the abort itself failed', async () => {
      const w = payerStub()
      w.abortAction.mockRejectedValue(new Error('storage down'))
      const watchDeclinedAbort = jest.fn().mockResolvedValue(undefined)
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

      await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', {
        ...online,
        watchDeclinedAbort
      })

      expect(watchDeclinedAbort).toHaveBeenCalledWith({ txid: 'tx-1', reference: 'ref-1' })
      warn.mockRestore()
    })

    it('never watches when there is no txid to watch', async () => {
      const w = payerStub()
      const watchDeclinedAbort = jest.fn().mockResolvedValue(undefined)
      await finalizeDelivery(
        w as never,
        { ...built, txid: undefined },
        { ok: false, error: 'save_failed' },
        'admin.com',
        {
          ...online,
          watchDeclinedAbort
        }
      )

      expect(watchDeclinedAbort).not.toHaveBeenCalled()
    })

    it('a watchDeclinedAbort failure never masks the decline outcome', async () => {
      const w = payerStub()
      const watchDeclinedAbort = jest.fn().mockRejectedValue(new Error('storage down'))
      const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', {
        ...online,
        watchDeclinedAbort
      })

      expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
    })

    it('does not watch at all when no watchDeclinedAbort dep is supplied', async () => {
      const w = payerStub()
      await expect(
        finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', online)
      ).resolves.toEqual({ kind: 'declined', reason: 'save_failed' })
    })
  })

  // XR-095: a decline is the payee's own unverifiable claim that nothing was
  // queued, honest or not. Before releasing the inputs, ask the chain
  // directly — the same BSV-rail check cancelParked.ts already runs — so a
  // txid the network already knows about (the payee's copy is already out)
  // is never raced against a release.
  describe('XR-095: chain-status check before releasing a decline', () => {
    it("does not release inputs when the chain already knows this decline's txid", async () => {
      const w = payerStub()
      const chainAlreadyKnows = jest.fn().mockResolvedValue(true)
      const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', {
        ...online,
        chainAlreadyKnows
      })

      expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
      expect(chainAlreadyKnows).toHaveBeenCalledWith('tx-1')
      expect(w.abortAction).not.toHaveBeenCalled()
    })

    it('still releases inputs on an ordinary decline the chain has never heard of', async () => {
      const w = payerStub()
      const chainAlreadyKnows = jest.fn().mockResolvedValue(false)
      const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', {
        ...online,
        chainAlreadyKnows
      })

      expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
      expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
    })

    it('parks instead of releasing a decline it cannot verify while offline', async () => {
      const w = payerStub()
      const chainAlreadyKnows = jest.fn().mockResolvedValue(false)
      const parkUnverifiable = jest.fn().mockResolvedValue(undefined)
      const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', {
        online: async () => false,
        hold: online.hold,
        chainAlreadyKnows,
        parkUnverifiable
      })

      expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
      expect(chainAlreadyKnows).not.toHaveBeenCalled()
      expect(parkUnverifiable).toHaveBeenCalledWith('tx-1')
      expect(w.abortAction).not.toHaveBeenCalled()
    })

    it('falls back to releasing when offline and no parkUnverifiable dep is wired', async () => {
      const w = payerStub()
      const chainAlreadyKnows = jest.fn().mockResolvedValue(false)
      const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', {
        online: async () => false,
        hold: online.hold,
        chainAlreadyKnows
      })

      expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
      expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
    })

    it('is a no-op for every existing caller: omitting chainAlreadyKnows keeps releasing on any decline', async () => {
      const w = payerStub()
      const outcome = await finalizeDelivery(
        w as never,
        built,
        { ok: false, error: 'save_failed' },
        'admin.com',
        online
      )

      expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
      expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
    })
  })

  // XR-103: a lying decline must not free inputs the payee already spent. If
  // the chain already reports this exact txid known/mined despite the
  // negative ack, abortAction would hand the payer a double-spend against a
  // payment that in fact landed — refuse the abort instead of racing it.
  describe('XR-103: checking chain status before a decline-abort', () => {
    it('refuses to abort when the chain already reports this txid known/mined', async () => {
      const w = payerStub()
      const checkChainStatus = jest.fn().mockResolvedValue({ results: [{ txid: 'tx-1', status: 'known' }] })
      const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', {
        ...online,
        checkChainStatus
      })

      expect(checkChainStatus).toHaveBeenCalledWith(['tx-1'])
      expect(w.abortAction).not.toHaveBeenCalled()
      expect(outcome.kind).not.toBe('declined')
      expect(outcome).toMatchObject({ kind: 'sent', broadcast: 'ok' })
    })

    it('still aborts when the chain does not know this txid', async () => {
      const w = payerStub()
      const checkChainStatus = jest.fn().mockResolvedValue({ results: [{ txid: 'tx-1', status: 'unknown' }] })
      const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', {
        ...online,
        checkChainStatus
      })

      expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
      expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
    })

    it('still aborts when no checkChainStatus dep is supplied (unchanged default behaviour)', async () => {
      const w = payerStub()
      const outcome = await finalizeDelivery(
        w as never,
        built,
        { ok: false, error: 'save_failed' },
        'admin.com',
        online
      )

      expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
      expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
    })

    it('a failing checkChainStatus probe never blocks the ordinary decline-abort', async () => {
      const w = payerStub()
      const checkChainStatus = jest.fn().mockRejectedValue(new Error('offline'))
      const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com', {
        ...online,
        checkChainStatus
      })

      expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
      expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
    })
  })
})

describe('finalizeDelivery when offline', () => {
  const built = { frame: {} as never, reference: 'ref-1', txid: 'aa'.repeat(32), satoshis: 700 }

  it('enqueues instead of broadcasting and reports pending', async () => {
    const wallet = {
      createAction: jest.fn(),
      abortAction: jest.fn(),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn().mockResolvedValue(undefined)
    const r = await finalizeDelivery(wallet as never, built, { ok: true }, 'admin.com', {
      online: async () => false,
      hold
    })
    expect(r).toEqual({ kind: 'sent', broadcast: 'pending', detail: expect.stringMatching(/offline/i) })
    expect(hold).toHaveBeenCalledWith('aa'.repeat(32))
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('holds the frame before broadcasting when online', async () => {
    const order: string[] = []
    const wallet = {
      createAction: jest.fn().mockImplementation(async () => {
        order.push('broadcast')
        return { sendWithResults: [{ txid: built.txid, status: 'sending' }] }
      }),
      abortAction: jest.fn(),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn().mockImplementation(async () => {
      order.push('hold')
    })
    const r = await finalizeDelivery(wallet as never, built, { ok: true }, 'admin.com', {
      online: async () => true,
      hold
    })
    expect(r).toEqual({ kind: 'sent', broadcast: 'ok' })
    expect(hold).toHaveBeenCalledWith(built.txid)
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['hold', 'broadcast'])
  })

  it('does not sendWith when the hold is rejected, even online', async () => {
    const wallet = {
      createAction: jest.fn().mockResolvedValue({ sendWithResults: [{ txid: built.txid, status: 'sending' }] }),
      abortAction: jest.fn(),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn().mockRejectedValue(new Error('db locked'))
    const r = await finalizeDelivery(wallet as never, built, { ok: true }, 'admin.com', {
      online: async () => true,
      hold
    })
    expect(r).toEqual({ kind: 'sent', broadcast: 'pending', detail: 'db locked' })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('still aborts on a negative ack while offline', async () => {
    const wallet = {
      createAction: jest.fn(),
      abortAction: jest.fn().mockResolvedValue({ aborted: true }),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn()
    const r = await finalizeDelivery(wallet as never, built, { ok: false, error: 'declined' }, 'admin.com', {
      online: async () => false,
      hold
    })
    expect(r).toEqual({ kind: 'declined', reason: 'declined' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
    expect(hold).not.toHaveBeenCalled()
  })

  it('queues a failed decline abort for replay', async () => {
    const wallet = {
      createAction: jest.fn(),
      abortAction: jest.fn().mockRejectedValue(new Error('busy')),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn()
    const queueFailedAbort = jest.fn().mockResolvedValue(undefined)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await finalizeDelivery(wallet as never, built, { ok: false, error: 'declined' }, 'admin.com', {
      online: async () => true,
      hold,
      queueFailedAbort
    })
    expect(r).toEqual({ kind: 'declined', reason: 'declined' })
    expect(queueFailedAbort).toHaveBeenCalledWith('ref-1')
    warn.mockRestore()
  })

  it('queues abortAction aborted:false after a decline', async () => {
    const wallet = {
      createAction: jest.fn(),
      abortAction: jest.fn().mockResolvedValue({ aborted: false }),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const queueFailedAbort = jest.fn().mockResolvedValue(undefined)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await finalizeDelivery(wallet as never, built, { ok: false, error: 'declined' }, 'admin.com', {
      online: async () => true,
      hold: jest.fn(),
      queueFailedAbort
    })
    expect(queueFailedAbort).toHaveBeenCalledWith('ref-1')
    warn.mockRestore()
  })

  it('reports pending when the enqueue itself fails', async () => {
    const wallet = {
      createAction: jest.fn(),
      abortAction: jest.fn(),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn().mockRejectedValue(new Error('db locked'))
    const r = await finalizeDelivery(wallet as never, built, { ok: true }, 'admin.com', {
      online: async () => false,
      hold
    })
    expect(r.kind).toBe('sent')
    expect((r as { broadcast: string }).broadcast).toBe('pending')
  })

  // Matches the guard already around every other call to `getOnline` in this
  // codebase: a failed probe must not flip a reachable device into the offline
  // branch, so this falls through to the ordinary broadcast instead.
  it('assumes online when the connectivity probe itself throws', async () => {
    const wallet = {
      createAction: jest.fn().mockResolvedValue({ sendWithResults: [{ txid: built.txid, status: 'sending' }] }),
      abortAction: jest.fn(),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await finalizeDelivery(wallet as never, built, { ok: true }, 'admin.com', {
      online: async () => {
        throw new Error('NetInfo native module unavailable')
      },
      hold
    })
    expect(r).toEqual({ kind: 'sent', broadcast: 'ok' })
    expect(hold).toHaveBeenCalledWith(built.txid)
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  // `hold` is required by the signature, so this is what a JS caller or a cast
  // gets. With no hold there is no queue row and no promotion: the transaction
  // stays at `nosend`, its change unspendable (allocateChangeInput excludes
  // `nosend`), invisible to the drain — which reads only `offline_actions` — and
  // to every monitor task (TaskSendWaiting selects ['unsent','sending'];
  // TaskCheckNoSends never calls sendWith). Telling the user it is queued would
  // be the Task 11 Critical again, reached through a missing argument instead of
  // a throw.
  it('never reports a queue it had no way to make', async () => {
    const wallet = {
      createAction: jest.fn(),
      abortAction: jest.fn(),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const r = await finalizeDelivery(wallet as never, built, { ok: true }, 'admin.com', {
      online: async () => false
    } as never)

    // Still a sent payment — the payee holds a copy — but pending, never queued.
    expect(r).toMatchObject({ kind: 'sent', broadcast: 'pending' })
    expect((r as { detail?: string }).detail).not.toMatch(/queued/i)
    expect((r as { detail?: string }).detail).toMatch(/hold/i)
    // And it must not quietly broadcast either: offline is offline, and a
    // delayed send would come back 'sending' and be reported as broadcast: 'ok'.
    expect(wallet.createAction).not.toHaveBeenCalled()
  })
})
