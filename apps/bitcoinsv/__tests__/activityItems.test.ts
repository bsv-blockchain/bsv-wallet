// tokenRowTitle pulls in @bsv/mandala, whose ESM build Jest doesn't parse
jest.mock('@bsv/expo-wallet-toolbox/ui/screens/tokenRowTitle', () => ({
  tokenRowTitle: ({ role, ticker }: { role: string; ticker: string }) => `${ticker} ${role}`
}))
import { toActivityItems } from '../src/activity/items'

const KEY = '02' + 'ab'.repeat(32)
const t = (k: string) => k
const ctx = (over: Partial<Parameters<typeof toActivityItems>[1]> = {}) => ({
  offline: new Map(),
  tokenByTxid: new Map(),
  contactsByKey: new Map(),
  t,
  ...over
})
const action = (over: Record<string, unknown>) =>
  ({ txid: 'aa'.repeat(32), satoshis: -1500, isOutgoing: true, status: 'completed', description: 'Coffee', labels: [], created_at: '2026-10-09T10:00:00Z', ...over }) as never

describe('toActivityItems', () => {
  it('names the other side from contacts, and keeps the note', () => {
    const [row] = toActivityItems([action({ labels: [KEY] })], ctx({ contactsByKey: new Map([[KEY, { identityKey: KEY, name: 'Ana' }]]) }))
    expect(row).toMatchObject({ title: 'Ana', note: 'Coffee', incoming: false, sats: -1500, contactKey: KEY, pending: false })
    expect(row.counterparty).toEqual({ kind: 'identityKey', value: KEY })
    expect(row.status.tone).toBe('settled')
    expect(row.createdAt).toBe('2026-10-09T10:00:00.000Z')
  })

  it('a stranger reads as a payment sent or received; a generic description is not a note', () => {
    const [sent, got] = toActivityItems(
      [action({ description: 'payment' }), action({ txid: 'bb'.repeat(32), isOutgoing: false, satoshis: 2000, senderIdentityKey: KEY, description: '' })],
      ctx()
    )
    expect(sent).toMatchObject({ title: 'Payment sent', note: undefined })
    expect(got).toMatchObject({ title: 'Payment received', incoming: true, sats: 2000 })
    expect(got.counterparty).toEqual({ kind: 'identityKey', value: KEY })
  })

  it('a payment parked offline is in flight and says so', () => {
    const txid = 'cc'.repeat(32)
    const [row] = toActivityItems([action({ txid, status: 'nosend' })], ctx({ offline: new Map([[txid, { status: 'parked' }]]) }))
    expect(row).toMatchObject({ offlineStatus: 'parked', pending: true, statusText: 'tx_status_parked' })
  })

  it('a stablecoin transfer shows the token, not the satoshis', () => {
    const txid = 'dd'.repeat(32)
    const tok = {
      txid,
      role: 'received',
      asset: { assetId: 'usd1', label: 'Dollar', ticker: 'USDX', decimals: 2, overlayUrl: '', overlayIdentityKey: '' },
      baseUnits: 1250,
      counterpartyKey: KEY,
      status: 'settled',
      at: '2026-10-09T11:00:00.000Z'
    }
    const [row] = toActivityItems([action({ txid, labels: ['mandala'], isOutgoing: false, satoshis: 1 })], ctx({ tokenByTxid: new Map([[txid, tok as never]]) }))
    expect(row.sats).toBeUndefined()
    expect(row.token).toMatchObject({ unit: 'USDX', assetId: 'usd1' })
    expect(row.token?.figure).toContain('12.50')
    expect(row).toMatchObject({ incoming: true, createdAt: '2026-10-09T11:00:00.000Z' })
  })

  it("a stablecoin's rail wording is not shown as a note", () => {
    const txid = 'ee'.repeat(32)
    const tok = {
      txid,
      role: 'received',
      asset: { assetId: 'usd1', label: 'Dollar', ticker: 'USDX', decimals: 2, overlayUrl: '', overlayIdentityKey: '' },
      baseUnits: 1250,
      counterpartyKey: KEY,
      status: 'settled',
      at: '2026-10-09T11:00:00.000Z'
    }
    const [row] = toActivityItems(
      [action({ txid, labels: ['mandala', 'receive'], description: 'Receive 1250 of usd1', isOutgoing: false, satoshis: 1 })],
      ctx({ tokenByTxid: new Map([[txid, tok as never]]) })
    )
    expect(row.title).toBe('USDX received')
    expect(row.note).toBeUndefined()
  })

  it('a row with no txid yet is keyed by its reference', () => {
    const [row] = toActivityItems([action({ txid: '', reference: 'ref-1', status: 'unsigned' })], ctx())
    expect(row.id).toBe('ref-1')
    expect(row.txid).toBeUndefined()
  })
})
