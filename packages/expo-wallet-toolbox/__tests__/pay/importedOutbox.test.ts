import { PrivateKey } from '@bsv/sdk'
import { ADMIN, sender, signedPayment } from '../__helpers__/signedPeerPay'
import {
  OUTBOX_KEY,
  getOutboxEntries,
  getOutboxEntriesStrict,
  markOutboxSent,
  updateOutboxEntry,
  isSentExpired,
  quarantineImportedOutbox,
  releaseImportedOutboxEntry,
  saveOutboxEntry,
  unsentEntries,
  validateImportedOutboxEntry
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
const wallet = { getPublicKey: jest.fn(sender.getPublicKey.bind(sender)) }
let payment: Parameters<typeof saveOutboxEntry>[1]

beforeAll(async () => {
  payment = await signedPayment()
})
beforeEach(() => wallet.getPublicKey.mockClear())

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
    const approved = await releaseImportedOutboxEntry(s, reviewed, wallet, ADMIN)
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
      await expect(releaseImportedOutboxEntry(s, reviewed, wallet, ADMIN)).rejects.toThrow(/changed|review/i)
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

describe('imported payment terms match the signed output', () => {
  async function held(overrides: Partial<Parameters<typeof saveOutboxEntry>[1]> = {}) {
    const s = storage()
    await saveOutboxEntry(s, { ...payment, ...overrides })
    await quarantineImportedOutbox(s)
    const [entry] = await getOutboxEntries(s)
    return { s, entry }
  }

  it('validates the displayed snapshot and validates it again before release without changing signed bytes', async () => {
    const { s, entry } = await held()
    const reviewed = await validateImportedOutboxEntry(entry, wallet, ADMIN)
    expect(reviewed).toEqual(entry)
    expect(reviewed).not.toBe(entry)
    const approved = await releaseImportedOutboxEntry(s, reviewed, wallet, ADMIN)
    expect(approved.token.transaction).toEqual(payment.token.transaction)
    expect(wallet.getPublicKey).toHaveBeenCalledTimes(2)
    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      {
        protocolID: [2, '3241645161d8'],
        keyID: 'cHJlZml4 c3VmZml4',
        counterparty: payment.recipient
      },
      ADMIN
    )
  })

  it.each(['amount', 'recipient', 'prefix', 'suffix', 'index', 'txid'] as const)(
    'rejects inconsistent %s before display and release',
    async field => {
      const replacement = JSON.parse(JSON.stringify(payment)) as typeof payment
      if (field === 'amount') replacement.token.amount = 999
      if (field === 'recipient') replacement.recipient = new PrivateKey(12).toPublicKey().toString()
      if (field === 'prefix') replacement.token.customInstructions.derivationPrefix = 'b3RoZXI='
      if (field === 'suffix') replacement.token.customInstructions.derivationSuffix = 'b3RoZXI='
      if (field === 'index') replacement.token.outputIndex = 10
      if (field === 'txid') replacement.txid = 'ab'.repeat(32)
      const { s, entry } = await held(replacement)
      await expect(validateImportedOutboxEntry(entry, wallet, ADMIN)).rejects.toThrow()
      await expect(releaseImportedOutboxEntry(s, entry, wallet, ADMIN)).rejects.toThrow()
      expect((await getOutboxEntries(s))[0].status).toBe('import_hold')
    }
  )

  it('accepts a valid rebuilt token whose signed recipient output is not output zero', async () => {
    const rebuilt = await signedPayment(1)
    const { s, entry } = await held(rebuilt)
    await expect(validateImportedOutboxEntry(entry, wallet, ADMIN)).resolves.toEqual(entry)
    await expect(releaseImportedOutboxEntry(s, entry, wallet, ADMIN)).resolves.toMatchObject({ status: 'unsent' })
    const wrongIndex = { ...entry, token: { ...entry.token, outputIndex: 0 } }
    await expect(validateImportedOutboxEntry(wrongIndex, wallet, ADMIN)).rejects.toThrow()
  })

  it('keeps legacy already-broadcast signed tokens reviewable when their stored txid is absent', async () => {
    const legacy = { ...payment }
    delete legacy.txid
    const { s, entry } = await held({ ...legacy, txid: undefined })
    const approved = await releaseImportedOutboxEntry(s, entry, wallet, ADMIN)
    expect(approved.txid).toBeUndefined()
    expect(approved.token).toEqual(payment.token)
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER])('rejects invalid signed-output indices %s', async outputIndex => {
    const { entry } = await held({ token: { ...payment.token, outputIndex } })
    await expect(validateImportedOutboxEntry(entry, wallet, ADMIN)).rejects.toThrow()
  })

  it('rejects a zero-valued signed payment and malformed AtomicBEEF', async () => {
    const { entry } = await held(await signedPayment(0, 0))
    await expect(validateImportedOutboxEntry(entry, wallet, ADMIN)).rejects.toThrow()
    const malformed = { ...entry, token: { ...entry.token, amount: 17, transaction: [1, 2, 3] } }
    await expect(validateImportedOutboxEntry(malformed, wallet, ADMIN)).rejects.toThrow()
  })
})

