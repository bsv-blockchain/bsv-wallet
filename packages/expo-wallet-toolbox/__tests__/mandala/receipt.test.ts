/**
 * The payee's half of a nearby token hand-over (plan 07 Task 16, design §9
 * B7): a v7 frame is the v4 MessageBox hand-over body (IC §7.3), and a failed
 * receipt is classified by the lib's own receive classifier (retry it, or
 * journal it refused for good).
 */
import { P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import {
  InvalidTransferError,
  OverlayRefusedError,
  handoverBody,
  parseHandoverBody,
  receiptOfBody,
  type HandoverResult
} from '@bsv/mandala'
import { FRAME_VERSION, decodeFrame, encodeFrame, type PaymentFrame } from '../../core/localpay/codec'
import {
  bodyFromFrame,
  isRetriableReceiptFailure,
  isTransportReceiptFailure,
  receiptFailureCode,
  tokenPaymentOfHandover
} from '../../core/mandala/receipt'

const ASSET = `${'ab'.repeat(32)}_0`
const SENDER = new PrivateKey(13).toPublicKey().toString()
const K = new PrivateKey(9).toPublicKey().toString()
const PREFIX = 'cHJlZml4cHJlZml4cHJlZg=='
const SUFFIX = 'c3VmZml4c3VmZml4c3VmZg=='

function tip(units: bigint): Transaction {
  const source = new Transaction()
  source.addOutput({ lockingScript: new P2PKH().lock(new Array(20).fill(1)), satoshis: 10 })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(new Array(20).fill(1))
  })
  tx.addOutput({ lockingScript: new OneColor().lock(ASSET, units, new Array(20).fill(9)), satoshis: 1 })
  return tx
}

function handover(units: bigint, note?: string): Pick<HandoverResult, 'body' | 'tx' | 'txid'> {
  const tx = tip(units)
  const beef = tx.toAtomicBEEF()
  const body = handoverBody({
    assetId: ASSET,
    amount: units,
    outputIndex: 0,
    tx: beef,
    derivationPrefix: PREFIX,
    derivationSuffix: SUFFIX,
    senderIdentityKey: SENDER,
    senderMode: 'blinded',
    admission: { txid: tx.id('hex'), outputs: [0], signer: K, signature: '3006020101020101' },
    admissions: [{ txid: 'cd'.repeat(32), outputs: [1], signer: K, signature: '3006020101020102' }],
    linkage: [{ txid: tx.id('hex'), offChainValues: [1, 2, 3] }],
    ...(note !== undefined ? { note } : {})
  })
  return { body, tx: beef, txid: tx.id('hex') }
}

function frameOf(h: Pick<HandoverResult, 'body' | 'tx'>, note?: string): PaymentFrame {
  return {
    version: FRAME_VERSION,
    kind: 'token',
    senderIdentityKey: h.body.senderIdentityKey,
    outputIndex: h.body.outputIndex,
    derivationPrefix: h.body.derivationPrefix,
    derivationSuffix: h.body.derivationSuffix,
    token: tokenPaymentOfHandover(h),
    ...(note !== undefined ? { note } : {}),
    transaction: Uint8Array.from(h.tx)
  }
}

