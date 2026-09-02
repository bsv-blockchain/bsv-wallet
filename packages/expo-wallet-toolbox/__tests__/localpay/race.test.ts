import { raceReceivers, type RadioKind } from '../../core/localpay/transport/race'
import { mintSession } from '../../core/localpay/session'
import { FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import type { LocalPaymentTransport, ReceivedFrame } from '../../core/localpay/types'

const session = mintSession({
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  supportsAwdl: true
})

const frame: PaymentFrame = {
  version: FRAME_VERSION,
  kind: 'bsv' as const,
  senderIdentityKey: '02'.padEnd(66, 'e'),
  outputIndex: 0,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  transaction: new Uint8Array([1, 2, 3])
}

/**
 * A transport whose receive() is settled by the test, and which records the
 * signal it was given so the test can see whether the race aborted it.
 *
 * `rejectOnAbort` mirrors socket.ts, where an aborted listener rejects
 * 'cancelled', and is what every test but the late-frame one wants. That one
 * needs a transport whose already-decoded frame can still land AFTER the JS
 * abort — stopListening() is best-effort on the native side — which a fake
 * that rejects itself on abort can never model: its promise is already
 * settled, so a later resolve is a no-op and the arbitration never sees the
 * frame at all.
 */
function fakeRadio(kind: RadioKind, opts: { rejectOnAbort?: boolean } = {}) {
  let resolveFn: ((r: ReceivedFrame) => void) | undefined
  let rejectFn: ((e: unknown) => void) | undefined
  let signal: AbortSignal | undefined
  const confirm = jest.fn(async () => {})
  const transport: LocalPaymentTransport = {
    kind,
    receive: jest.fn((_session, s: AbortSignal) => {
      signal = s
      return new Promise<ReceivedFrame>((resolve, reject) => {
        resolveFn = resolve
        rejectFn = reject
        // Mirror socket.ts: an aborted listener rejects 'cancelled'.
        if (opts.rejectOnAbort !== false) s.addEventListener('abort', () => reject(new Error('cancelled')))
      })
    }),
    send: jest.fn(() => Promise.reject(new Error('not under test')))
  }
  return {
    transport,
    confirm,
    deliver: () => resolveFn?.({ frame, confirm }),
    fail: (e: Error) => rejectFn?.(e),
    aborted: () => signal?.aborted ?? false,
    started: () => (transport.receive as jest.Mock).mock.calls.length
  }
}

/** Resolves 'pending' if `p` has not settled within a macrotask. */
async function settledOrPending<T>(p: Promise<T>): Promise<'settled' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    p.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    new Promise<'pending'>(resolve => {
      timer = setTimeout(() => resolve('pending'), 20)
    })
  ])
  clearTimeout(timer)
  return outcome
}

describe('raceReceivers', () => {
  it('starts every radio and returns the first frame with its kind, aborting the others', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const race = raceReceivers([awdl.transport, ble.transport], session, new AbortController().signal, onError)

    expect(awdl.started()).toBe(1)
    expect(ble.started()).toBe(1)
    ble.deliver()

    const winner = await race
    expect(winner.kind).toBe('ble')
    expect(winner.frame).toEqual(frame)
    expect(winner.confirm).toBe(ble.confirm)
    expect(awdl.aborted()).toBe(true)
    expect(ble.aborted()).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports one radio failing without settling, then resolves when the other delivers', async () => {
    const nearby = fakeRadio('nearby')
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const race = raceReceivers([nearby.transport, ble.transport], session, new AbortController().signal, onError)

    nearby.fail(new Error('connect timeout: no route to peer'))
    await expect(settledOrPending(race)).resolves.toBe('pending')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('nearby', expect.objectContaining({ message: 'connect timeout: no route to peer' }))
    expect(ble.aborted()).toBe(false)

    ble.deliver()
    await expect(race).resolves.toEqual(expect.objectContaining({ kind: 'ble' }))
  })

  it('rejects with the last error only once every radio has failed', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const race = raceReceivers([awdl.transport, ble.transport], session, new AbortController().signal, onError)
    // Attach the rejection handler before failing anything so Jest never sees an unhandled rejection.
    const outcome = race.then(
      () => 'resolved' as const,
      (e: Error) => e.message
    )

    awdl.fail(new Error('bluetooth unavailable'))
    ble.fail(new Error('peer failed the session proof'))

    await expect(outcome).resolves.toBe('peer failed the session proof')
    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError.mock.calls.map(([kind]) => kind)).toEqual(['awdl', 'ble'])
  })

  it('aborts every radio and rejects cancelled when the outer signal aborts', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const controller = new AbortController()
    const race = raceReceivers([awdl.transport, ble.transport], session, controller.signal, onError)

    controller.abort()

    await expect(race).rejects.toThrow('cancelled')
    expect(awdl.aborted()).toBe(true)
    expect(ble.aborted()).toBe(true)
    // The listeners' own 'cancelled' rejections are consequences of the abort, not radio failures.
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not report a loser that rejects after being aborted', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const race = raceReceivers([awdl.transport, ble.transport], session, new AbortController().signal, onError)

    awdl.deliver()
    await race
    // The fake rejects 'cancelled' synchronously inside abort(); give the microtask queue a turn.
    await Promise.resolve()
    expect(onError).not.toHaveBeenCalled()
  })

  it('declines a frame a second radio delivers after the race is already decided', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble', { rejectOnAbort: false })
    const race = raceReceivers([awdl.transport, ble.transport], session, new AbortController().signal, jest.fn())

    awdl.deliver()
    await race
    // A resolve after abort cannot happen through socket.ts, but the arbitration
    // must still tell such a payer that nothing was written for its frame.
    ble.deliver()
    await Promise.resolve()
    expect(ble.confirm).toHaveBeenCalledWith(false, 'save_failed')
    expect(awdl.confirm).not.toHaveBeenCalled()
  })

  it('rejects immediately with nothing to listen on', async () => {
    await expect(raceReceivers([], session, new AbortController().signal, jest.fn())).rejects.toThrow(
      'no radio transports to listen on'
    )
  })

  it('rejects immediately on an already-aborted signal without starting a radio', async () => {
    const ble = fakeRadio('ble')
    const controller = new AbortController()
    controller.abort()
    await expect(raceReceivers([ble.transport], session, controller.signal, jest.fn())).rejects.toThrow('cancelled')
    expect(ble.started()).toBe(0)
  })
})
