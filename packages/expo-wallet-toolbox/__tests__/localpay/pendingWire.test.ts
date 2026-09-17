/**
 * The pending queue is JSON in a KV row, and `JSON.stringify` turns a
 * `Uint8Array` into an index-keyed object (`{"0":1,"1":2}`) — which is what a
 * token frame's linkage payloads, certificates and σ_I signatures became on
 * every read-back. `processPending` then handed that rehydrated frame to
 * `onTokenHeld`, whose `putLinkage` bound a plain object: Android's expo-sqlite
 * stringifies it into a TEXT row, so the next send that walked the received
 * coin's ancestry died on `token_linkage_payloads.payloadBytes is not readable
 * as bytes` (2026-09-16). Every byte field must survive the queue.
 */
import { Beef, Transaction } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { encodeFrame, FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import {
  getPending,
  PENDING_KEY,
  processPending,
  savePending,
  updateStatus,
  type KVStorage
} from '../../core/localpay/pending'

const ASSET = 'ab'.repeat(32) + '.0'

function memoryStorage(): KVStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>()
  return {
    raw,
    getKeyValue: async k => raw.get(k),
    setKeyValue: async (k, v) => {
      raw.set(k, v)
    }
  }
}

/** A real AtomicBEEF, so `processPending` can read `atomicTxid` off it. */
function tokenBeef(): { bytes: Uint8Array; txid: string } {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET, 250, new Array(20).fill(9)) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const txid = tx.id('hex')
  return { bytes: new Uint8Array(beef.toBinaryAtomic(txid)), txid }
}

function tokenFrame(): PaymentFrame {
  return {
    version: FRAME_VERSION,
    kind: 'token',
    senderIdentityKey: '02'.padEnd(66, 'a'),
    outputIndex: 0,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    token: {
      assetId: ASSET,
      overlayUrl: 'https://overlay.issuer.example',
      overlayIdentityKey: '03'.padEnd(66, 'b'),
      certificates: [new Uint8Array([9, 9, 9]), new Uint8Array([])],
      linkage: [
        { txid: 'cd'.repeat(32), payload: new Uint8Array([1, 2, 3]) },
        { txid: 'ef'.repeat(32), payload: new Uint8Array([4, 250]) }
      ],
      admissions: [
        {
          txid: '11'.repeat(32),
          outputsToAdmit: [0, 3, 260],
          signature: new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]),
          signerKey: '03'.padEnd(66, 'b')
        }
      ]
    },
    transaction: tokenBeef().bytes
  }
}

function bsvFrame(): PaymentFrame {
  return {
    version: FRAME_VERSION,
    kind: 'bsv',
    senderIdentityKey: '02'.padEnd(66, 'a'),
    outputIndex: 0,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction: new Uint8Array([1, 2, 3, 4, 5])
  }
}

function expectSameBytes(actual: unknown, expected: Uint8Array): void {
  expect(actual).toBeInstanceOf(Uint8Array)
  expect(Array.from(actual as Uint8Array)).toEqual(Array.from(expected))
}

function expectTokenFrameIntact(back: PaymentFrame, original: PaymentFrame): void {
  expectSameBytes(back.transaction, original.transaction)
  expect(back.token).toBeDefined()
  const b = back.token!
  const o = original.token!
  expect(b.certificates).toHaveLength(o.certificates.length)
  o.certificates.forEach((c, i) => expectSameBytes(b.certificates[i], c))
  expect(b.linkage.map(l => l.txid)).toEqual(o.linkage.map(l => l.txid))
  o.linkage.forEach((l, i) => expectSameBytes(b.linkage[i].payload, l.payload))
  expect(b.admissions.map(a => a.txid)).toEqual(o.admissions.map(a => a.txid))
  o.admissions.forEach((a, i) => {
    expectSameBytes(b.admissions[i].signature, a.signature)
    expect(b.admissions[i].outputsToAdmit).toEqual(a.outputsToAdmit)
    expect(b.admissions[i].signerKey).toBe(a.signerKey)
  })
  // The codec is the one definition of "every byte field": if the queue lost
  // one, the re-encoded frame differs from the original.
  expect(Array.from(encodeFrame(back))).toEqual(Array.from(encodeFrame(original)))
}

