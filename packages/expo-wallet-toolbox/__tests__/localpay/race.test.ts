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
 */
function fakeRadio(kind: RadioKind) {
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
        s.addEventListener('abort', () => reject(new Error('cancelled')))
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
    expect(onError).toHaveBeenCalledWith(
      'nearby',
      expect.objectContaining({ message: 'connect timeout: no route to peer' })
    )
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

  it('declines the loser when two radios deliver before the arbitration drains', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble')
    const race = raceReceivers([awdl.transport, ble.transport], session, new AbortController().signal, jest.fn())

    // Two payers inside one tick. Both listeners resolve BEFORE either of the
    // race's own handlers runs, so the loser's frame really does reach
    // arbitration — the abort that follows cannot un-resolve an already
    // resolved promise. This is the reachable path to the late-frame decline:
    // exactly one payment is written, and the second payer is told, rather
    // than being left on a green "Sent" until its own timeout.
    awdl.deliver()
    ble.deliver()

    const winner = await race
    expect(winner.kind).toBe('awdl')
    expect(ble.confirm).toHaveBeenCalledWith(false, 'save_failed')
    expect(awdl.confirm).not.toHaveBeenCalled()
  })

  it('treats a synchronous throw from receive() as that radio failing, not as the race failing', async () => {
    // A native accessor that is not there throws rather than rejecting. If that
    // escaped the executor it would reject the whole race and leave the sibling
    // listening with nobody waiting on it — the payee would sit on a dead
    // screen while a perfectly good radio held an open listener.
    const boom: LocalPaymentTransport = {
      kind: 'nearby',
      receive: jest.fn(() => {
        throw new Error('no native module')
      }),
      send: jest.fn(() => Promise.reject(new Error('not under test')))
    }
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const race = raceReceivers([boom, ble.transport], session, new AbortController().signal, onError)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('nearby', expect.objectContaining({ message: 'no native module' }))
    // Non-terminal: the sibling was still started, and was not aborted.
    expect(ble.started()).toBe(1)
    expect(ble.aborted()).toBe(false)
    await expect(settledOrPending(race)).resolves.toBe('pending')

    ble.deliver()
    await expect(race).resolves.toEqual(expect.objectContaining({ kind: 'ble' }))
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
