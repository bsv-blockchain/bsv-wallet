/**
 * PIN-wrapped KEK — a second way to release the same key the enclave holds.
 *
 * The biometric path (kek.ts) is untouched by this file: there, the OS refuses
 * to hand over the KEK without a face or a finger, and that remains the
 * default. This adds an *alternative* wrap of the very same KEK bytes, sealed
 * under a key stretched from the user's PIN, so a user who turns Face ID off
 * still has a way in and a user whose biometrics break is not stranded.
 *
 * THE HARD PART, stated plainly: a 6-digit PIN is 10^6 possibilities — about
 * 20 bits. Against an attacker who has extracted this record from the device,
 * no key-stretching saves it; 210k PBKDF2 iterations turn a full sweep from
 * seconds into roughly a fortnight of one phone's compute, and a motivated
 * attacker with a GPU does far better than that. Two things carry the real
 * weight instead:
 *
 *   1. The record lives in SecureStore under THIS_DEVICE_ONLY, so getting a
 *      copy at all means having defeated the keychain — it never leaves in a
 *      backup or a sync.
 *   2. Online guessing, which is the attack that actually happens (a stolen,
 *      unlocked-once phone), is throttled by pinAttempts.ts.
 *
 * So: the PIN defends against a person holding your phone, not against a
 * forensic extraction. That is the honest boundary, and it is why turning the
 * PIN on does not turn the enclave off — see setBiometricEnabled in kek.ts,
 * which refuses to leave an install with no protection at all.
 *
 * SECURITY: never log a PIN, a derived key, or the KEK.
 */
import { SymmetricKey, Random, Utils } from '@bsv/sdk'
import { PinWrapV1 } from './types'

/** 4 is the floor people expect from a phone; 6 is what the brief asked for. */
export const PIN_MIN_DIGITS = 4
export const PIN_MAX_DIGITS = 6

/**
 * OWASP's 2023 floor for PBKDF2-HMAC-SHA512. Recorded per-wrap rather than
 * assumed, so this can be raised later without orphaning existing installs:
 * an old record keeps opening at its own count and is rewritten at the new one
 * the next time the PIN is set.
 */
export const PIN_KDF_ITERATIONS = 210_000

const SALT_LEN = 16
const KEY_LEN = 32
const DIGEST = 'sha512'

export function isValidPin(pin: string): boolean {
  return new RegExp(`^[0-9]{${PIN_MIN_DIGITS},${PIN_MAX_DIGITS}}$`).test(pin)
}

/* ------------------------------ kdf backend ------------------------------- */

type Pbkdf2Callback = (err: Error | null, derived: Uint8Array | Buffer) => void
interface CryptoBackend {
  pbkdf2?: (
    password: string | Uint8Array,
    salt: string | Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
    cb: Pbkdf2Callback
  ) => void
}

/**
 * The native JSI crypto the app installs at startup (index.js), falling back to
 * the `crypto` module — which Metro aliases to the same package, and which
 * resolves to Node's own under Jest.
 *
 * Deliberately NOT a synchronous derivation: 210k iterations of SHA-512 is
 * hundreds of milliseconds of real work, and doing it on the JS thread would
 * freeze the unlock sheet mid-animation. The callback form hands it to the
 * native thread pool.
 */
function backend(): CryptoBackend {
  const injected = (globalThis as { __bsvNativeCrypto?: CryptoBackend }).__bsvNativeCrypto
  if (injected?.pbkdf2) return injected
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('crypto') as CryptoBackend
  if (!mod?.pbkdf2) throw new Error('pin: no pbkdf2 backend available')
  return mod
}

export function derivePinKey(pin: string, salt: number[], iterations: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    backend().pbkdf2!(
      pin,
      Uint8Array.from(salt),
      iterations,
      KEY_LEN,
      DIGEST,
      (err, derived) => {
        if (err) return reject(err instanceof Error ? err : new Error(String(err)))
        resolve(Array.from(derived))
      }
    )
  })
}

/* -------------------------------- wrapping -------------------------------- */

/** Seal the KEK under a PIN. The KEK value itself is unchanged, so every
 * existing envelope blob keeps opening — this is a second lock on one door,
 * not a re-encryption of the contents. */
export async function sealKekWithPin(kek: number[], kekId: string, pin: string): Promise<PinWrapV1> {
  if (!isValidPin(pin)) throw new Error('pin: invalid PIN')
  const salt = Random(SALT_LEN)
  const key = await derivePinKey(pin, salt, PIN_KDF_ITERATIONS)
  const c = new SymmetricKey(key).encrypt(kek) as number[]
  return {
    v: 1,
    kekId,
    salt: Utils.toHex(salt),
    iterations: PIN_KDF_ITERATIONS,
    c: Utils.toHex(c)
  }
}

/**
 * Open a wrap. Returns null for a wrong PIN rather than throwing: a wrong PIN
 * is an ordinary event on this path, and the GCM tag is what tells us — there
 * is no separate verifier to compare, and therefore nothing to leak.
 */
export async function openKekWithPin(wrap: PinWrapV1, pin: string): Promise<number[] | null> {
  if (!isValidPin(pin)) return null
  if (wrap?.v !== 1 || typeof wrap.salt !== 'string' || typeof wrap.c !== 'string') {
    throw new Error('pin: malformed wrap record')
  }
  const salt = Utils.toArray(wrap.salt, 'hex') as number[]
  const key = await derivePinKey(pin, salt, wrap.iterations || PIN_KDF_ITERATIONS)
  try {
    return new SymmetricKey(key).decrypt(Utils.toArray(wrap.c, 'hex') as number[]) as number[]
  } catch {
    return null
  }
}
