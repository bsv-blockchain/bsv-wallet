import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import {
  getOutboxEntries,
  isPaymailEntry,
  isPeerPayEntry,
  pruneExpiredSent,
  quarantineImportedOutbox,
  releaseImportedOutboxEntry,
  saveOutboxEntry,
  savePaymailOutboxEntry,
  unsentEntries,
  validateImportedOutboxEntry,
  OUTBOX_KEY,
  type PaymailOutboxEntry
} from '../../core/peerpay/outbox'
import { ADMIN, sender, signedPayment } from '../__helpers__/signedPeerPay'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

function makeBeef(): { beefHex: string; txid: string } {
  const key = new PrivateKey(21)
  const tx = new Transaction()
  tx.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 500 })
  return { beefHex: tx.toHexBEEF(), txid: tx.id('hex') }
}

const ENDPOINT = 'https://hc.example/api/receive-beef/alice'

async function savePm(storage: ReturnType<typeof fakeStorage>, over: Record<string, unknown> = {}) {
  const { beefHex, txid } = makeBeef()
  const id = await savePaymailOutboxEntry(storage, {
    paymail: 'alice@hc.example',
    endpoint: ENDPOINT,
    paymailReference: 'ref-1',
    beefHex,
    satoshis: 500,
    txid,
    note: 'hi',
    ...over
  } as Parameters<typeof savePaymailOutboxEntry>[1])
  return { id, beefHex, txid }
}

async function heldPm(storage: ReturnType<typeof fakeStorage>, over: Record<string, unknown> = {}) {
  const { id } = await savePm(storage, over)
  await quarantineImportedOutbox(storage)
  const entry = (await getOutboxEntries(storage)).find(e => e.id === id)!
  return entry as PaymailOutboxEntry
}

describe('paymail outbox entries', () => {
  afterEach(() => jest.restoreAllMocks())

  it('savePaymailOutboxEntry stores a paymail row with status unsent and a pm id', async () => {
    const storage = fakeStorage()
    const { id, txid } = await savePm(storage)
    expect(id).toMatch(new RegExp(`^\\d+_pm_${txid.slice(0, 8)}$`))
    const [row] = await getOutboxEntries(storage)
    expect(row).toMatchObject({
      kind: 'paymail',
      id,
      status: 'unsent',
      txid,
      paymail: 'alice@hc.example',
      endpoint: ENDPOINT,
      paymailReference: 'ref-1',
      satoshis: 500,
      note: 'hi'
    })
    expect(typeof row.createdAt).toBe('string')
  })

  it('two saves in one millisecond get different ids', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const storage = fakeStorage()
    const { beefHex, txid } = makeBeef()
    const params = { paymail: 'a@b.example', endpoint: ENDPOINT, paymailReference: 'r', beefHex, satoshis: 5, txid }
    const a = await savePaymailOutboxEntry(storage, params)
    const b = await savePaymailOutboxEntry(storage, params)
    expect(a).not.toBe(b)
    expect(await getOutboxEntries(storage)).toHaveLength(2)
  })

  it('getOutboxEntries returns peerpay and paymail rows together; isPaymailEntry and isPeerPayEntry split them', async () => {
    const storage = fakeStorage()
    await saveOutboxEntry(storage, await signedPayment())
    await savePm(storage)
    const rows = await getOutboxEntries(storage)
    expect(rows).toHaveLength(2)
    expect(rows.filter(isPaymailEntry)).toHaveLength(1)
    expect(rows.filter(isPeerPayEntry)).toHaveLength(1)
  })

  it('a row with no kind is a peerpay row', async () => {
    const storage = fakeStorage()
    await saveOutboxEntry(storage, await signedPayment())
    const [row] = await getOutboxEntries(storage)
    expect(row.kind).toBeUndefined()
    expect(isPeerPayEntry(row)).toBe(true)
    expect(isPaymailEntry(row)).toBe(false)
  })

  it('quarantineImportedOutbox holds an unsent paymail row', async () => {
    const storage = fakeStorage()
    await savePm(storage)
    expect(await quarantineImportedOutbox(storage)).toBe(1)
    expect((await getOutboxEntries(storage))[0].status).toBe('import_hold')
  })

  it('unsentEntries and pruneExpiredSent handle paymail rows', async () => {
    const storage = fakeStorage()
    const { id } = await savePm(storage)
    expect(unsentEntries(await getOutboxEntries(storage)).map(e => e.id)).toEqual([id])
    const rows = JSON.parse(storage.map.get(OUTBOX_KEY)!)
    rows[0].status = 'sent'
    rows[0].createdAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    storage.map.set(OUTBOX_KEY, JSON.stringify(rows))
    expect(await pruneExpiredSent(storage)).toBe(1)
    expect(await getOutboxEntries(storage)).toHaveLength(0)
  })

  it('validateImportedOutboxEntry accepts a paymail row whose beefHex hashes to txid', async () => {
    const entry = await heldPm(fakeStorage())
    await expect(validateImportedOutboxEntry(entry, sender, ADMIN)).resolves.toMatchObject({ id: entry.id })
  })

  it.each([
    ['whose txid differs from the beefHex txid', { txid: 'a'.repeat(64) }],
    ['whose endpoint is http://', { endpoint: 'http://hc.example/x' }],
    ['whose endpoint is a private host', { endpoint: 'https://127.0.0.1/x' }],
    ['with satoshis 0', { satoshis: 0 }],
    ['with beefHex that is not BEEF', { beefHex: 'deadbeef' }]
  ])('validateImportedOutboxEntry rejects a paymail row %s', async (_name, over) => {
    const entry = await heldPm(fakeStorage(), over)
    await expect(validateImportedOutboxEntry(entry, sender, ADMIN)).rejects.toThrow(/^Imported payment/)
  })

  it('releaseImportedOutboxEntry turns a validated paymail row into unsent and clears delivered, delivering, refused, receiverTxid and receiverNote', async () => {
    const storage = fakeStorage()
    const { id } = await savePm(storage)
    const rows = JSON.parse(storage.map.get(OUTBOX_KEY)!)
    Object.assign(rows[0], {
      delivered: true,
      delivering: true,
      refused: true,
      receiverTxid: 'f'.repeat(64),
      receiverNote: 'thanks',
      lastAttemptAt: new Date().toISOString(),
      lastError: 'boom'
    })
    storage.map.set(OUTBOX_KEY, JSON.stringify(rows))
    await quarantineImportedOutbox(storage)
    const held = (await getOutboxEntries(storage)).find(e => e.id === id)!
    const released = (await releaseImportedOutboxEntry(storage, held, sender, ADMIN)) as PaymailOutboxEntry
    expect(released.status).toBe('unsent')
    for (const k of ['delivered', 'delivering', 'refused', 'receiverTxid', 'receiverNote', 'lastAttemptAt', 'lastError']) {
      expect(released).not.toHaveProperty(k)
    }
    const stored = (await getOutboxEntries(storage))[0] as PaymailOutboxEntry
    expect(stored.status).toBe('unsent')
    expect(stored.delivered).toBeUndefined()
  })
})
