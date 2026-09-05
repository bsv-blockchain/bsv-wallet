/** Byte-exact contract for the explicit native crypto backend installed on Hermes. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const nodeCrypto: typeof import('node:crypto') = jest.requireActual('node:crypto')
const globals = globalThis as typeof globalThis & { __bsvNativeCrypto?: unknown }
const IV = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255)
const KEY = Array.from({ length: 32 }, (_, i) => i + 1)

type Sdk = Pick<typeof import('@bsv/sdk'), 'SymmetricKey' | 'Hash'>

/** Force the actual SDK's pure-JS or explicit-native branch at module evaluation. */
function loadSdk(backend?: unknown, nodeDetector?: () => unknown): Sdk {
  const previousBackend = globals.__bsvNativeCrypto
  const processDescriptor = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule')
  globals.__bsvNativeCrypto = backend
  Object.defineProperty(process, 'getBuiltinModule', { configurable: true, value: nodeDetector })
  let loaded!: Sdk
  try {
    jest.isolateModules(() => {
      loaded = {
        SymmetricKey: require('@bsv/sdk/primitives/SymmetricKey').default,
        Hash: require('@bsv/sdk/primitives/Hash')
      }
    })
  } finally {
    globals.__bsvNativeCrypto = previousBackend
    if (processDescriptor) Object.defineProperty(process, 'getBuiltinModule', processDescriptor)
    else delete (process as any).getBuiltinModule
  }
  return loaded
}

function nativeBackend() {
  return {
    createCipheriv: jest.fn(nodeCrypto.createCipheriv),
    createDecipheriv: jest.fn(nodeCrypto.createDecipheriv),
    createHash: jest.fn(nodeCrypto.createHash),
    createHmac: jest.fn(nodeCrypto.createHmac),
    pbkdf2Sync: jest.fn(nodeCrypto.pbkdf2Sync)
  }
}

let originalCrypto: PropertyDescriptor | undefined
beforeEach(() => {
  originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set(IV.subarray(0, bytes.length))
        return bytes
      }
    }
  })
})
afterEach(() => {
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto)
  else delete (globalThis as any).crypto
})

describe('native AES-GCM SDK routing', () => {
  it.each([0, 1, 15, 16, 17, 255, 4096, 32768])(
    'matches pure SDK ciphertext and plaintext for %i bytes with its 32-byte IV',
    size => {
      const native = nativeBackend()
      const routed = loadSdk(native)
      const pure = loadSdk()
      const bytes = Array.from({ length: size }, (_, i) => (i * 37 + 19) & 255)
      const nativeKey = new routed.SymmetricKey(KEY)
      const pureKey = new pure.SymmetricKey(KEY)
      const expected = pureKey.encrypt(bytes) as number[]
      const actual = nativeKey.encrypt(bytes) as number[]
      expect(actual).toEqual(expected)
      expect(actual.slice(0, 32)).toEqual(Array.from(IV))
      if (size === 0) {
        expect(() => nativeKey.decrypt(expected)).toThrow('Cipher text must not be empty')
        expect(() => pureKey.decrypt(actual)).toThrow('Cipher text must not be empty')
      } else {
        expect(nativeKey.decrypt(expected)).toEqual(bytes)
        expect(pureKey.decrypt(actual)).toEqual(bytes)
      }
      expect(native.createCipheriv).toHaveBeenCalledTimes(1)
      expect(native.createDecipheriv).toHaveBeenCalledTimes(size === 0 ? 0 : 1)
      expect(native.createCipheriv.mock.calls[0][2]).toHaveLength(32)
    }
  )

  it.each(['iv', 'ciphertext', 'tag', 'key'] as const)(
    'rejects tampered %s with the same error as the pure SDK',
    part => {
      const native = loadSdk(nativeBackend())
      const pure = loadSdk()
      const ciphertext = new pure.SymmetricKey(KEY).encrypt([1, 2, 3]) as number[]
      if (part !== 'key') ciphertext[{ iv: 0, ciphertext: 32, tag: ciphertext.length - 1 }[part]] ^= 1
      const key = part === 'key' ? KEY.map(x => x ^ 1) : KEY
      expect(() => new native.SymmetricKey(key).decrypt(ciphertext)).toThrow('Decryption failed!')
      expect(() => new pure.SymmetricKey(key).decrypt(ciphertext)).toThrow('Decryption failed!')
    }
  )

  it.each([0, 1, 31, 32, 47])('rejects truncated %i-byte ciphertext before invoking native crypto', size => {
    const backend = nativeBackend()
    const routed = loadSdk(backend)
    const pure = loadSdk()
    const bytes = Array(size).fill(0)
    expect(() => new routed.SymmetricKey(KEY).decrypt(bytes)).toThrow('Ciphertext too short')
    expect(() => new pure.SymmetricKey(KEY).decrypt(bytes)).toThrow('Ciphertext too short')
    expect(backend.createDecipheriv).not.toHaveBeenCalled()
  })

  it('keeps hex encoding and pure-JS fallback when native cipher creation is unavailable', () => {
    const backend = nativeBackend()
    backend.createCipheriv.mockImplementation(() => {
      throw new Error('unsupported cipher')
    })
    const routed = loadSdk(backend)
    const pure = loadSdk()
    expect(new routed.SymmetricKey(KEY).encrypt('00ff0102', 'hex')).toEqual(
      new pure.SymmetricKey(KEY).encrypt('00ff0102', 'hex')
    )
    expect(backend.createCipheriv).toHaveBeenCalledTimes(1)
  })

  it('keeps Node runtime detection when no mobile backend is installed', () => {
    const backend = nativeBackend()
    const detector = jest.fn(() => backend)
    const sdk = loadSdk(undefined, detector)
    const key = new sdk.SymmetricKey(KEY)
    const cipher = key.encrypt([1, 2, 3]) as number[]
    expect(key.decrypt(cipher)).toEqual([1, 2, 3])
    expect(key.decrypt(key.encrypt([]) as number[])).toEqual([])
    expect(detector).toHaveBeenCalledWith('node:crypto')
    expect(backend.createCipheriv).toHaveBeenCalledTimes(2)
  })
})

