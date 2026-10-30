/**
 * Encrypted wallet-database export format: round trip, and the STREAM
 * properties the chunk nonce exists for — a dropped, swapped, truncated or
 * altered chunk, or a different wallet, must never yield an image.
 */
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  decryptDbImage,
  encryptDbImage,
  EncryptedDbError,
  isEncryptedDbImage,
  type ByteSink,
  type ByteSource
} from '../core/storage/encryptedDbImage'

function source(bytes: Uint8Array): ByteSource {
  let off = 0
  return {
    size: bytes.length,
    read(n: number) {
      const out = bytes.slice(off, off + n)
      off += out.length
      return out
    }
  }
}

function sink(): ByteSink & { bytes(): Uint8Array } {
  const parts: Uint8Array[] = []
  return {
    write: b => void parts.push(Uint8Array.from(b)),
    bytes() {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let o = 0
      for (const p of parts) {
        out.set(p, o)
        o += p.length
      }
      return out
    }
  }
}

const wallet = new ProtoWallet(PrivateKey.fromRandom())
const CHUNK = 64

async function encrypt(plain: Uint8Array, w = wallet): Promise<Uint8Array> {
  const out = sink()
  await encryptDbImage(w, source(plain), out, { chunkSize: CHUNK })
  return out.bytes()
}

async function decrypt(enc: Uint8Array, w = wallet): Promise<Uint8Array> {
  const out = sink()
  await decryptDbImage(w, source(enc), out)
  return out.bytes()
}

function randomBytes(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff)
}

/** Offset of the first chunk: magic(8) + u16 len + wrapped key. */
function bodyStart(enc: Uint8Array): number {
  return 10 + ((enc[8] << 8) | enc[9])
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(EncryptedDbError)
  await expect(p).rejects.toMatchObject({ code })
}

describe('encrypted wallet database image', () => {
  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 5, CHUNK * 5 + 17])('round-trips %i bytes', async n => {
    const plain = randomBytes(n)
    const enc = await encrypt(plain)
    expect(isEncryptedDbImage(enc)).toBe(true)
    expect(await decrypt(enc)).toEqual(plain)
  })

  it('does not contain the plaintext', async () => {
    const plain = new TextEncoder().encode('SQLite format 3\0'.repeat(20))
    const enc = await encrypt(plain)
    expect(Buffer.from(enc).includes(Buffer.from('SQLite format 3'))).toBe(false)
  })

  it('refuses a file another wallet exported', async () => {
    const other = new ProtoWallet(PrivateKey.fromRandom())
    await expectCode(decrypt(await encrypt(randomBytes(100)), other), 'wrong-wallet')
  })

  it('refuses a file with its last chunk cut off', async () => {
    const enc = await encrypt(randomBytes(CHUNK * 3))
    await expectCode(decrypt(enc.slice(0, enc.length - (CHUNK + 16))), 'corrupt')
  })

  it('refuses a file cut mid-chunk', async () => {
    const enc = await encrypt(randomBytes(CHUNK * 3))
    await expectCode(decrypt(enc.slice(0, enc.length - 5)), 'corrupt')
  })

  it('refuses a file cut right after the header', async () => {
    const enc = await encrypt(randomBytes(CHUNK * 2))
    await expectCode(decrypt(enc.slice(0, bodyStart(enc))), 'corrupt')
  })

  it('refuses a file with trailing bytes appended', async () => {
    const enc = await encrypt(randomBytes(CHUNK * 2))
    await expectCode(decrypt(new Uint8Array([...enc, ...new Uint8Array(CHUNK + 16)])), 'corrupt')
  })

  it('refuses swapped chunks', async () => {
    const enc = await encrypt(randomBytes(CHUNK * 3))
    const s = bodyStart(enc)
    const sealed = CHUNK + 16
    const a = enc.slice(s, s + sealed)
    const b = enc.slice(s + sealed, s + 2 * sealed)
    const swapped = Uint8Array.from(enc)
    swapped.set(b, s)
    swapped.set(a, s + sealed)
    await expectCode(decrypt(swapped), 'corrupt')
  })

  it('refuses a flipped tag byte', async () => {
    const enc = await encrypt(randomBytes(CHUNK * 2))
    enc[enc.length - 1] ^= 1
    await expectCode(decrypt(enc), 'corrupt')
  })

  it('refuses a flipped ciphertext byte', async () => {
    const enc = await encrypt(randomBytes(CHUNK * 2))
    enc[bodyStart(enc) + 3] ^= 1
    await expectCode(decrypt(enc), 'corrupt')
  })

  it('refuses a plain SQLite file as not encrypted', async () => {
    await expectCode(decrypt(new TextEncoder().encode('SQLite format 3\0' + 'x'.repeat(100))), 'not-encrypted')
  })

  it('reports progress up to 1', async () => {
    const seen: number[] = []
    await encryptDbImage(wallet, source(randomBytes(CHUNK * 4)), sink(), {
      chunkSize: CHUNK,
      onProgress: f => seen.push(f)
    })
    expect(seen).toEqual([0.25, 0.5, 0.75, 1])
  })

  it('refuses a crypto backend whose GCM final() accepts a wrong tag', async () => {
    const real = (globalThis as { process: { getBuiltinModule(id: string): any } }).process.getBuiltinModule(
      'node:crypto'
    )
    const broken = {
      randomBytes: (n: number) => real.randomBytes(n),
      createCipheriv: (...a: unknown[]) => real.createCipheriv(...a),
      createDecipheriv: (...a: unknown[]) => {
        const d = real.createDecipheriv(...a)
        return {
          setAuthTag: (t: Uint8Array) => d.setAuthTag(t),
          update: (b: Uint8Array) => d.update(b),
          final: () => new Uint8Array(0)
        }
      }
    }
    const g = globalThis as { __bsvNativeCrypto?: unknown }
    g.__bsvNativeCrypto = broken
    try {
      await expectCode(encrypt(randomBytes(10)), 'no-native-crypto')
    } finally {
      delete g.__bsvNativeCrypto
    }
  })
})
