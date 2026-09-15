/**
 * FIX I — a token payment is never abandoned by a retry ceiling built for a
 * different queue, and the payer's sealed frames can still be opened by the
 * drain that has to reconcile them.
 *
 * `MAX_PENDING_ATTEMPTS` governs `localpay_pending`'s BSV-shaped internalize
 * loop. It used to burn an attempt on ANY failure — including a transient
 * `Block header not found for height N` from a fresh-block BUMP this device
 * had not caught up on. That is a header lag, not a bad frame: the money is
 * real, and three of them in a row made a good payment permanently "stuck".
 *
 * The distinction is deliberately narrow. A structurally bad BEEF still counts
 * every time, because failure-matrix row 7 ("ask the sender to send it again")
 * is for exactly that case and for nothing else.
 */
import { PrivateKey } from '@bsv/sdk'
import {
  MAX_PENDING_ATTEMPTS,
  getPending,
  getRetryable,
  isPendingExhausted,
  processPending,
  savePending,
  updateStatus,
  type KVStorage
} from '../../core/localpay/pending'
import {
  MAX_REMEMBERED_SESSION_KEYS,
  forgetSessionPsks,
  rememberSessionPsk,
  sealedFramePayloadDecoder,
  tokenFrameSourcesFromOfflineActions
} from '../../core/offline/tokenFrames'
import { FRAME_VERSION, frameToQr, type PaymentFrame } from '../../core/localpay/codec'
import type { OfflineActionRow } from '../../core/storage/methods/offlineActions'

const SENDER = new PrivateKey(11).toPublicKey().toString()
const ASSET_ID = 'ab'.repeat(32) + '.0'

function memoryKv(): KVStorage {
  const map = new Map<string, string>()
  return {
    getKeyValue: async k => map.get(k),
    setKeyValue: async (k, v) => {
      map.set(k, v)
    }
  }
}

/**
 * Opaque transaction bytes. Nothing in this suite parses them: the internalize
 * is mocked, and the codec carries `transaction` as a length-prefixed blob.
 */
function atomicBytes(): Uint8Array {
  return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
}

function tokenFrame(): PaymentFrame {
  return {
    version: FRAME_VERSION,
    kind: 'token',
    senderIdentityKey: SENDER,
    outputIndex: 0,
    derivationPrefix: 'cHJl',
    derivationSuffix: 'c3Vm',
    token: {
      assetId: ASSET_ID,
      overlayUrl: 'https://overlay.issuer.example',
      overlayIdentityKey: '02' + 'cd'.repeat(32),
      certificates: [],
      linkage: [],
      admissions: []
    },
    transaction: atomicBytes()
  }
}

describe('FIX I: what may and may not burn an attempt', () => {
  it('a header-lag failure does NOT count, so the frame stays retryable forever', async () => {
    const storage = memoryKv()
    const entry = await savePending(storage, tokenFrame())

    for (let i = 0; i < MAX_PENDING_ATTEMPTS + 2; i++) {
      await updateStatus(storage, entry.id, 'failed', 'Block header not found for height 912345')
    }

    const [stored] = await getPending(storage)
    expect(stored.attempts ?? 0).toBe(0)
    expect(isPendingExhausted(stored)).toBe(false)
    expect(await getRetryable(storage)).toHaveLength(1)
  })

  it('a structurally bad frame still counts, and still gives up', async () => {
    const storage = memoryKv()
    const entry = await savePending(storage, tokenFrame())

    for (let i = 0; i < MAX_PENDING_ATTEMPTS; i++) {
      await updateStatus(storage, entry.id, 'failed', 'The tx parameter must be valid AtomicBEEF')
    }

    const [stored] = await getPending(storage)
    expect(stored.attempts).toBe(MAX_PENDING_ATTEMPTS)
    expect(isPendingExhausted(stored)).toBe(true)
    expect(await getRetryable(storage)).toHaveLength(0)
  })

  it('every transient shape the classifier knows is spared', async () => {
    const storage = memoryKv()
    const entry = await savePending(storage, tokenFrame())
    for (const reason of [
      'Block header not found for height 1',
      'no header at height 2',
      'chaintracker unavailable',
      'Network request failed',
      'request timed out',
      'ECONNRESET'
    ]) {
      await updateStatus(storage, entry.id, 'failed', reason)
    }
    expect((await getPending(storage))[0].attempts ?? 0).toBe(0)
  })

  it('holds through the real internalize loop: a header lag never exhausts the entry', async () => {
    const storage = memoryKv()
    await savePending(storage, tokenFrame())
    const wallet = {
      internalizeAction: jest.fn(async () => {
        throw new Error('Block header not found for height 912345')
      })
    }

    for (let i = 0; i < MAX_PENDING_ATTEMPTS + 1; i++) {
      await processPending(wallet, storage, 'urn:test:admin')
    }

    expect(wallet.internalizeAction).toHaveBeenCalledTimes(MAX_PENDING_ATTEMPTS + 1)
    expect((await getPending(storage))[0].attempts ?? 0).toBe(0)
  })

  it('a success still clears the entry, whatever the attempt accounting said', async () => {
    const storage = memoryKv()
    await savePending(storage, tokenFrame())
    const wallet = { internalizeAction: jest.fn(async () => ({ accepted: true })) }
    const results = await processPending(wallet, storage, 'urn:test:admin')
    expect(results).toEqual([expect.objectContaining({ success: true })])
    expect(await getPending(storage)).toHaveLength(0)
  })
})

