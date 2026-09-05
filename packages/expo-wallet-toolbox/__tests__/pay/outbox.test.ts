import {
  SENT_RETENTION_MS,
  getOutboxEntries,
  saveOutboxEntry,
  markOutboxSent,
  pruneExpiredSent,
  removeOutboxEntry,
  updateOutboxEntry,
  unsentEntries
} from '../../core/peerpay/outbox'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

const token = {
  customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
  transaction: [1],
  amount: 7
}

describe('sent outbox retention', () => {
  it('does not prune a sent entry younger than 30 days', async () => {
    const s = fakeStorage()
    const id = await saveOutboxEntry(s, { recipient: '02aa', token, messageBoxUrl: 'https://mb', txid: 'ab' })
    await markOutboxSent(s, id)
    expect(await pruneExpiredSent(s)).toBe(0)
    expect(await getOutboxEntries(s)).toHaveLength(1)
    expect(unsentEntries(await getOutboxEntries(s))).toHaveLength(0)
  })

  it('prunes a sent entry older than 30 days and leaves unsent alone', async () => {
    const s = fakeStorage()
    const oldId = await saveOutboxEntry(s, { recipient: '02aa', token, messageBoxUrl: 'https://mb', txid: 'ab' })
    await markOutboxSent(s, oldId)
    const entries = await getOutboxEntries(s)
    entries[0].createdAt = new Date(Date.now() - SENT_RETENTION_MS - 1000).toISOString()
    await s.setKeyValue('peerpay_outbox', JSON.stringify(entries))
    await saveOutboxEntry(s, { recipient: '02bb', token, messageBoxUrl: 'https://mb', txid: 'cd' })
    expect(await pruneExpiredSent(s)).toBe(1)
    const left = await getOutboxEntries(s)
    expect(left).toHaveLength(1)
    expect(left[0].status).toBe('unsent')
  })
})

const payment = (recipient: string) => ({ recipient, token, messageBoxUrl: 'https://mb' })

