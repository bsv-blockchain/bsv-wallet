/**
 * restoreWallet — one attempt to turn a classified WalletSecret into a built,
 * attested wallet: store it, drop the other secret kind, build (or rebuild),
 * read the backup-replay outcome, attest. Used by both the mnemonic screen
 * (`medium: 'phrase'`) and the scan-shares screen (`medium: 'shares'`);
 * `recoverWallet.ts` wraps this in the retry/skip policy that needs prompts.
 *
 * SDK-FREE BY DESIGN: only `import type` reaches into `./secret` and
 * `../services/vault/backupAttestation` — nothing here may load `@bsv/sdk`
 * at runtime. `__tests__/recovery/sdkFree.test.ts` mocks `@bsv/sdk` to throw
 * and requires this module to prove it. That is what lets a screen test
 * (`__tests__/mnemonicSafety.test.tsx`, which mocks BOTH the toolbox package
 * AND `@bsv/sdk` with closed object literals) wire in the REAL
 * `restoreWallet` via `jest.requireActual` against its existing mocked deps.
 *
 * Write order — why it is exactly this, in this order:
 *
 * 1. Store the new secret FIRST. `setMnemonic`/`setRecoveredKey` can refuse
 *    (a declined biometric prompt) but never throw, so this is the one step
 *    whose "no" is ordinary, not exceptional — handled before anything else
 *    is touched.
 * 2. Only once the store call returned `true` do we delete the OTHER secret
 *    kind. A refused biometric between these two writes must never leave the
 *    device with no secret at all: if step 1 says no, step 2 never runs, and
 *    whatever was already stored (if anything) is untouched. Once step 1
 *    succeeds, exactly one secret kind survives after this function returns
 *    — never both, never neither — which is what makes an auto-rebuild's
 *    "mnemonic wins over WIF" fallback pick the secret that was just
 *    imported instead of a stale one from a previous wallet.
 * 3. Build. If a wallet is ALREADY built (`isWalletBuilt()`, read fresh here
 *    — never a value closed over earlier, because recoverWallet's retry loop
 *    spans awaits during which it can change), `rebuildWallet` is used
 *    instead of `buildWalletFromX`: the plain build fns silently no-op over
 *    an already-built wallet (by design, elsewhere), which would otherwise
 *    make "recover over an already-onboarded wallet" look like a success
 *    while nothing changed.
 * 4. The backup-replay outcome (`getBackupRestore().phase`) is read ONLY
 *    when this attempt asked for a restore. The phase is a leftover from
 *    the LAST restore attempt and is not reset except by requesting another
 *    one — reading it after a `restore:false` attempt (the "skip" retry)
 *    would report a stale failure that this attempt never asked to happen.
 *    A `'failed'` phase here means the build itself may have succeeded but
 *    the wallet's history is incomplete, so this reports `restore-failed`
 *    and skips attestation — a wallet in that state has not proven it can
 *    be recovered from its backup, so it should not be marked "backed up".
 * 5. Attestation is NON-FATAL. By this point the wallet is already built and
 *    usable; a throw from `attest` (network blip, storage error) is
 *    console.warn'd and reported as `attested: false` rather than turning
 *    the whole attempt into a failure. The only consequence of an
 *    unrecorded attestation is that the backup reminder nags again later,
 *    which is the safe direction to fail in — silently swallowing a wallet
 *    that already exists would be worse.
 *
 * This module does NOT decide the retry/skip policy (that's
 * `recoverWallet.ts`, which calls this in a loop), and does not touch UI,
 * i18n, or navigation.
 */
import type { WalletSecret } from './secret'
import type { BackupMedium } from '../services/vault/backupAttestation'

export interface RestoreWalletDeps {
  setMnemonic(mnemonic: string): Promise<boolean>
  setRecoveredKey(wif: string): Promise<boolean>
  deleteMnemonic(): Promise<void>
  deleteRecoveredKey(): Promise<void>
  buildWalletFromMnemonic(mnemonic: string, opts?: { restoreFromBackup?: boolean }): Promise<void>
  buildWalletFromRecoveredKey(wif: string, opts?: { restoreFromBackup?: boolean }): Promise<void>
  rebuildWallet(opts?: { restoreFromBackup?: boolean }): Promise<void>
  /** Read fresh on every call — a React state snapshot goes stale across the awaits inside. */
  isWalletBuilt(): boolean
  getBackupRestore(): { phase: 'idle' | 'checking' | 'restoring' | 'restored' | 'no-backup' | 'failed'; error?: string }
  attest(identityKey: string, medium: BackupMedium): Promise<void>
}

export type RestoreHistory = 'restored' | 'no-backup' | 'skipped' | 'unknown'

export type RestoreOutcome =
  | { kind: 'ok'; identityKey: string; secret: WalletSecret; history: RestoreHistory; attested: boolean }
  | { kind: 'biometric-refused'; secret: WalletSecret }
  | { kind: 'restore-failed'; identityKey: string; secret: WalletSecret; error?: string }
  | { kind: 'failed'; secret: WalletSecret; error: string }

/**
 * One attempt. Never throws — anything thrown by `deps` is caught and
 * reported as `{kind:'failed'}`.
 */
export async function restoreWallet(
  deps: RestoreWalletDeps,
  secret: WalletSecret,
  opts: { restore: boolean; medium: BackupMedium }
): Promise<RestoreOutcome> {
  try {
    const stored =
      secret.kind === 'mnemonic' ? await deps.setMnemonic(secret.mnemonic) : await deps.setRecoveredKey(secret.wif)

    if (!stored) {
      return { kind: 'biometric-refused', secret }
    }

    if (secret.kind === 'mnemonic') {
      await deps.deleteRecoveredKey()
    } else {
      await deps.deleteMnemonic()
    }

    const buildOpts = { restoreFromBackup: opts.restore }
    if (deps.isWalletBuilt()) {
      await deps.rebuildWallet(buildOpts)
    } else if (secret.kind === 'mnemonic') {
      await deps.buildWalletFromMnemonic(secret.mnemonic, buildOpts)
    } else {
      await deps.buildWalletFromRecoveredKey(secret.wif, buildOpts)
    }

    let history: RestoreHistory = 'skipped'
    if (opts.restore) {
      const { phase, error } = deps.getBackupRestore()
      if (phase === 'failed') {
        return { kind: 'restore-failed', identityKey: secret.identityKey, secret, error }
      }
      history = phase === 'restored' || phase === 'no-backup' ? phase : 'unknown'
    }

    let attested = true
    try {
      await deps.attest(secret.identityKey, opts.medium)
    } catch (err) {
      attested = false
      console.warn('[recovery] attestation failed (wallet is already built; backup reminder will nag again):', err)
    }

    return { kind: 'ok', identityKey: secret.identityKey, secret, history, attested }
  } catch (err) {
    return { kind: 'failed', secret, error: err instanceof Error ? err.message : String(err) }
  }
}
