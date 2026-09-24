/**
 * recoverWallet — the single retry policy for a recovery attempt (audit §3:
 * on any failure, go back to the input the user already gave, never loop
 * silently on a server error). Wraps `restoreWallet` (called as a value —
 * this module owns no restore logic of its own, only the policy for when to
 * call it again) with the two prompts a screen needs to show:
 *
 *  - `biometric-refused`: the user declined to authenticate the store write.
 *    `retry` tries the exact same secret again (the common case: they meant
 *    to approve and fumbled the prompt); `cancel` gives up after exactly one
 *    store attempt — restoreWallet's own write-order guarantee means a
 *    single refused attempt never partially wrote anything, so there is
 *    nothing to unwind.
 *  - `restore-failed`: the secret was stored but the wallet was NOT built —
 *    the encrypted backup log failed to replay, so `WalletContext` destroys
 *    its never-published storage and the build never completes. `retry`
 *    returns control to the caller's input
 *    state (`retry-later`) rather than looping here — a server-side failure
 *    does not get better by hammering it in a tight loop, and the user may
 *    want to check connectivity first. `skip` re-attempts with
 *    `restore: false`: the secret is stored again (a no-op re-write, since
 *    the KEK is already held this session — see restoreWallet's docs) and
 *    the wallet is (re)built without asking for history replay, which is
 *    the only way this policy can turn a stuck restore into a usable wallet.
 *
 * SDK-FREE BY DESIGN, same as restoreWallet.ts: only `import type` reaches
 * into `./secret`. `restoreWallet` itself is imported as a VALUE (it is
 * called, not just typed), which is exactly why restoreWallet.ts must stay
 * SDK-free too — a value import transitively pulls in whatever that module
 * imports at runtime.
 *
 * The loop is bounded by construction: every branch either returns
 * immediately or falls through to exactly one more `restoreWallet` call
 * before the next prompt decides the branch again. No branch re-enters the
 * loop without first awaiting a human's choice, so it cannot spin without a
 * prompt resolving — and it does not use recursion, so there is no risk of
 * unbounded stack growth either.
 *
 * Does NOT render prompts itself (that's `ui/recoveryPrompts.ts`'s
 * `restorePrompts(t)`, injected here as `opts.prompts`), and does not touch
 * i18n or navigation.
 */
import { restoreWallet } from './restoreWallet'
import type { RestoreWalletDeps, RestoreHistory } from './restoreWallet'
import type { WalletSecret } from './secret'
import type { BackupMedium } from '../services/vault/backupAttestation'

export interface RestorePrompts {
  biometricRefused(): Promise<'retry' | 'cancel'>
  restoreFailed(error?: string): Promise<'retry' | 'skip'>
}

export type RecoveryOutcome =
  | { kind: 'ok'; identityKey: string; secret: WalletSecret; history: RestoreHistory; attested: boolean }
  | { kind: 'cancelled' } // user declined biometrics
  | { kind: 'retry-later' } // restore failed and the user chose retry → caller returns to its input state
  | { kind: 'failed'; error: string }

export async function recoverWallet(
  deps: RestoreWalletDeps,
  secret: WalletSecret,
  opts: { medium: BackupMedium; prompts: RestorePrompts }
): Promise<RecoveryOutcome> {
  let restore = true

  for (;;) {
    const r = await restoreWallet(deps, secret, { restore, medium: opts.medium })

    if (r.kind === 'ok') {
      return { kind: 'ok', identityKey: r.identityKey, secret: r.secret, history: r.history, attested: r.attested }
    }

    if (r.kind === 'failed') {
      return { kind: 'failed', error: r.error }
    }

    if (r.kind === 'biometric-refused') {
      const choice = await opts.prompts.biometricRefused()
      if (choice === 'cancel') return { kind: 'cancelled' }
      continue // retry: same secret, same restore flag
    }

    // r.kind === 'restore-failed'
    const choice = await opts.prompts.restoreFailed(r.error)
    if (choice === 'retry') return { kind: 'retry-later' }
    restore = false // skip: re-attempt without asking for history replay
  }
}
