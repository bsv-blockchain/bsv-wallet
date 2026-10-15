import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  sign,
  verify,
  decodePos,
  decodePaymentRequest,
  encodePos,
  randomId,
  type Rpc
} from '../../../packages/expo-wallet-toolbox/core/pos/protocol'
import { mintSession, encodeSession } from '../../../packages/expo-wallet-toolbox/core/localpay/session'
import { PosService, emptyState, type Store } from '../service/controller'
const owner = new ProtoWallet(PrivateKey.fromHex('01'))
const cashier = new ProtoWallet(PrivateKey.fromHex('02'))
const merchant = PrivateKey.fromHex('01').toPublicKey().toString()
const cashierKey = PrivateKey.fromHex('02').toPublicKey().toString()
function store(): Store {
  let state = emptyState()
  return {
    load: async () => JSON.parse(JSON.stringify(state)),
    save: async next => {
      state = JSON.parse(JSON.stringify(next))
    }
  }
}
async function rpc(service: PosService, wallet: ProtoWallet, method: string, body: Record<string, unknown> = {}) {
  return service.call(await sign(wallet, { version: 1, method, nonce: randomId(), time: Date.now(), body } as Rpc))
}
const session = () =>
  mintSession({
    identityKey: merchant,
    amount: 123,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    supportsAwdl: false
  })
test('customer verifies a merchant invoice offline while retaining the pairing key and merchant destination', async () => {
  const original = session()
  const envelope = await sign(owner, {
    kind: 'payment' as const,
    merchant,
    name: 'Corner Café',
    cashier: cashierKey,
    invoice: randomId(),
    chain: 'test',
    expires: Date.now() + 60000,
    session: encodeSession(original)
  })
  const decoded = await decodePaymentRequest(encodePos(envelope))
  expect(decoded.identityKey).toBe(merchant)
  expect(decoded.merchantName).toBe('Corner Café')
  expect(decoded.psk).toEqual(original.psk)
  const tampered = { ...envelope, payload: { ...envelope.payload, name: 'Other cafe' } }
  await expect(decodePos(encodePos(tampered))).rejects.toThrow()
  await expect(verify(envelope, cashierKey)).rejects.toThrow()
})
test('expired merchant requests and enrollment codes cannot become customer payments', async () => {
  const envelope = await sign(owner, {
    kind: 'payment' as const,
    merchant,
    name: 'Cafe',
    cashier: cashierKey,
    invoice: randomId(),
    chain: 'test',
    expires: Date.now() - 1,
    session: encodeSession(session())
  })
  await expect(decodePaymentRequest(encodePos(envelope))).rejects.toThrow()
  const invite = await sign(owner, {
    kind: 'invite' as const,
    merchant,
    name: 'Cafe',
    service: 'https://merchant.example',
    chain: 'test',
    id: randomId(),
    expires: Date.now() + 60000
  })
  await expect(decodePaymentRequest(encodePos(invite))).rejects.toThrow()
})
test('approval, revocation, exact payment binding, persistence and retry protect settlement', async () => {
  let unavailable = true
  const accept = jest.fn(async () => {
    if (unavailable) throw new Error('lost response')
    return 'a'.repeat(64)
  })
  const service = new PosService({
    wallet: owner,
    merchant,
    name: 'Cafe',
    url: 'https://merchant.example',
    chain: 'test',
    store: store(),
    accept
  })
  await expect(rpc(service, cashier, 'invite')).rejects.toThrow()
  const invitation = (await rpc(service, owner, 'invite')) as any
  await rpc(service, cashier, 'enroll', { invite: invitation.payload.id, name: 'Sam' })
  await expect(rpc(service, cashier, 'invoice', { session: encodeSession(session()) })).rejects.toThrow()
  await rpc(service, owner, 'approve', { cashier: cashierKey })
  const invoice = (await rpc(service, cashier, 'invoice', { session: encodeSession(session()) })) as any
  const frame = {
    version: 5,
    kind: 'bsv',
    senderIdentityKey: cashierKey,
    outputIndex: 0,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction: [1, 2, 3]
  }
  const args = { invoice: invoice.payload.invoice, frame }
  await expect(
    rpc(service, cashier, 'settle', { ...args, frame: { ...frame, derivationSuffix: 'wrong' } })
  ).rejects.toThrow()
  expect(accept).not.toHaveBeenCalled()
  await expect(rpc(service, cashier, 'settle', args)).rejects.toThrow()
  expect(await rpc(service, cashier, 'status', { invoice: args.invoice })).toEqual({ receipt: null, pending: true })
  unavailable = false
  const receipt = (await rpc(service, cashier, 'settle', args)) as any
  expect(((await verify(receipt, merchant)) as any).status).toBe('accepted')
  await rpc(service, cashier, 'settle', args)
  expect(accept).toHaveBeenCalledTimes(2)
  await expect(rpc(service, cashier, 'settle', { ...args, frame: { ...frame, transaction: [4] } })).rejects.toThrow()
  await rpc(service, owner, 'revoke', { cashier: cashierKey })
  await expect(rpc(service, cashier, 'invoice', { session: encodeSession(session()) })).rejects.toThrow()
})
