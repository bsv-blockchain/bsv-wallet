import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { resendPaymentDetails } from '../../core/peerpay/handleResendRequests'

const RECIPIENT = '02' + 'a'.repeat(64)

const INSTRUCTIONS = JSON.stringify({
  derivationPrefix: 'ZGV2LXByZWZpeA==',
  derivationSuffix: 'ZGV2LXN1ZmZpeA==',
  type: 'BRC29'
})

function signedTx() {
  const key = PrivateKey.fromRandom()
  const source = new Transaction()
  source.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(key.toPublicKey().toHash()) })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(key.toPublicKey().toHash())
  })
  tx.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(key.toPublicKey().toHash()) })
  return { beef: tx.toBEEF(), txid: tx.id('hex') }
}

function storageWithOutputs(rows: unknown[]) {
  return {
    getKeyValue: jest.fn().mockResolvedValue(undefined),
    setKeyValue: jest.fn().mockResolvedValue(undefined),
    findTransactions: jest.fn().mockResolvedValue([{ transactionId: 7 }]),
    findOutputs: jest.fn().mockResolvedValue(rows)
  }
}

// The listActions answer a parked nearby payment can come back with: the action
// is found by label, but its outputs arrive without derivation data.
it('recovers derivation data from storage when listActions omits it', async () => {
  const { beef, txid } = signedTx()
  const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
  const storage = storageWithOutputs([
    { vout: 0, satoshis: 1000, customInstructions: INSTRUCTIONS, basketId: null },
    { vout: 1, satoshis: 3900, customInstructions: INSTRUCTIONS, basketId: 4 }
  ])

  const outcome = await resendPaymentDetails({
    client,
    storage,
    txid,
    listPeerPayAction: async () => ({ txid, labels: ['localpay', RECIPIENT], outputs: [] }),
    refetch: async () => beef
  })

  expect(outcome).toEqual({ ok: true })
  const body = JSON.parse(client.sendMessage.mock.calls[0][0].body)
  // The payee's output, not this wallet's change: change carries derivation
  // data of its own and sits in a basket.
  expect(body.amount).toBe(1000)
  expect(body.outputIndex).toBe(0)
})

it('still reports no_transaction when storage has no derivation data either', async () => {
  const { beef, txid } = signedTx()
  const client = { sendMessage: jest.fn() }
  const storage = storageWithOutputs([{ vout: 0, satoshis: 1000, customInstructions: null, basketId: null }])

  const outcome = await resendPaymentDetails({
    client,
    storage,
    txid,
    listPeerPayAction: async () => ({ txid, labels: ['localpay', RECIPIENT], outputs: [] }),
    refetch: async () => beef
  })

  expect(outcome).toEqual({ ok: false, reason: 'no_transaction' })
  expect(client.sendMessage).not.toHaveBeenCalled()
})

it('leaves a good listActions answer alone', async () => {
  const { beef, txid } = signedTx()
  const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
  const storage = storageWithOutputs([])

  const outcome = await resendPaymentDetails({
    client,
    storage,
    txid,
    listPeerPayAction: async () => ({
      txid,
      labels: ['localpay', RECIPIENT],
      outputs: [{ customInstructions: INSTRUCTIONS, satoshis: 1000, outputIndex: 0 }]
    }),
    refetch: async () => beef
  })

  expect(outcome).toEqual({ ok: true })
  expect(storage.findOutputs).not.toHaveBeenCalled()
})

// The permissions manager encrypts wallet metadata on the way into storage, so
// a direct read of the column returns base64 ciphertext, not JSON.
it('decrypts customInstructions the permissions manager encrypted', async () => {
  const { beef, txid } = signedTx()
  const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
  const sealed = Buffer.from(INSTRUCTIONS, 'utf8').toString('base64')
  const storage = storageWithOutputs([{ vout: 0, satoshis: 1000, customInstructions: sealed, basketId: null }])

  const outcome = await resendPaymentDetails({
    client,
    storage,
    txid,
    listPeerPayAction: async () => ({ txid, labels: ['localpay', RECIPIENT], outputs: [] }),
    refetch: async () => beef,
    decryptMetadata: async value => Buffer.from(value, 'base64').toString('utf8')
  })

  expect(outcome).toEqual({ ok: true })
  const body = JSON.parse(client.sendMessage.mock.calls[0][0].body)
  expect(body.customInstructions).toEqual({
    derivationPrefix: 'ZGV2LXByZWZpeA==',
    derivationSuffix: 'ZGV2LXN1ZmZpeA=='
  })
})

it('keeps plaintext instructions untouched when a decryptor is supplied', async () => {
  const { beef, txid } = signedTx()
  const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
  const decryptMetadata = jest.fn()
  const storage = storageWithOutputs([{ vout: 0, satoshis: 1000, customInstructions: INSTRUCTIONS, basketId: null }])

  const outcome = await resendPaymentDetails({
    client,
    storage,
    txid,
    listPeerPayAction: async () => ({ txid, labels: ['localpay', RECIPIENT], outputs: [] }),
    refetch: async () => beef,
    decryptMetadata
  })

  expect(outcome).toEqual({ ok: true })
  expect(decryptMetadata).not.toHaveBeenCalled()
})
