import { Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { requireVaultOutputKeyPossession } from '../../core/services/vault/outputAuthority'
import { randomBytes } from '../../core/services/vault/random'
import { requestVaultSigner } from '../../core/services/vault/ceremonyHost'
import { vaultStore, type VaultMeta } from '../../core/services/vault/vaultStore'

jest.mock('../../core/services/vault/random', () => {
  const actual = jest.requireActual('../../core/services/vault/random')
  return { ...actual, randomBytes: jest.fn(actual.randomBytes) }
})
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo' }))
jest.mock('@react-native-async-storage/async-storage', () => ({}))
jest.mock('../../core/services/vault/ceremonyHost', () => ({ requestVaultSigner: jest.fn() }))

const privateKeys = [p256.utils.randomSecretKey(), p256.utils.randomSecretKey()]
const keys = privateKeys.map((key, i) => ({
  serial: `key-${i}`,
  slot: 0x82,
  pubkey: Utils.toHex(Array.from(p256.getPublicKey(key, true))),
  nickname: `Key ${i}`,
  enrolledAt: 1
}))
const meta: VaultMeta = { v: 6, vaultId: '11'.repeat(32), revision: 1, createdAt: 1, keys }
const output = { satoshis: 1000, saltKeyId: '1', lockingScript: '51' }
let released: jest.Mock[]
let signed: string[]

beforeEach(() => {
  vaultStore.configureScope({ identityKey: `02${'22'.repeat(32)}`, chain: 'main' })
  released = []
  signed = []
  ;(requestVaultSigner as jest.Mock).mockReset().mockImplementation(async (_reason, serial) => {
    const index = keys.findIndex(key => key.serial === serial)
    const release = jest.fn()
    released.push(release)
    return {
      serial,
      pubkey: keys[index].pubkey,
      release,
      sign: async (digest: string) => {
        signed.push(digest)
        const raw = p256.sign(Uint8Array.from(Utils.toArray(digest, 'hex')), privateKeys[index], {
          prehash: false,
          lowS: false
        })
        return Array.from(p256.Signature.fromBytes(raw).toBytes('der'))
      }
    }
  })
})
afterEach(() => vaultStore.clearScope())

test('proves one exact enrolled key against a fresh output-bound challenge and releases each signer', async () => {
  const scope = vaultStore.captureScopeToken()
  await requireVaultOutputKeyPossession(meta, scope, output)
  await requireVaultOutputKeyPossession(meta, scope, output)
  expect(requestVaultSigner).toHaveBeenCalledTimes(2)
  expect(signed).toHaveLength(2)
  expect(signed[0]).not.toBe(signed[1])
  expect(released.every(release => release.mock.calls.length === 1)).toBe(true)
})

test('rejects reset hardware returning a different public key before accepting its signature', async () => {
  const release = jest.fn()
  const sign = jest.fn()
  ;(requestVaultSigner as jest.Mock).mockResolvedValueOnce({
    serial: keys[0].serial,
    pubkey: keys[1].pubkey,
    release,
    sign
  })
  await expect(requireVaultOutputKeyPossession(meta, vaultStore.captureScopeToken(), output)).rejects.toMatchObject({
    code: 'wrong-key'
  })
  expect(sign).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledTimes(1)
})

test('rejects a previously valid signature replayed for another new output', async () => {
  const scope = vaultStore.captureScopeToken()
  ;(randomBytes as jest.Mock).mockReturnValueOnce(Array(32).fill(7)).mockReturnValueOnce(Array(32).fill(7))
  const original = (requestVaultSigner as jest.Mock).getMockImplementation()!
  let captured: number[] = []
  ;(requestVaultSigner as jest.Mock).mockImplementation(async (...args) => {
    const signer = await original(...args)
    const sign = signer.sign
    signer.sign = async (digest: string) => {
      captured = await sign(digest)
      return captured
    }
    return signer
  })
  await requireVaultOutputKeyPossession({ ...meta, keys: [keys[0]] }, scope, output)
  const release = jest.fn()
  ;(requestVaultSigner as jest.Mock).mockResolvedValue({
    serial: keys[0].serial,
    pubkey: keys[0].pubkey,
    release,
    sign: async () => captured
  })
  await expect(
    requireVaultOutputKeyPossession({ ...meta, keys: [keys[0]] }, scope, { ...output, satoshis: 2000 })
  ).rejects.toMatchObject({ code: 'wrong-key' })
  expect(release).toHaveBeenCalledTimes(1)
})

test('scope teardown during a hardware signature aborts and releases the obtained signer', async () => {
  const release = jest.fn()
  ;(requestVaultSigner as jest.Mock).mockResolvedValueOnce({
    serial: keys[0].serial,
    pubkey: keys[0].pubkey,
    release,
    sign: async () => {
      vaultStore.clearScope()
      return []
    }
  })
  await expect(requireVaultOutputKeyPossession(meta, vaultStore.captureScopeToken(), output)).rejects.toMatchObject({
    code: 'scope-changed'
  })
  expect(release).toHaveBeenCalledTimes(1)
})

test('accepts any chosen enrolled key under the one-of-N spend policy', async () => {
  await requireVaultOutputKeyPossession(meta, vaultStore.captureScopeToken(), output, keys[1].serial)
  expect(requestVaultSigner).toHaveBeenCalledWith('Verify vault key for new funds', keys[1].serial)
  expect(requestVaultSigner).toHaveBeenCalledTimes(1)
})

test.each(['identity', 'chain', 'vault', 'revision', 'key-order', 'amount', 'salt-index', 'script'] as const)(
  'a proof for another %s context cannot authorize the new output',
  async changed => {
    const nonce = Array(32).fill(9)
    ;(randomBytes as jest.Mock).mockReturnValueOnce(nonce).mockReturnValueOnce(nonce)
    const original = (requestVaultSigner as jest.Mock).getMockImplementation()!
    let captured: number[] = []
    ;(requestVaultSigner as jest.Mock).mockImplementationOnce(async (...args) => {
      const signer = await original(...args)
      const sign = signer.sign
      signer.sign = async (digest: string) => {
        captured = await sign(digest)
        return captured
      }
      return signer
    })
    await requireVaultOutputKeyPossession(meta, vaultStore.captureScopeToken(), output, keys[0].serial)
    let nextMeta = meta
    let nextOutput = output
    if (changed === 'identity') vaultStore.configureScope({ identityKey: `03${'33'.repeat(32)}`, chain: 'main' })
    if (changed === 'chain') vaultStore.configureScope({ identityKey: `02${'22'.repeat(32)}`, chain: 'test' })
    if (changed === 'vault') nextMeta = { ...meta, vaultId: '44'.repeat(32) }
    if (changed === 'revision') nextMeta = { ...meta, revision: 2 }
    if (changed === 'key-order') nextMeta = { ...meta, keys: [...keys].reverse() }
    if (changed === 'amount') nextOutput = { ...output, satoshis: 2000 }
    if (changed === 'salt-index') nextOutput = { ...output, saltKeyId: '2' }
    if (changed === 'script') nextOutput = { ...output, lockingScript: '52' }
    ;(requestVaultSigner as jest.Mock).mockResolvedValueOnce({
      serial: keys[0].serial,
      pubkey: keys[0].pubkey,
      release: jest.fn(),
      sign: async () => captured
    })
    await expect(
      requireVaultOutputKeyPossession(nextMeta, vaultStore.captureScopeToken(), nextOutput, keys[0].serial)
    ).rejects.toMatchObject({ code: 'wrong-key' })
  }
)

test('a cancelled hardware signature releases its signer and refuses the new output', async () => {
  const release = jest.fn()
  ;(requestVaultSigner as jest.Mock).mockResolvedValueOnce({
    serial: keys[0].serial,
    pubkey: keys[0].pubkey,
    release,
    sign: async () => {
      throw Object.assign(new Error('cancelled'), { code: 'user-cancelled' })
    }
  })
  await expect(requireVaultOutputKeyPossession(meta, vaultStore.captureScopeToken(), output)).rejects.toMatchObject({
    code: 'user-cancelled'
  })
  expect(release).toHaveBeenCalledTimes(1)
})

test.each(['', 'not-enrolled'])(
  'refuses an explicit unavailable key selection %p without a hardware request',
  async serial => {
    await expect(
      requireVaultOutputKeyPossession(meta, vaultStore.captureScopeToken(), output, serial)
    ).rejects.toMatchObject({ code: 'not-enrolled' })
    expect(requestVaultSigner).not.toHaveBeenCalled()
  }
)

test('uses the last-used enrolled key when no explicit selection is supplied', async () => {
  await requireVaultOutputKeyPossession(
    { ...meta, lastUsedSerial: keys[1].serial },
    vaultStore.captureScopeToken(),
    output
  )
  expect(requestVaultSigner).toHaveBeenCalledWith('Verify vault key for new funds', keys[1].serial)
})

test('refuses an empty enrollment without requesting hardware', async () => {
  await expect(
    requireVaultOutputKeyPossession({ ...meta, keys: [] }, vaultStore.captureScopeToken(), output)
  ).rejects.toMatchObject({ code: 'not-enrolled' })
  expect(requestVaultSigner).not.toHaveBeenCalled()
})

test('rejects a signer for a different serial even when its public key matches', async () => {
  const release = jest.fn()
  const sign = jest.fn()
  ;(requestVaultSigner as jest.Mock).mockResolvedValueOnce({
    serial: 'other-hardware',
    pubkey: keys[0].pubkey,
    release,
    sign
  })
  await expect(requireVaultOutputKeyPossession(meta, vaultStore.captureScopeToken(), output)).rejects.toMatchObject({
    code: 'wrong-key'
  })
  expect(sign).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledTimes(1)
})

test('rejects malformed signature bytes and releases the signer', async () => {
  const release = jest.fn()
  ;(requestVaultSigner as jest.Mock).mockResolvedValueOnce({
    serial: keys[0].serial,
    pubkey: keys[0].pubkey,
    release,
    sign: async () => [1, 2, 3]
  })
  await expect(requireVaultOutputKeyPossession(meta, vaultStore.captureScopeToken(), output)).rejects.toMatchObject({
    code: 'wrong-key'
  })
  expect(release).toHaveBeenCalledTimes(1)
})

test('propagates a cancelled hardware acquisition without signing', async () => {
  ;(requestVaultSigner as jest.Mock).mockRejectedValueOnce(new Error('hardware cancelled'))
  await expect(requireVaultOutputKeyPossession(meta, vaultStore.captureScopeToken(), output)).rejects.toThrow(
    'hardware cancelled'
  )
})
