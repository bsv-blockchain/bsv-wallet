jest.mock('@bsv/mandala', () => ({ decodeToken: jest.fn() }), { virtual: true })
jest.mock('../../core/mandala/receipt', () => ({
  isRetriableReceiptFailure: jest.fn(),
  isTransportReceiptFailure: jest.fn(),
  receiptFailureCode: jest.fn()
}))

import { getPending, processPending, savePending, truncateUtf8Bytes, updateStatus } from '../../core/localpay/pending'
import type { PaymentFrame } from '../../core/localpay/codec'

const encoder = new TextEncoder()

describe('received BSV descriptions at a UTF-8 boundary', () => {
  it.each([
    ['é', 2],
    ['€', 3],
    ['💰', 4]
  ] as const)('drops an incomplete %s instead of expanding its replacement bytes', (scalar, bytes) => {
    for (let remaining = 1; remaining < bytes; remaining++) {
      const prefix = 'a'.repeat(2000 - remaining)
      const result = truncateUtf8Bytes(prefix + scalar, 2000)
      expect(encoder.encode(result).length).toBeLessThanOrEqual(2000)
      expect(result).toBe(prefix)
    }
  })

  it('keeps complete scalars that fit exactly and preserves short text', () => {
    expect(truncateUtf8Bytes('a'.repeat(1996) + '💰', 2000)).toBe('a'.repeat(1996) + '💰')
    expect(truncateUtf8Bytes('paid €5', 2000)).toBe('paid €5')
    expect(truncateUtf8Bytes('💰', 0)).toBe('')
  })

  it.each(['a'.repeat(1999) + '€', 'a'.repeat(1998) + '💰'])(
    'credits a received payment with a note cutting through a scalar',
    async note => {
      const values = new Map<string, string>()
      const storage = {
        getKeyValue: async (key: string) => values.get(key),
        setKeyValue: async (key: string, value: string) => {
          values.set(key, value)
        }
      }
      await savePending(storage, {
        version: 7,
        kind: 'bsv',
        senderIdentityKey: '02'.padEnd(66, 'c'),
        outputIndex: 0,
        derivationPrefix: 'cHJlZml4',
        derivationSuffix: 'c3VmZml4',
        transaction: new Uint8Array([9, 9, 9]),
        note
      } as PaymentFrame)
      const wallet = {
        internalizeAction: jest.fn(async (args: { description: string }) => {
          if (encoder.encode(args.description).length > 2000) throw new Error('description exceeds 2000 bytes')
          return { accepted: true }
        })
      }
      expect(await processPending(wallet as never, storage, 'admin.com')).toEqual([
        expect.objectContaining({ success: true })
      ])
      expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
      expect(await getPending(storage)).toEqual([])
    }
  )

  it('recovers an exhausted description failure without retrying an exhausted invalid payment', async () => {
    const values = new Map<string, string>()
    const storage = {
      getKeyValue: async (key: string) => values.get(key),
      setKeyValue: async (key: string, value: string) => {
        values.set(key, value)
      }
    }
    const payment = {
      version: 7,
      kind: 'bsv',
      senderIdentityKey: '02'.padEnd(66, 'c'),
      outputIndex: 0,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      transaction: new Uint8Array([9, 9, 9]),
      note: 'a'.repeat(1999) + '€'
    } as PaymentFrame
    const repairable = await savePending(storage, payment)
    const invalid = await savePending(storage, { ...payment, senderIdentityKey: '03'.padEnd(66, 'd') })
    await updateStatus(storage, repairable.id, 'failed', 'description exceeds 2000 bytes', 'exhaust')
    await updateStatus(storage, invalid.id, 'failed', 'invalid AtomicBEEF', 'exhaust')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    expect(await processPending(wallet as never, storage, 'admin.com')).toEqual([
      expect.objectContaining({ id: repairable.id, success: true })
    ])
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(encoder.encode(wallet.internalizeAction.mock.calls[0][0].description).length).toBeLessThanOrEqual(2000)
    expect(await getPending(storage)).toEqual([expect.objectContaining({ id: invalid.id, attempts: 3 })])
  })
})
