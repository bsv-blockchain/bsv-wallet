import {
  SENT_RETENTION_MS,
  getOutboxEntries,
  saveOutboxEntry,
  markOutboxSent,
  pruneExpiredSent,
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
