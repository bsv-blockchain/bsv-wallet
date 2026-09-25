/**
 * The settlement ack, and FIX H.
 *
 * Everything here arrives from the OTHER device. The asymmetry these tests pin
 * is the fix: an ack that does not verify is treated as absent — the drain runs
 * its own submit, which costs one idempotent request — and never as a decline,
 * which would let any counterparty unwind a payment it had already taken.
 */
import {
  SETTLEMENT_ACK_PREFIX,
  decodeSettlementAck,
  encodeSettlementAck,
  readSettlementAck,
  tokenSendState,
  type SettlementAck,
  type VerifyAdmissionFn
} from '../../core/localpay/settlementAck'
import { isDeclineReason } from '../../core/localpay/types'

const TXID = 'ab'.repeat(32)
const OVERLAY_KEY = '03'.padEnd(66, 'b')
const SIG = '3006020101020102'

const payload = (patch: Partial<SettlementAck> = {}): SettlementAck => ({
  txid: TXID,
  outputsToAdmit: [0, 2],
  admissionSignature: SIG,
  ...patch
})

const yes: VerifyAdmissionFn = () => true
const no: VerifyAdmissionFn = () => false

describe('settlement ack codec', () => {
  it('round-trips the §4.8 payload', () => {
    expect(decodeSettlementAck(encodeSettlementAck(payload()))).toEqual(payload())
  })

  // It shares one string slot with the decline codes, so the two shapes must be
  // distinguishable without context.
  it('cannot be confused with a decline reason, in either direction', () => {
    expect(isDeclineReason(encodeSettlementAck(payload()))).toBe(false)
    expect(decodeSettlementAck('session_mismatch')).toBeUndefined()
    expect(decodeSettlementAck('not_covered')).toBeUndefined()
    expect(encodeSettlementAck(payload()).startsWith(SETTLEMENT_ACK_PREFIX)).toBe(true)
  })

  it('returns undefined rather than throwing for anything malformed', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'msa1:',
      'msa1:{',
      'msa1:[]',
      'msa1:{"txid":"short","outputsToAdmit":[0],"admissionSignature":"30"}',
      `msa1:{"txid":"${TXID}","outputsToAdmit":"nope","admissionSignature":"30"}`,
      `msa1:{"txid":"${TXID}","outputsToAdmit":[-1],"admissionSignature":"30"}`,
      `msa1:{"txid":"${TXID}","outputsToAdmit":[1.5],"admissionSignature":"30"}`,
      `msa1:{"txid":"${TXID}","outputsToAdmit":[0],"admissionSignature":""}`,
      `msa1:{"txid":"${TXID}","outputsToAdmit":[0],"admissionSignature":"zz"}`,
      `msa1:{"txid":"${TXID}","outputsToAdmit":[0]}`
    ]) {
      expect(decodeSettlementAck(bad)).toBeUndefined()
    }
  })

  it('normalises case so one txid has one spelling', () => {
    const upper = encodeSettlementAck(payload({ txid: TXID.toUpperCase(), admissionSignature: SIG.toUpperCase() }))
    expect(decodeSettlementAck(upper)).toEqual(payload())
  })
})

