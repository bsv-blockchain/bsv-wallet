/**
 * The pending queue is JSON in a KV row, and `JSON.stringify` turns a
 * `Uint8Array` into an index-keyed object (`{"0":1,"1":2}`) — which is what a
 * token frame's byte fields became on every read-back until they were
 * converted (2026-09-16). Every byte field must survive the queue, and the v6
 * token block's `profileData` carrier (the BRC-207 receipt profile data the
 * payee builds its §7.1 receipt from) must come back as the exact string.
 */
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { encodeFrame, FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import {
  getPending,
  PENDING_KEY,
  processPending,
  savePending,
  updateStatus,
  type KVStorage
} from '../../core/localpay/pending'

const ASSET = 'ab'.repeat(32) + '_0'
const ATTESTED = 'https://brc.dev/207/attested'
const PROFILE_DATA = JSON.stringify({
  [ATTESTED]: {
    [ASSET]: {
      declarationTx: '0100',
      transactions: [],
      attestations: [{ txid: 'cd'.repeat(32), outputs: [0], signer: '03'.padEnd(66, 'b'), signature: '3006' }],
      submissions: [{ txid: 'cd'.repeat(32), offChainValues: 'beef' }],
      amount: '18446744073709551615'
    }
  }
})

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
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
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
      certificates: [new Uint8Array([9, 9, 9]), new Uint8Array([])],
      profileData: PROFILE_DATA
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
  expect(b.assetId).toBe(o.assetId)
  expect(b.certificates).toHaveLength(o.certificates.length)
  o.certificates.forEach((c, i) => expectSameBytes(b.certificates[i], c))
  expect(typeof b.profileData).toBe('string')
  expect(b.profileData).toBe(o.profileData)
  expect(Object.keys(b).sort()).toEqual(['assetId', 'certificates', 'profileData'])
  // The codec is the one definition of "every byte field": if the queue lost
  // one, the re-encoded frame differs from the original.
  expect(Array.from(encodeFrame(back))).toEqual(Array.from(encodeFrame(original)))
}

describe('pending queue: token frame bytes survive the KV round-trip', () => {
  it('keeps a v6 token frame profileData intact through savePending and reload', async () => {
    const kv = memoryStorage()
    const original = tokenFrame()
    expect(original.version).toBe(6)
    await savePending(kv, original, 'ble')
    // Stored as the JSON string itself, never re-parsed into an object.
    expect(JSON.parse(kv.raw.get(PENDING_KEY)!)[0].frame.token.profileData).toBe(PROFILE_DATA)
    const [back] = await getPending(kv)
    expect(back.frame.token!.profileData).toBe(PROFILE_DATA)
    expect(JSON.parse(back.frame.token!.profileData)[ATTESTED][ASSET].amount).toBe('18446744073709551615')
  })

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

  it('hands processPending hooks a frame whose certificates are bytes and profileData intact', async () => {
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
    expect(JSON.parse(kv.raw.get(PENDING_KEY)!)[0].frame.token.certificates[0]).toEqual({ '0': 9, '1': 9, '2': 9 })
    const [back] = await getPending(kv)
    expectTokenFrameIntact(back.frame, original)
  })

  it('rewrites a revived legacy entry in the converted shape', async () => {
    const kv = memoryStorage()
    const original = tokenFrame()
    kv.raw.set(PENDING_KEY, legacyEntry(original))
    await updateStatus(kv, 'legacy_1', 'processing')
    const stored = JSON.parse(kv.raw.get(PENDING_KEY)!)[0].frame.token
    expect(stored.certificates[0]).toEqual([9, 9, 9])
    expect(stored.profileData).toBe(PROFILE_DATA)
    const [back] = await getPending(kv)
    expectTokenFrameIntact(back.frame, original)
  })
})

describe('pending queue: a stale pre-v6 token entry', () => {
  // No back-compat for frames below v6: such an entry is refused where it is
  // internalized. What must NOT happen is the read itself throwing, because a
  // throw in `readAll` quarantines the whole queue — every other payment in it.
  it('loads without quarantining the queue and keeps its version for the refusal', async () => {
    const kv = memoryStorage()
    const v5Token = {
      assetId: ASSET,
      overlayUrl: 'https://overlay.issuer.example',
      overlayIdentityKey: '03'.padEnd(66, 'b'),
      certificates: [[9]],
      linkage: [{ txid: 'cd'.repeat(32), payload: { '0': 1 } }],
      admissions: [{ txid: '11'.repeat(32), outputsToAdmit: [0], signature: [0x30], signerKey: '03'.padEnd(66, 'b') }]
    }
    kv.raw.set(
      PENDING_KEY,
      JSON.stringify([
        {
          id: 'v5_1',
          receivedAt: '2026-10-01T00:00:00.000Z',
          status: 'pending',
          frame: { ...bsvFrame(), version: 5, kind: 'token', transaction: [1, 2, 3], token: v5Token }
        },
        { id: 'bsv_1', receivedAt: '2026-10-01T00:00:01.000Z', status: 'pending', frame: { ...bsvFrame(), transaction: [1] } }
      ])
    )
    const all = await getPending(kv)
    expect(all.map(p => p.id)).toEqual(['v5_1', 'bsv_1'])
    expect(all[0].frame.version).toBe(5)
    expect(() => encodeFrame(all[0].frame)).toThrow()
  })
})
