// What Home shows, read from the shared wallet (packages/expo-wallet-toolbox):
// the spendable BSV balance, its value in the display currency at the live
// rate, and whether
// this wallet is backed up. Before a wallet exists everything reads as a new
// wallet: zero balance, not backed up.
import { useEffect, useState } from 'react'
import { readBackupAttestation, useWallet } from '@bsv/expo-wallet-toolbox'
import { useSpendableBalance } from '@bsv/expo-wallet-toolbox/ui'
import { onBackupChanged } from './useBackup'
import { useDisplayCurrency } from './displayCurrency'
import { setPref, usePrefs } from './prefs'

const SATS_PER_BSV = 100_000_000

export interface HomeData {
  hasWallet: boolean
  /** spendable balance in BSV; null while it is still being read */
  bsv: number | null
  /** the same balance in the display currency, at the current rate */
  usd: number | null
  backedUp: boolean
}

export function useHomeData(): HomeData {
  const { managers, adminOriginator, switchingProfile } = useWallet()
  const { fromSats } = useDisplayCurrency()
  const wallet = managers.walletManager
  // the permissions layer answers admin-originator calls (as Vault reads it)
  const pm = managers.permissionsManager
  const sats = useSpendableBalance()
  const prefs = usePrefs()
  const [backedUp, setBackedUp] = useState(false)
  // bumped when a backup is recorded, so the checklist and card update
  const [changed, setChanged] = useState(0)
  useEffect(() => onBackupChanged(() => setChanged(n => n + 1)), [])

  useEffect(() => {
    let alive = true
    // no reads while the core switches wallets: it closes this wallet's database under them
    if (!pm || switchingProfile) {
      setBackedUp(false)
      return
    }
    readBackupAttestation(pm, adminOriginator)
      .then(a => {
        if (a) setPref('phraseBackedUp', true)
        if (alive) setBackedUp(!!a)
      })
      .catch(() => alive && setBackedUp(false))
    return () => {
      alive = false
    }
  }, [pm, adminOriginator, changed, switchingProfile])

  if (!wallet) return { hasWallet: false, bsv: 0, usd: 0, backedUp: false }
  const value = sats ?? null
  return {
    hasWallet: true,
    bsv: value == null ? null : value / SATS_PER_BSV,
    usd: value == null ? null : fromSats(value),
    // the phrase, backed up by any wallet on this phone, covers this one too
    backedUp: backedUp || prefs.phraseBackedUp
  }
}