describe('readSettlementAck: FIX H', () => {
  const args = { overlayIdentityKey: OVERLAY_KEY, expectTxid: TXID, expectVout: 0, verify: yes }

  it('returns the admission when the ack carries one that verifies', async () => {
    const ack = { ok: true, error: encodeSettlementAck(payload()) }
    await expect(readSettlementAck(ack, args)).resolves.toEqual({
      txid: TXID,
      outputsToAdmit: [0, 2],
      signature: expect.any(Uint8Array),
      signerKey: OVERLAY_KEY
    })
  })

  // XR-093: a genuinely-signed admission for the SAME txid that covers only a
  // sibling output (e.g. the payer's own token change at index 1) must not be
  // mistaken for admission of the payee's own output (index 0, per
  // build.ts's hardcoded `outputIndex: 0`). Without a vout check, this signed,
  // verifying payload is indistinguishable from a real admission of the
  // payee's output, and the payer's screen would wrongly claim 'sent-settled'.
  it('refuses a verifying admission that never names the payee’s own output', async () => {
    const ack = { ok: true, error: encodeSettlementAck(payload({ outputsToAdmit: [1] })) }
    await expect(readSettlementAck(ack, { ...args, expectVout: 0 })).resolves.toBeUndefined()
  })

  it('accepts a verifying admission that names the payee’s output among others', async () => {
    const ack = { ok: true, error: encodeSettlementAck(payload({ outputsToAdmit: [1, 0] })) }
    await expect(readSettlementAck(ack, { ...args, expectVout: 0 })).resolves.toBeDefined()
  })

  it('treats a signature that does not verify as ABSENT, not as a decline', async () => {
    const ack = { ok: true, error: encodeSettlementAck(payload()) }
    await expect(readSettlementAck(ack, { ...args, verify: no })).resolves.toBeUndefined()
  })

  it('treats a throwing verifier as absent', async () => {
    const ack = { ok: true, error: encodeSettlementAck(payload()) }
    const verify: VerifyAdmissionFn = () => {
      throw new Error('bad curve point')
    }
    await expect(readSettlementAck(ack, { ...args, verify })).resolves.toBeUndefined()
  })

  // A perfectly valid admission for a DIFFERENT transaction is a replay: it
  // verifies, and it proves nothing about the payment just handed over.
  it('refuses an admission for another txid', async () => {
    const ack = { ok: true, error: encodeSettlementAck(payload({ txid: 'cd'.repeat(32) })) }
    await expect(readSettlementAck(ack, args)).resolves.toBeUndefined()
  })

  it('reads nothing off a negative ack, whatever it carries', async () => {
    const ack = { ok: false, error: encodeSettlementAck(payload()) }
    await expect(readSettlementAck(ack, args)).resolves.toBeUndefined()
  })

  it('reads nothing off an ordinary positive ack', async () => {
    await expect(readSettlementAck({ ok: true }, args)).resolves.toBeUndefined()
    await expect(readSettlementAck({ ok: true, error: '' }, args)).resolves.toBeUndefined()
  })

  it('verifies against the SESSION’s overlay key, not one the payload names', async () => {
    const seen: string[] = []
    const verify: VerifyAdmissionFn = (_entry, key) => {
      seen.push(key)
      return true
    }
    const ack = { ok: true, error: encodeSettlementAck(payload()) }
    const entry = await readSettlementAck(ack, { ...args, verify })
    expect(seen).toEqual([OVERLAY_KEY])
    expect(entry?.signerKey).toBe(OVERLAY_KEY)
  })

  it('binds nothing when no txid is expected, but still verifies and still binds vout', async () => {
    const ack = { ok: true, error: encodeSettlementAck(payload()) }
    await expect(
      readSettlementAck(ack, { overlayIdentityKey: OVERLAY_KEY, expectVout: 0, verify: yes })
    ).resolves.toBeDefined()
    await expect(
      readSettlementAck(ack, { overlayIdentityKey: OVERLAY_KEY, expectVout: 0, verify: no })
    ).resolves.toBeUndefined()
  })
})

describe('tokenSendState', () => {
  // Guard #1 means finalizeDelivery always returns broadcast:'pending' for a
  // token, so the only thing that can turn the screen green is a VERIFIED σ_I.
  it('is settling until a verified admission arrives', () => {
    expect(tokenSendState()).toBe('sent-settling')
    expect(tokenSendState(undefined)).toBe('sent-settling')
  })

  it('is settled once one has', () => {
    expect(
      tokenSendState({ txid: TXID, outputsToAdmit: [0], signature: new Uint8Array([0x30]), signerKey: OVERLAY_KEY })
    ).toBe('sent-settled')
  })
})