describe('pending queue: token frame bytes survive the KV round-trip', () => {
  it('reads back every byte field as a Uint8Array with the same contents', async () => {
    const kv = memoryStorage()
    const original = tokenFrame()
    await savePending(kv, original, 'ble')
    const [back] = await getPending(kv)
    expectTokenFrameIntact(back.frame, original)
  })

  it('survives a status rewrite of the queue as well', async () => {
    const kv = memoryStorage()
    const original = tokenFrame()
    const entry = await savePending(kv, original)
    await updateStatus(kv, entry.id, 'failed', 'transient')
    const [back] = await getPending(kv)
    expect(back.status).toBe('failed')
    expectTokenFrameIntact(back.frame, original)
  })

  it('still round-trips a bsv frame', async () => {
    const kv = memoryStorage()
    const original = bsvFrame()
    await savePending(kv, original)
    const [back] = await getPending(kv)
    expectSameBytes(back.frame.transaction, original.transaction)
    expect(back.frame.token).toBeUndefined()
    expect(Array.from(encodeFrame(back.frame))).toEqual(Array.from(encodeFrame(original)))
  })

  it('hands processPending hooks a frame whose linkage payloads are bytes', async () => {
    const kv = memoryStorage()
    const original = tokenFrame()
    await savePending(kv, original)
    const seen: PaymentFrame[] = []
    const wallet = { internalizeAction: async () => ({ accepted: true }) }
    const results = await processPending(wallet, kv, 'test', undefined, undefined, async frame => {
      seen.push(frame)
    })
    expect(results).toEqual([expect.objectContaining({ success: true })])
    expect(seen).toHaveLength(1)
    expectTokenFrameIntact(seen[0], original)
  })
})

describe('pending queue: entries written before byte fields were converted', () => {
  /**
   * Exactly the shape the previous `toWire` produced: `transaction` as a
   * number[], every other Uint8Array left for JSON to mangle into an
   * index-keyed object. Real devices still hold queue entries like this.
   */
  function legacyEntry(frame: PaymentFrame): string {
    return JSON.stringify([
      {
        id: 'legacy_1',
        receivedAt: '2026-09-15T00:00:00.000Z',
        status: 'pending',
        frame: { ...frame, transaction: Array.from(frame.transaction) }
      }
    ])
  }

  it('revives an index-keyed object back into the bytes it was', async () => {
    const kv = memoryStorage()
    const original = tokenFrame()
    kv.raw.set(PENDING_KEY, legacyEntry(original))
    // Sanity: the fixture really is mangled, or this test proves nothing.
    expect(JSON.parse(kv.raw.get(PENDING_KEY)!)[0].frame.token.linkage[0].payload).toEqual({ '0': 1, '1': 2, '2': 3 })
    const [back] = await getPending(kv)
    expectTokenFrameIntact(back.frame, original)
  })

  it('rewrites a revived legacy entry in the converted shape', async () => {
    const kv = memoryStorage()
    const original = tokenFrame()
    kv.raw.set(PENDING_KEY, legacyEntry(original))
    await updateStatus(kv, 'legacy_1', 'processing')
    const stored = JSON.parse(kv.raw.get(PENDING_KEY)!)[0].frame.token
    expect(stored.linkage[0].payload).toEqual([1, 2, 3])
    expect(stored.certificates[0]).toEqual([9, 9, 9])
    expect(stored.admissions[0].signature).toEqual([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02])
    const [back] = await getPending(kv)
    expectTokenFrameIntact(back.frame, original)
  })
})
