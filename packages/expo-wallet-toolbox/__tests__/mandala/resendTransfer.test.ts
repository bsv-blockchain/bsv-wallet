/**
 * Resend for a TOKEN transfer: re-deliver the Mandala transfer notification over
 * the message box, whatever rail the payment first went out on.
 *
 * The body is reconstructed from what the payer already holds — the blinding
 * journal (recipient, blinded sender A′, keyID), the payee output's own
 * `customInstructions` marker, the transaction bytes, and any cached σ_I — and
 * is the SAME body `transferTokens` sends at transfer time, so the recipient's
 * inbox needs nothing new to credit it.
 */
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { MANDALA_MESSAGE_BOX, resendTokenTransfer, type TokenResendDeps } from '../../core/mandala/resendTransfer'

const ASSET_ID = 'ab'.repeat(32) + '.0'
const RECIPIENT = '02' + '11'.repeat(32)
const SENDER_BLINDED = '03' + '22'.repeat(32)
const KEY_ID = 'cHJlZml4 c3VmZml4'
const FT_PROTOCOL: [number, string] = [2, 'mandala token']

/** Fee change at 0, the payee's token output at 1 — so the index has to be read, not assumed. */
function tokenTx(amount = 2500): { tx: Transaction; txid: string; atomic: number[] } {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 500, lockingScript: LockingScript.fromHex('51') })
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET_ID, amount, new Array(20).fill(7)) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const txid = tx.id('hex')
  return { tx, txid, atomic: beef.toBinaryAtomic(txid) }
}

const marker = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    protocolID: FT_PROTOCOL,
    keyID: KEY_ID,
    counterparty: RECIPIENT,
    direction: 'sent',
    recipient: RECIPIENT,
    senderBlinded: SENDER_BLINDED,
    ...over
  })

function deps(over: Partial<TokenResendDeps> = {}): TokenResendDeps & {
  sent: { recipient: string; messageBox: string; body: Record<string, unknown> }[]
  journal: { put: jest.Mock; remove: jest.Mock }
} {
  const { atomic } = tokenTx()
  const sent: { recipient: string; messageBox: string; body: Record<string, unknown> }[] = []
  const journal = { put: jest.fn(async () => undefined), remove: jest.fn(async () => undefined) }
  return {
    sent,
    journal,
    blindingRecord: async () => ({ recipient: RECIPIENT, senderBlinded: SENDER_BLINDED, keyID: KEY_ID }),
    listAction: async () => ({
      labels: ['mandala', 'localpay', RECIPIENT],
      outputs: [
        { outputIndex: 0, customInstructions: JSON.stringify({ direction: 'change' }) },
        { outputIndex: 1, customInstructions: marker() }
      ]
    }),
    refetch: async () => atomic,
    admission: async () => undefined,
    sendMessage: async (args: { recipient: string; messageBox: string; body: object }) => {
      sent.push(args as never)
    },
    ...over
  }
}

const TXID = tokenTx().txid

