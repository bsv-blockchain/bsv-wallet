// Whether this installation has a wallet, read the way the shared core sets
// itself up at launch: it loads profiles and finalises its configuration
// asynchronously, then builds a stored wallet. Until that has settled, the
// answer is 'loading' — never 'none' — so a returning user is not sent to
// create a second wallet while theirs is still opening.
import { useEffect, useState } from 'react'
import { useLocalStorage, useWallet } from '@bsv/expo-wallet-toolbox'

export type WalletPresence = 'loading' | 'ready' | 'none' | 'failed'

export function useWalletPresence(): { presence: WalletPresence; retry: () => void } {
  const { configStatus, walletBuilt, walletBuilding, rebuildWallet } = useWallet()
  const { secretsReady, hasStoredIdentity } = useLocalStorage()
  const [stored, setStored] = useState<boolean | null>(null)

  const settled = configStatus === 'configured' && secretsReady && !walletBuilding
  useEffect(() => {
    let alive = true
    if (!settled || walletBuilt) return
    setStored(null)
    hasStoredIdentity()
      .then(v => alive && setStored(v))
      .catch(() => alive && setStored(null))
    return () => {
      alive = false
    }
  }, [settled, walletBuilt, hasStoredIdentity])

  let presence: WalletPresence = 'loading'
  if (walletBuilt) presence = 'ready'
  else if (settled && stored === false) presence = 'none'
  // stored, settled, but not built: the build failed (e.g. biometrics refused)
  else if (settled && stored === true) presence = 'failed'

  return { presence, retry: () => void rebuildWallet?.() }
}
