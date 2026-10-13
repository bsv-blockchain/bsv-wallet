// Home's wallets: the switcher, and from it bringing a wallet back or making
// a new one. A new wallet is a new profile in the shared core (same recovery
// phrase, decision 3) with a free @handle of its own, chosen the way the first
// one was (CreateWalletSheet). Its handle is claimed once it's the open,
// built wallet (usePendingHandleClaim, by profile), and its look waits for it
// (src/state/walletLooks.ts).
import React, { useState } from 'react'
import { useRouter } from 'expo-router'
import { getActiveProfileIndex, useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../ui/Toast'
import { CreateWalletSheet } from '../onboarding/CreateWalletSheet'
import { HandleCheckout } from '../onboarding/HandleCheckout'
import type { AvatarChoice } from '../onboarding/AvatarPicker'
import { generatedName, type GeneratedHandle } from '../handles/generator'
import { ImportWalletSheet } from '../restore/ImportWalletSheet'
import { setPref } from '../state/prefs'
import { useFirstWallet } from '../state/useFirstWallet'
import { WalletSwitcher } from './WalletSwitcher'

export function Wallets({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter()
  const { addProfile } = useWallet()
  // availability checks and the registry's domain (its create isn't used: that's the first wallet's)
  const registry = useFirstWallet()
  const [importing, setImporting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checkout, setCheckout] = useState<{ handle: string; monthly: number; yearly: number; avatar: AvatarChoice; generated: GeneratedHandle } | null>(null)

  const create = async (handle: string, displayName: string, avatar: AvatarChoice) => {
    setBusy(true)
    // what the new wallet takes once it opens; its handle is for it alone
    setPref('stagedLook', { avatarBg: avatar.bg, avatarPortrait: avatar.portrait, avatarUri: avatar.uri, handle: null })
    setPref('pendingHandleProfile', -1)
    setPref('pendingHandle', handle)
    setPref('pendingDisplayName', displayName)
    try {
      await addProfile()
      setPref('pendingHandleProfile', getActiveProfileIndex())
      setCreating(false)
      setCheckout(null)
      showToast(`Your new wallet is ready. @${handle} is being claimed.`, { type: 'success' })
      router.replace('/')
    } catch {
      setPref('stagedLook', null)
      setPref('pendingHandle', null)
      setPref('pendingDisplayName', null)
      showToast('The new wallet couldn’t be made. Try again.', { type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <WalletSwitcher open={open} onOpenChange={onOpenChange} onImport={() => setImporting(true)} onCreate={() => setCreating(true)} />
      <ImportWalletSheet open={importing} onOpenChange={setImporting} onDone={() => router.replace('/')} />
      <CreateWalletSheet
        open={creating && !checkout}
        onOpenChange={o => !busy && setCreating(o)}
        domain={registry.domain}
        checkAvailability={registry.checkAvailability}
        busy={busy}
        onCreate={c => void create(c.handle, c.displayName, c.avatar)}
        onCustom={c => setCheckout(c)}
      />
      {checkout && (
        <HandleCheckout
          open={creating && !!checkout}
          onOpenChange={o => !o && setCheckout(null)}
          handle={checkout.handle}
          fallback={checkout.generated.handle}
          monthly={checkout.monthly}
          yearly={checkout.yearly}
          onUseFree={() => {
            const c = checkout
            setCheckout(null)
            void create(c.generated.handle, generatedName(c.generated), c.avatar)
          }}
        />
      )}
    </>
  )
}