describe('resendTokenTransfer', () => {
  it('re-sends the transfer notification the recipient’s inbox already understands', async () => {
    const d = deps()
    const { atomic } = tokenTx()

    await expect(resendTokenTransfer(TXID, d)).resolves.toEqual({ ok: true })

    expect(d.sent).toHaveLength(1)
    const { recipient, messageBox, body } = d.sent[0]
    expect(recipient).toBe(RECIPIENT)
    expect(messageBox).toBe(MANDALA_MESSAGE_BOX)
    expect(body).toMatchObject({
      assetId: ASSET_ID,
      // Decoded from the output's own script, as a string — the wire form.
      amount: '2500',
      keyID: KEY_ID,
      outputIndex: 1,
      protocolID: FT_PROTOCOL,
      sender: SENDER_BLINDED,
      senderMode: 'blinded'
    })
    expect(Array.from(body.transaction as number[])).toEqual(atomic)
    expect(body).not.toHaveProperty('admission')
  })

  it('journals the notification BEFORE sending and clears it after — the lib’s own retry discipline', async () => {
    const order: string[] = []
    const d = deps({
      sendMessage: async () => {
        order.push('send')
      }
    })
    d.journal.put.mockImplementation(async () => {
      order.push('put')
    })
    d.journal.remove.mockImplementation(async () => {
      order.push('remove')
    })

    await resendTokenTransfer(TXID, d)

    expect(order).toEqual(['put', 'send', 'remove'])
    expect(d.journal.put).toHaveBeenCalledWith(
      expect.objectContaining({ txid: TXID, recipient: RECIPIENT, messageBox: MANDALA_MESSAGE_BOX })
    )
  })

  it('falls back to the payee output’s own marker when the blinding journal has no record', async () => {
    const d = deps({ blindingRecord: async () => undefined })

    await expect(resendTokenTransfer(TXID, d)).resolves.toEqual({ ok: true })

    expect(d.sent[0].recipient).toBe(RECIPIENT)
    expect(d.sent[0].body).toMatchObject({ sender: SENDER_BLINDED, keyID: KEY_ID, outputIndex: 1 })
  })

  it('reads an encrypted marker through the metadata decryptor', async () => {
    const d = deps({
      blindingRecord: async () => undefined,
      listAction: async () => ({ outputs: [{ outputIndex: 1, customInstructions: 'ciphertext' }] }),
      decryptMetadata: async (v: string) => (v === 'ciphertext' ? marker() : v)
    })

    await expect(resendTokenTransfer(TXID, d)).resolves.toEqual({ ok: true })
    expect(d.sent[0].body).toMatchObject({ sender: SENDER_BLINDED, outputIndex: 1 })
  })

  it('is no_record when neither the journal nor the action names the recipient — and sends nothing', async () => {
    const d = deps({
      blindingRecord: async () => undefined,
      listAction: async () => ({ outputs: [{ outputIndex: 0, customInstructions: JSON.stringify({ direction: 'change' }) }] })
    })

    await expect(resendTokenTransfer(TXID, d)).resolves.toEqual({ ok: false, reason: 'no_record' })
    expect(d.sent).toHaveLength(0)
    expect(d.journal.put).not.toHaveBeenCalled()
  })

  it('is no_transaction when no bytes can be found — and journals nothing it cannot send', async () => {
    const d = deps({ refetch: async () => undefined })

    await expect(resendTokenTransfer(TXID, d)).resolves.toEqual({ ok: false, reason: 'no_transaction' })
    expect(d.sent).toHaveLength(0)
    expect(d.journal.put).not.toHaveBeenCalled()
  })

  it('is no_transaction when the named output is not a token output of this transaction', async () => {
    const d = deps({
      listAction: async () => ({ outputs: [{ outputIndex: 0, customInstructions: marker() }] })
    })
    await expect(resendTokenTransfer(TXID, d)).resolves.toEqual({ ok: false, reason: 'no_transaction' })
    expect(d.sent).toHaveLength(0)
  })

  it('treats a duplicate-message refusal as delivered', async () => {
    const d = deps({
      sendMessage: async () => {
        // The box's own refusal for an unchanged body: HMAC collision, 400.
        throw new Error('Message send failed: HTTP 400 — duplicate message')
      }
    })

    await expect(resendTokenTransfer(TXID, d)).resolves.toEqual({ ok: true })
    expect(d.journal.remove).toHaveBeenCalledWith(TXID)
  })

  it('rethrows any other send failure and keeps the journal entry for the drain to retry', async () => {
    const d = deps({
      sendMessage: async () => {
        throw new Error('box unreachable')
      }
    })

    await expect(resendTokenTransfer(TXID, d)).rejects.toThrow('box unreachable')
    expect(d.journal.put).toHaveBeenCalledTimes(1)
    expect(d.journal.remove).not.toHaveBeenCalled()
  })

  it('forwards a cached σ_I so the recipient can credit without its own overlay round-trip', async () => {
    const d = deps({
      admission: async () => ({ outputsToAdmit: [1], signatureHex: '3044aa', signerKey: '02' + 'cd'.repeat(32) })
    })

    await resendTokenTransfer(TXID, d)

    expect(d.sent[0].body.admission).toEqual({
      txid: TXID,
      outputsToAdmit: [1],
      signature: '3044aa',
      signerKey: '02' + 'cd'.repeat(32)
    })
  })
})
