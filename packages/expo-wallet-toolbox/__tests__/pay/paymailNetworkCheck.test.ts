import {
  NETWORK_CALL_DEADLINE_MS,
  networkKnowsTxid,
  statusFnFromStorage,
  withDeadline,
  type StatusFn
} from '../../core/pay/paymail/networkCheck'

const TXID = 'ab'.repeat(32)

describe('withDeadline', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('rejects after ms and passes a fast result through', async () => {
    await expect(withDeadline(Promise.resolve(7), 50)).resolves.toBe(7)
    const slow = withDeadline(new Promise<number>(() => {}), 50)
    const assertion = expect(slow).rejects.toThrow('deadline')
    await jest.advanceTimersByTimeAsync(51)
    await assertion
  })
})

describe('networkKnowsTxid', () => {
  it('a StatusFn that never resolves gives error after the deadline', async () => {
    jest.useFakeTimers()
    try {
      const fn: StatusFn = () => new Promise(() => {})
      const p = networkKnowsTxid(fn, TXID)
      await jest.advanceTimersByTimeAsync(NETWORK_CALL_DEADLINE_MS + 1)
      await expect(p).resolves.toBe('error')
    } finally {
      jest.useRealTimers()
    }
  })

  it('known for mined', async () => {
    const fn: StatusFn = async () => ({ results: [{ txid: TXID, status: 'mined' }] })
    await expect(networkKnowsTxid(fn, TXID)).resolves.toBe('known')
  })
  it('known for known', async () => {
    const fn: StatusFn = async () => ({ results: [{ txid: TXID, status: 'known' }] })
    await expect(networkKnowsTxid(fn, TXID)).resolves.toBe('known')
  })
  it('unknown for unknown', async () => {
    const fn: StatusFn = async () => ({ results: [{ txid: TXID, status: 'unknown' }] })
    await expect(networkKnowsTxid(fn, TXID)).resolves.toBe('unknown')
  })
  it('unknown when the txid has no row', async () => {
    const fn: StatusFn = async () => ({ results: [{ txid: 'cd'.repeat(32), status: 'mined' }] })
    await expect(networkKnowsTxid(fn, TXID)).resolves.toBe('unknown')
  })
  it('error when the call throws', async () => {
    const fn: StatusFn = async () => {
      throw new Error('down')
    }
    await expect(networkKnowsTxid(fn, TXID)).resolves.toBe('error')
  })
  it('error when the top status is error', async () => {
    const fn: StatusFn = async () => ({ status: 'error', results: [{ txid: TXID, status: 'mined' }] })
    await expect(networkKnowsTxid(fn, TXID)).resolves.toBe('error')
  })
  it('error when results is missing', async () => {
    const fn: StatusFn = async () => ({})
    await expect(networkKnowsTxid(fn, TXID)).resolves.toBe('error')
  })
  it('txid compare ignores case', async () => {
    const fn: StatusFn = async () => ({ results: [{ txid: TXID.toUpperCase(), status: 'mined' }] })
    await expect(networkKnowsTxid(fn, TXID)).resolves.toBe('known')
    const fn2: StatusFn = async () => ({ results: [{ txid: TXID, status: 'mined' }] })
    await expect(networkKnowsTxid(fn2, TXID.toUpperCase())).resolves.toBe('known')
  })
})

describe('statusFnFromStorage', () => {
  it('throws status_unavailable when services lack getStatusForTxids', async () => {
    const fn = statusFnFromStorage({ getServices: () => ({}) })
    await expect(fn([TXID])).rejects.toThrow('status_unavailable')
  })
  it('passes the txids through', async () => {
    const getStatusForTxids = jest.fn().mockResolvedValue({ results: [] })
    const fn = statusFnFromStorage({ getServices: () => ({ getStatusForTxids }) })
    await fn([TXID])
    expect(getStatusForTxids).toHaveBeenCalledWith([TXID])
  })
})
