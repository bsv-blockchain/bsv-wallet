/**
 * Read back metadata the permissions manager encrypted on its way into storage.
 *
 * `WalletPermissionsManager` transparently encrypts descriptions and
 * customInstructions with its own admin protocol (`maybeEncryptMetadata`) and
 * decrypts them again as results leave `listActions` / `listOutputs`. Anything
 * that reads the tables directly — a resend rebuilding a payment from the
 * transaction's own output rows — sees base64 ciphertext instead.
 *
 * Prefers the manager's own method when it is there, so this cannot drift from
 * how the value was written; falls back to the same decrypt call the manager
 * makes, which is fixed by the token format and safe to restate.
 */
import { Utils } from '@bsv/sdk'

/** WalletPermissionsManager.METADATA_ENCRYPTION_PROTOCOL. */
const METADATA_PROTOCOL: [number, string] = [2, 'admin metadata encryption']

type ManagerLike = {
  maybeDecryptMetadata?: (value: string) => Promise<string>
  decrypt?: (
    args: { ciphertext: number[]; protocolID: [number, string]; keyID: string },
    originator?: string
  ) => Promise<{ plaintext: number[] }>
}

export function makeMetadataDecryptor(
  manager: unknown,
  adminOriginator?: string
): ((value: string) => Promise<string>) | undefined {
  const pm = manager as ManagerLike | null | undefined
  if (!pm) return undefined
  return async (value: string) => {
    if (typeof pm.maybeDecryptMetadata === 'function') return await pm.maybeDecryptMetadata(value)
    if (typeof pm.decrypt !== 'function') return value
    const { plaintext } = await pm.decrypt(
      { ciphertext: Utils.toArray(value, 'base64'), protocolID: METADATA_PROTOCOL, keyID: '1' },
      adminOriginator
    )
    return Utils.toUTF8(plaintext)
  }
}