describe('the payer’s sealed-frame decoder', () => {
  afterEach(() => forgetSessionPsks())

  const psk = new Uint8Array(32).fill(7)
  const other = new Uint8Array(32).fill(9)

  function payerRow(framePayload: string | null, over: Partial<OfflineActionRow> = {}): OfflineActionRow {
    return {
      offlineActionId: 1,
      created_at: '2026-09-15T00:00:00.000Z',
      updated_at: '2026-09-15T00:00:00.000Z',
      userId: 1,
      txid: 'aa'.repeat(32),
      seq: 0,
      role: 'sent',
      senderIdentityKey: null,
      receivedVia: null,
      status: 'queued',
      rejectedReason: null,
      poisonedByTxid: null,
      framePayload,
      ...over
    } as OfflineActionRow
  }

  it('opens a row sealed with a session this process took part in', () => {
    rememberSessionPsk(psk)
    const payload = frameToQr(tokenFrame(), psk)
    const sources = tokenFrameSourcesFromOfflineActions([payerRow(payload)], sealedFramePayloadDecoder())
    expect(sources).toHaveLength(1)
    expect(sources[0].role).toBe('sent')
    expect(sources[0].frame.token?.assetId).toBe(ASSET_ID)
  })

  it('skips a row whose session key this process never had — and does not throw', () => {
    rememberSessionPsk(other)
    const payload = frameToQr(tokenFrame(), psk)
    expect(tokenFrameSourcesFromOfflineActions([payerRow(payload)], sealedFramePayloadDecoder())).toEqual([])
  })

  it('skips a truncated or foreign framePayload rather than abandoning the pass', () => {
    rememberSessionPsk(psk)
    const good = frameToQr(tokenFrame(), psk)
    const decode = sealedFramePayloadDecoder()
    const sources = tokenFrameSourcesFromOfflineActions(
      [payerRow('not-an-envelope'), payerRow(good.slice(0, 20)), payerRow(good, { txid: 'bb'.repeat(32) })],
      decode
    )
    expect(sources.map(s => s.txid)).toEqual(['bb'.repeat(32)])
  })

  it('keeps a parked row parked — the drain may not promote what the user withheld', () => {
    rememberSessionPsk(psk)
    const payload = frameToQr(tokenFrame(), psk)
    const [source] = tokenFrameSourcesFromOfflineActions(
      [payerRow(payload, { status: 'parked' })],
      sealedFramePayloadDecoder()
    )
    expect(source.state).toBe('parked')
  })

  it('remembers keys idempotently and drops the oldest past the bound', () => {
    rememberSessionPsk(psk)
    rememberSessionPsk(psk)
    const payload = frameToQr(tokenFrame(), psk)
    const decode = sealedFramePayloadDecoder()
    expect(decode(payload)).toBeDefined()

    for (let i = 0; i < MAX_REMEMBERED_SESSION_KEYS; i++) rememberSessionPsk(new Uint8Array(32).fill(i + 20))
    expect(decode(payload)).toBeUndefined()
  })

  it('ignores anything that is not a 32-byte key', () => {
    rememberSessionPsk(new Uint8Array(8))
    rememberSessionPsk(undefined as unknown as Uint8Array)
    expect(sealedFramePayloadDecoder()(frameToQr(tokenFrame(), psk))).toBeUndefined()
  })
})
