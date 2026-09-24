/**
 * createNewWallet — the "generate a brand new wallet" path
 * (mnemonic.tsx's handleGenerateNew). SDK-free: the mnemonic generator
 * itself is injected (`deps.generate`, normally `generateMnemonicWallet`),
 * so this module never touches `@bsv/sdk`.
 *
 * Guards FIRST, before generating anything: an already-built wallet or an
 * already-stored identity means this call landed on a device/session that
 * does not need a new secret — generating one anyway and then discovering
 * `createMnemonic` refuses to overwrite it would be a wasted generation (and
 * a phrase shown to the user that was never actually stored). `exists` tells
 * the caller to route to the backup flow for the wallet that is already
 * there instead.
 *
 * `createMnemonic` can also refuse for the same reason (a race: something
 * else created an identity between this function's guard check and the
 * store call) — checked again after a refusal, so that race still resolves
 * to `exists` rather than the more alarming `refused`.
 *
 * Write order on success: generate → createMnemonic (the actual store,
 * which is where the real "does an identity already exist" check lives) →
 * `onStored` (fires BEFORE markPending/build, so the caller can show the
 * words to the user while the build runs in the background — mirrors
 * today's screen's setMnemonic/setMode/setHasExistingWallet timing) →
 * markPending (best-effort: throwing here must not undo a secret that is
 * already safely stored, so it is caught and warned, never propagated) →
 * buildWalletFromMnemonic, called with NO options — a freshly generated
 * mnemonic has no backup history to replay, unlike the restore path.
 *
 * Does NOT touch UI, i18n, or navigation.
 */
export interface CreateWalletDeps {
  /** generateMnemonicWallet, injected so this module stays sdk-free. */
  generate(): { mnemonic: string; identityKey: string }
  hasStoredIdentity(): Promise<boolean>
  createMnemonic(mnemonic: string): Promise<boolean>
  /** backupAttestation.markPending; errors swallowed and warned. */
  markPending(identityKey: string): Promise<void>
  buildWalletFromMnemonic(mnemonic: string): Promise<void>
  isWalletBuilt(): boolean
}

export type CreateOutcome =
  | { kind: 'created'; mnemonic: string; identityKey: string }
  | { kind: 'exists' } // a wallet is already built or an identity is already stored → caller goes to backup flow
  | { kind: 'refused' } // createMnemonic returned false and still no identity stored
  | { kind: 'failed'; error: string }

/**
 * `onStored` fires right after `createMnemonic` succeeds (before
 * markPending/build) so the screen can show the words while the build runs.
 */
export async function createNewWallet(
  deps: CreateWalletDeps,
  opts?: { onStored?: (w: { mnemonic: string; identityKey: string }) => void }
): Promise<CreateOutcome> {
  try {
    if (deps.isWalletBuilt() || (await deps.hasStoredIdentity())) {
      return { kind: 'exists' }
    }

    const generated = deps.generate()

    const stored = await deps.createMnemonic(generated.mnemonic)
    if (!stored) {
      return (await deps.hasStoredIdentity()) ? { kind: 'exists' } : { kind: 'refused' }
    }

    opts?.onStored?.(generated)

    try {
      await deps.markPending(generated.identityKey)
    } catch (err) {
      console.warn('[recovery] markPending failed (mnemonic is already stored):', err)
    }

    await deps.buildWalletFromMnemonic(generated.mnemonic)

    return { kind: 'created', mnemonic: generated.mnemonic, identityKey: generated.identityKey }
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}