describe('native SDK hashes, HMAC and PBKDF2', () => {
  it.each(['sha256', 'sha512', 'ripemd160', 'hash256', 'hash160'] as const)(
    '%s matches the pure SDK for binary views and strings',
    name => {
      const backend = nativeBackend()
      const routed = loadSdk(backend)
      const pure = loadSdk()
      const bytes = Uint8Array.from([99, 1, 2, 255, 0, 87]).subarray(1, 5)
      // Some SDK declarations still say number[]; the runtime accepts typed-array views.
      expect(routed.Hash[name](bytes as unknown as number[])).toEqual(pure.Hash[name](bytes as unknown as number[]))
      expect(routed.Hash[name]('wallet ✓', 'utf8')).toEqual(pure.Hash[name]('wallet ✓', 'utf8'))
      expect(routed.Hash[name]('00ff0102', 'hex')).toEqual(pure.Hash[name]('00ff0102', 'hex'))
      expect(backend.createHash).toHaveBeenCalled()
    }
  )

  it.each(['SHA256', 'SHA512'] as const)('incremental %s digests preserve chunk boundaries and encodings', name => {
    const backend = nativeBackend()
    const routed = loadSdk(backend)
    const pure = loadSdk()
    const fill = (hash: any) => hash.update([1, 2]).update('abcd', 'hex').update([0, 255])
    expect(fill(new routed.Hash[name]()).digest()).toEqual(fill(new pure.Hash[name]()).digest())
    expect(fill(new routed.Hash[name]()).digestHex()).toEqual(fill(new pure.Hash[name]()).digestHex())
    expect(backend.createHash).toHaveBeenCalled()
  })

  it.each(['sha256hmac', 'sha512hmac'] as const)('%s matches the pure SDK with long and short keys', name => {
    const backend = nativeBackend()
    const routed = loadSdk(backend)
    const pure = loadSdk()
    for (const length of [0, 1, 32, 200]) {
      const key = Array.from({ length }, (_, i) => i & 255)
      expect(routed.Hash[name](key, [0, 1, 255])).toEqual(pure.Hash[name](key, [0, 1, 255]))
    }
    expect(backend.createHmac).toHaveBeenCalledTimes(4)
  })

  it('PBKDF2-SHA512 matches the pure SDK including the BIP39 iteration count', () => {
    const backend = nativeBackend()
    const routed = loadSdk(backend)
    const pure = loadSdk()
    const password = Array.from(Buffer.from('mnemonic password', 'utf8'))
    const salt = Array.from(Buffer.from('mnemonic passphrase', 'utf8'))
    for (const iterations of [1, 2, 2048]) {
      expect(routed.Hash.pbkdf2(password, salt, iterations, 64)).toEqual(
        pure.Hash.pbkdf2(password, salt, iterations, 64)
      )
    }
    expect(backend.pbkdf2Sync).toHaveBeenCalledTimes(3)
    expect(() => routed.Hash.pbkdf2(password, salt, 1, 64, 'sha256' as 'sha512')).toThrow('Only sha512')
  })

  it('falls back to SDK hashes when the installed backend lacks an algorithm', () => {
    const backend = nativeBackend()
    backend.createHash.mockImplementation(() => {
      throw new Error('unavailable')
    })
    backend.createHmac.mockImplementation(() => {
      throw new Error('unavailable')
    })
    const routed = loadSdk(backend)
    const pure = loadSdk()
    expect(routed.Hash.sha256([1, 2, 3])).toEqual(pure.Hash.sha256([1, 2, 3]))
    expect(routed.Hash.sha512hmac([1], [2])).toEqual(pure.Hash.sha512hmac([1], [2]))
  })
})

it('installs the native crypto seam before the app entrypoint can load the SDK', () => {
  const runtime: any = {}
  const backend = {
    getRandomValues: jest.fn(),
    install: jest.fn(() => {
      runtime.crypto = backend
    })
  }
  const requireModule = jest.fn((name: string) => {
    if (name === 'react-native-quick-crypto') return backend
    if (name === 'react-native-secp-native') return { installSecpNative: () => true }
    if (name === 'react-native-engine-native') return { installEngineNative: () => true }
    if (name === 'expo-router/entry') {
      expect(backend.install).toHaveBeenCalledTimes(1)
      expect(runtime.__bsvNativeCrypto).toBe(backend)
      return {}
    }
    throw new Error(`Unexpected boot dependency ${name}`)
  })
  const entry = readFileSync(join(__dirname, '../index.js'), 'utf8')
  new Function('require', 'global', 'globalThis', '__DEV__', 'process', entry)(requireModule, runtime, runtime, false, {
    env: {}
  })
  expect(requireModule).toHaveBeenLastCalledWith('expo-router/entry')
})
