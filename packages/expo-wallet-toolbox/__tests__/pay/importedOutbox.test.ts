import {
  OUTBOX_KEY,
  getOutboxEntries,
  quarantineImportedOutbox,
  releaseImportedOutboxEntry,
  saveOutboxEntry,
  unsentEntries
} from '../../core/peerpay/outbox'

function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getKeyValue: async (key: string) => values.get(key),
    setKeyValue: async (key: string, value: string) => {
      values.set(key, value)
    }
  }
}
const payment = {
  recipient: '02aa',
  messageBoxUrl: 'https://message.example',
  token: { customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }, transaction: [1, 2, 3], amount: 17 },
  txid: 'ab'.repeat(32)
}

describe('imported PeerPay outgoing authority', () => {
  it('preserves the signed token but quarantines a pre-cancellation unsent entry', async () => {
    const s = storage()
    await saveOutboxEntry(s, payment)
    const [before] = await getOutboxEntries(s)
    expect(await quarantineImportedOutbox(s)).toBe(1)
    const [held] = await getOutboxEntries(s)
    expect(held).toEqual({ ...before, status: 'import_hold' })
    expect(unsentEntries([held])).toEqual([])
    expect(await quarantineImportedOutbox(s)).toBe(0)
  })

  it('never drains unknown imported statuses, and preserves sent history', async () => {
    const s = storage()
    await saveOutboxEntry(s, payment)
    const [entry] = await getOutboxEntries(s)
    const records = [
      { ...entry, id: 'unknown', status: 'future_status' },
      { ...entry, id: 'sent', status: 'sent' }
    ]
    expect(unsentEntries(records as never)).toEqual([])
    await s.setKeyValue(OUTBOX_KEY, JSON.stringify(records))
    await quarantineImportedOutbox(s)
    expect((await getOutboxEntries(s)).map(e => e.status)).toEqual(['import_hold', 'sent'])
  })

  it('resumes only the exact held payment explicitly reviewed by its caller', async () => {
    const s = storage()
    await saveOutboxEntry(s, payment)
    await quarantineImportedOutbox(s)
    const [reviewed] = await getOutboxEntries(s)
    const approved = await releaseImportedOutboxEntry(s, reviewed)
    expect(approved.status).toBe('unsent')
    expect(approved.token).toEqual(payment.token)
    expect(unsentEntries(await getOutboxEntries(s))).toEqual([approved])
  })

  it.each(['recipient', 'token', 'txid', 'recipientHost'] as const)(
    'refuses stale review if the stored %s changed',
    async key => {
      const s = storage()
      await saveOutboxEntry(s, payment)
      await quarantineImportedOutbox(s)
      const [reviewed] = await getOutboxEntries(s)
      const replacement = { ...reviewed, [key]: key === 'token' ? { ...reviewed.token, amount: 999 } : 'changed' }
      await s.setKeyValue(OUTBOX_KEY, JSON.stringify([replacement]))
      await expect(releaseImportedOutboxEntry(s, reviewed)).rejects.toThrow(/changed|review/i)
      expect(unsentEntries(await getOutboxEntries(s))).toEqual([])
    }
  )

  it('fails a corrupt imported outbox instead of erasing its contents', async () => {
    const s = storage()
    await s.setKeyValue(OUTBOX_KEY, '{bad')
    await expect(quarantineImportedOutbox(s)).rejects.toThrow()
    expect(s.values.get(OUTBOX_KEY)).toBe('{bad')
  })
})
