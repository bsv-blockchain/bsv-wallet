/**
 * useRecoveryDeps — wires the plain `RestoreWalletDeps & CreateWalletDeps`
 * orchestration modules (restoreWallet, recoverWallet, createWallet) to this
 * app's real providers: `useWallet()` for the build/rebuild/status surface,
 * `useLocalStorage()` for the secret store, `backupAttestation` for the raw
 * writers (per the design's "keep the raw writers" decision —
 * `recordBackupAttestation` stays unused), and `generateMnemonicWallet` for
 * the create path's generator.
 *
 * `isWalletBuilt` is `getWalletBuilt`, not `walletBuilt`: the orchestration
 * modules read it fresh across their internal `await`s (see restoreWallet.ts
 * and createWallet.ts's own docs for why), and only the ref-backed getter can
 * answer that — a captured `walletBuilt` boolean would be whatever it was at
 * the render that produced this deps object, not "right now".
 *
 * Memoised on the individual function identities from each provider, NOT on
 * the provider's return object — `useWallet()`/`useLocalStorage()` are
 * plain `useContext` reads that hand back a fresh object every render even
 * when nothing inside it changed, so depending on the objects themselves
 * would rebuild (and hand every consumer a new-identity) deps object on
 * every render of whatever calls this hook.
 */
import { useMemo } from 'react'
import { useWallet } from '../context/WalletContext'
import { useLocalStorage } from '../context/LocalStorageProvider'
import { backupAttestation } from '../services/vault/backupAttestation'
import { generateMnemonicWallet } from '../mnemonicWallet'
import type { RestoreWalletDeps } from './restoreWallet'
import type { CreateWalletDeps } from './createWallet'

export function useRecoveryDeps(): RestoreWalletDeps & CreateWalletDeps {
  const wallet = useWallet()
  const local = useLocalStorage()

  const { setMnemonic, setRecoveredKey, deleteMnemonic, deleteRecoveredKey, hasStoredIdentity, createMnemonic } = local
  const { buildWalletFromMnemonic, buildWalletFromRecoveredKey, rebuildWallet, getWalletBuilt, getBackupRestore } =
    wallet

  return useMemo(
    () => ({
      setMnemonic,
      setRecoveredKey,
      deleteMnemonic,
      deleteRecoveredKey,
      hasStoredIdentity,
      createMnemonic,
      buildWalletFromMnemonic,
      buildWalletFromRecoveredKey,
      rebuildWallet,
      isWalletBuilt: getWalletBuilt,
      getBackupRestore,
      attest: backupAttestation.set,
      markPending: backupAttestation.markPending,
      generate: generateMnemonicWallet
    }),
    [
      setMnemonic,
      setRecoveredKey,
      deleteMnemonic,
      deleteRecoveredKey,
      hasStoredIdentity,
      createMnemonic,
      buildWalletFromMnemonic,
      buildWalletFromRecoveredKey,
      rebuildWallet,
      getWalletBuilt,
      getBackupRestore
    ]
  )
}