describe('a v7 token frame is the v4 hand-over body (IC §7.3)', () => {
  it('rebuilds exactly the body the payer signed, through the codec', () => {
    const h = handover(18446744073709551615n, 'coffee')
    const frame = decodeFrame(encodeFrame(frameOf(h, 'coffee')))
    expect(bodyFromFrame(frame)).toEqual(h.body)
  })

  it('omits an empty note, as the body does', () => {
    const h = handover(5n)
    expect(bodyFromFrame(frameOf(h))).toEqual(h.body)
    expect(bodyFromFrame(frameOf(h))).not.toHaveProperty('note')
  })

  it('parses strictly with the lib, and yields the plain 5-member custody receipt', () => {
    const h = handover(250n)
    const parsed = parseHandoverBody(bodyFromFrame(frameOf(h)))
    expect(parsed.amount).toBe(250n)
    expect(parsed.receipt).toEqual(receiptOfBody(h.body))
    expect(Object.keys(parsed.receipt).sort()).toEqual(
      ['assetId', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey', 'version'].sort()
    )
    expect(Utils.toHex(parsed.tx)).toBe(h.body.transaction)
  })

  it('refuses a BSV frame', () => {
    const h = handover(1n)
    const { token: _t, ...rest } = frameOf(h)
    expect(() => bodyFromFrame({ ...rest, kind: 'bsv' })).toThrow(TypeError)
  })
})

describe('isRetriableReceiptFailure / receiptFailureCode (lib classifyReceiveError)', () => {
  it.each([
    ['a refused hop', new InvalidTransferError('x', 'ERR_EVIDENCE'), false, 'ERR_EVIDENCE'],
    ['a malformed body', new InvalidTransferError('x'), false, 'InvalidTransferError'],
    ['offline, not covered yet', new InvalidTransferError('x', 'ERR_NOT_COVERED'), true, 'ERR_NOT_COVERED'],
    ['an unreadable body', new InvalidTransferError('x', 'ERR_BODY_UNREADABLE'), true, 'ERR_BODY_UNREADABLE'],
    [
      'a final verdict',
      new OverlayRefusedError({ code: 'ERR_CONSERVATION', retryable: false }),
      false,
      'ERR_CONSERVATION'
    ],
    ['a retryable verdict', new OverlayRefusedError({ code: 'ERR_PAUSED', retryable: true }), true, 'ERR_PAUSED'],
    [
      'a transport fault',
      new OverlayRefusedError({ code: 'ERR_UNAVAILABLE', retryable: true }),
      true,
      'ERR_UNAVAILABLE'
    ],
    ['a storage fault', new Error('SQLITE_BUSY'), true, 'ERR_RECEIPT']
  ])('%s', (_l, e, retriable, code) => {
    expect(isRetriableReceiptFailure(e)).toBe(retriable)
    expect(receiptFailureCode(e)).toBe(code)
  })

  it('reads a class kept only in the message prefix (IC D22)', () => {
    const bridged = new Error('[ProfileDataError] BRC-207: Mandala issuer-v1 receipt: refused')
    expect(isRetriableReceiptFailure(bridged)).toBe(false)
    expect(receiptFailureCode(bridged)).toBe('ProfileDataError')
  })

  it.each(['UnsupportedProfileError', 'ProfileParamsError'])(
    'treats the module refusing the asset (%s) as final',
    name => {
      const e = Object.assign(new Error(`[${name}] no Mandala overlay configured`), { name })
      expect(isRetriableReceiptFailure(e)).toBe(false)
      expect(receiptFailureCode(e)).toBe(name)
      expect(isRetriableReceiptFailure(new Error(`[${name}] bridged`))).toBe(false)
    }
  )

  it('treats the user’s own decline as final', () => {
    const declined = Object.assign(new Error('BRC-207: the user declined the color_send request'), {
      name: 'ColorConsentDeclinedError'
    })
    expect(isRetriableReceiptFailure(declined)).toBe(false)
    expect(receiptFailureCode(declined)).toBe('ColorConsentDeclinedError')
  })

  it('isTransportReceiptFailure is true only for ERR_UNAVAILABLE', () => {
    expect(isTransportReceiptFailure(new OverlayRefusedError({ code: 'ERR_UNAVAILABLE', retryable: true }))).toBe(true)
    expect(isTransportReceiptFailure(new Error('mandala overlay refused (ERR_UNAVAILABLE, retryable): down'))).toBe(
      true
    )
    expect(isTransportReceiptFailure(new OverlayRefusedError({ code: 'ERR_PAUSED', retryable: true }))).toBe(false)
    expect(isTransportReceiptFailure(new Error('x'))).toBe(false)
  })
})