describe('outbox mutation reliability', () => {
  it('retains both tokens when foreground and background saves overlap', async () => {
    const s = fakeStorage()
    const ids = await Promise.all([saveOutboxEntry(s, payment('02aa')), saveOutboxEntry(s, payment('02bb'))])
    expect((await getOutboxEntries(s)).map(entry => entry.id)).toEqual(ids)
  })

  it('keeps concurrent payments to the same recipient independently addressable with a frozen clock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-05T12:00:00Z'))
    try {
      const s = fakeStorage()
      const baseId = `${Date.now()}_02aa`
      // An existing unsuffixed entry represents the format already on disk.
      const first = await saveOutboxEntry(s, payment('02aa'))
      const [second, third] = await Promise.all([
        saveOutboxEntry(s, payment('02aa')),
        saveOutboxEntry(s, payment('02aa'))
      ])
      expect([first, second, third]).toEqual([baseId, `${baseId}_1`, `${baseId}_2`])
      await Promise.all([updateOutboxEntry(s, first, { delivered: true }), markOutboxSent(s, second)])
      expect(await getOutboxEntries(s)).toEqual([
        expect.objectContaining({ id: first, delivered: true, status: 'unsent' }),
        expect.objectContaining({ id: second, status: 'sent' }),
        expect.objectContaining({ id: third, status: 'unsent' })
      ])
      await removeOutboxEntry(s, second)
      expect((await getOutboxEntries(s)).map(entry => entry.id)).toEqual([first, third])
    } finally {
      jest.useRealTimers()
    }
  })

  it('preserves delivery checkpoints when marking sent overlaps another update', async () => {
    const s = fakeStorage()
    const id = await saveOutboxEntry(s, payment('02aa'))
    await Promise.all([updateOutboxEntry(s, id, { delivering: true, delivered: true }), markOutboxSent(s, id)])
    expect(await getOutboxEntries(s)).toEqual([
      expect.objectContaining({ id, delivering: true, delivered: true, status: 'sent' })
    ])
  })

  it('does not resurrect expired tokens when a new save overlaps pruning', async () => {
    const s = fakeStorage()
    const oldId = await saveOutboxEntry(s, payment('02aa'))
    await markOutboxSent(s, oldId)
    const entries = await getOutboxEntries(s)
    entries[0].createdAt = new Date(0).toISOString()
    await s.setKeyValue('peerpay_outbox', JSON.stringify(entries))
    const [removed, newId] = await Promise.all([pruneExpiredSent(s), saveOutboxEntry(s, payment('02bb'))])
    expect(removed).toBe(1)
    expect((await getOutboxEntries(s)).map(entry => entry.id)).toEqual([newId])
  })

  it('does not resurrect a removed token when another token is updated', async () => {
    const s = fakeStorage()
    const first = await saveOutboxEntry(s, payment('02aa'))
    const second = await saveOutboxEntry(s, payment('02bb'))
    await Promise.all([removeOutboxEntry(s, first), updateOutboxEntry(s, second, { delivered: true })])
    expect(await getOutboxEntries(s)).toEqual([expect.objectContaining({ id: second, delivered: true })])
  })

  const mutations: [string, (s: ReturnType<typeof fakeStorage>, id: string) => Promise<unknown>][] = [
    ['save', s => saveOutboxEntry(s, payment('02bb'))],
    ['mark sent', (s, id) => markOutboxSent(s, id)],
    ['update', (s, id) => updateOutboxEntry(s, id, { delivered: true })],
    ['remove', (s, id) => removeOutboxEntry(s, id)],
    ['prune', s => pruneExpiredSent(s)]
  ]

  it.each(mutations)('%s rejects a failed read without overwriting existing tokens', async (_name, mutate) => {
    const s = fakeStorage()
    const id = await saveOutboxEntry(s, payment('02aa'))
    const before = await s.getKeyValue('peerpay_outbox')
    const write = jest.spyOn(s, 'setKeyValue')
    jest.spyOn(s, 'getKeyValue').mockRejectedValueOnce(new Error('database busy'))
    await expect(mutate(s, id)).rejects.toThrow('database busy')
    expect(write).not.toHaveBeenCalled()
    expect(await s.getKeyValue('peerpay_outbox')).toBe(before)
    // The rejected operation must not poison this storage's mutation queue.
    await updateOutboxEntry(s, id, { delivered: true })
    expect(await getOutboxEntries(s)).toEqual([expect.objectContaining({ id, delivered: true })])
  })

  it.each(['{broken', '{}', 'null'])('preserves unreadable stored data (%s) when a save is attempted', async raw => {
    const s = fakeStorage()
    await s.setKeyValue('peerpay_outbox', raw)
    const write = jest.spyOn(s, 'setKeyValue')
    await expect(saveOutboxEntry(s, payment('02aa'))).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    expect(await s.getKeyValue('peerpay_outbox')).toBe(raw)
    expect(await getOutboxEntries(s)).toEqual([])
  })

  it('preserves the best-effort public reader for unavailable storage', async () => {
    const s = fakeStorage()
    jest.spyOn(s, 'getKeyValue').mockRejectedValue(new Error('database busy'))
    await expect(getOutboxEntries(s)).resolves.toEqual([])
  })

  it('allows a later save after a failed write', async () => {
    const s = fakeStorage()
    jest.spyOn(s, 'setKeyValue').mockRejectedValueOnce(new Error('disk full'))
    await expect(saveOutboxEntry(s, payment('02aa'))).rejects.toThrow('disk full')
    const id = await saveOutboxEntry(s, payment('02bb'))
    expect((await getOutboxEntries(s)).map(entry => entry.id)).toEqual([id])
  })

  it('does not block a different wallet store behind an unfinished mutation', async () => {
    const first = fakeStorage()
    const second = fakeStorage()
    let finishRead!: (raw: string | undefined) => void
    jest.spyOn(first, 'getKeyValue').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishRead = resolve
        })
    )
    const unfinished = saveOutboxEntry(first, payment('02aa'))
    // Let the first mutation reach its suspended read.
    await Promise.resolve()
    try {
      const id = await saveOutboxEntry(second, payment('02bb'))
      expect((await getOutboxEntries(second)).map(entry => entry.id)).toEqual([id])
    } finally {
      finishRead(undefined)
      await unfinished
    }
  })
})