describe('imported payment validation rejects unusable review data', () => {
  async function entry() {
    const s = storage()
    await saveOutboxEntry(s, payment)
    await quarantineImportedOutbox(s)
    return { s, held: (await getOutboxEntries(s))[0] }
  }

  it.each([null, {}, [], { transaction: [] }, { transaction: [256] }, { transaction: [-1] }, { transaction: [0.5] }])(
    'rejects invalid token bytes %p',
    async token => {
      const { held } = await entry()
      await expect(validateImportedOutboxEntry({ ...held, token } as never, wallet, ADMIN)).rejects.toThrow()
    }
  )

  it.each([null, 7, '', 'not-a-txid'])('rejects a present invalid txid %p', async txid => {
    const { held } = await entry()
    await expect(validateImportedOutboxEntry({ ...held, txid } as never, wallet, ADMIN)).rejects.toThrow()
  })

  it.each([
    { customInstructions: null },
    { customInstructions: { derivationPrefix: 1, derivationSuffix: 's' } },
    { customInstructions: { derivationPrefix: '', derivationSuffix: 's' } },
    { customInstructions: { derivationPrefix: 'p', derivationSuffix: 1 } },
    { customInstructions: { derivationPrefix: 'p', derivationSuffix: '' } }
  ])('rejects unusable recipient derivation data %p', async patch => {
    const { held } = await entry()
    await expect(
      validateImportedOutboxEntry({ ...held, token: { ...held.token, ...patch } } as never, wallet, ADMIN)
    ).rejects.toThrow()
  })

  it.each([null, 1, 'not-a-public-key', `02${'ff'.repeat(32)}`])(
    'rejects invalid recipient keys %p',
    async recipient => {
      const { held } = await entry()
      await expect(validateImportedOutboxEntry({ ...held, recipient } as never, wallet, ADMIN)).rejects.toThrow()
    }
  )

  it('refuses a displayed amount outside the safe-integer range', async () => {
    const { held } = await entry()
    await expect(validateImportedOutboxEntry({
      ...held, token: { ...held.token, amount: Number.MAX_SAFE_INTEGER + 1 }
    }, wallet, ADMIN)).rejects.toThrow()
  })

  it('never treats a missing or already-released record as new approval', async () => {
    const { s, held } = await entry()
    await expect(validateImportedOutboxEntry({ ...held, status: 'unsent' }, wallet, ADMIN)).rejects.toThrow()
    await s.setKeyValue(OUTBOX_KEY, '[]')
    await expect(releaseImportedOutboxEntry(s, held, wallet, ADMIN)).rejects.toThrow(/changed|review/i)
    await s.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...held, status: 'sent' }]))
    await expect(releaseImportedOutboxEntry(s, held, wallet, ADMIN)).rejects.toThrow(/changed|review/i)
  })

  it.each([null, 1])('rejects malformed imported rows %p without rewriting them', async malformed => {
    const s = storage()
    await s.setKeyValue(OUTBOX_KEY, JSON.stringify([malformed]))
    await expect(quarantineImportedOutbox(s)).rejects.toThrow()
    expect(await s.getKeyValue(OUTBOX_KEY)).toBe(JSON.stringify([malformed]))
  })

  it('preserves delivery routing fields and exposes strict reads while ignoring missing update targets', async () => {
    const s = storage()
    await saveOutboxEntry(s, { ...payment, recipientHost: 'https://recipient.example', via: 'direct' })
    const [saved] = await getOutboxEntriesStrict(s)
    expect(saved).toMatchObject({ recipientHost: 'https://recipient.example', via: 'direct' })
    await updateOutboxEntry(s, 'absent', { status: 'sent' })
    await markOutboxSent(s, 'absent')
    expect(await getOutboxEntriesStrict(s)).toEqual([saved])
    expect(isSentExpired({ ...saved, status: 'sent', createdAt: '' })).toBe(true)
    expect(isSentExpired({ ...saved, status: 'sent', createdAt: 'invalid' })).toBe(true)
  })
})
