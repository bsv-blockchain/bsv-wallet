// Each wallet on this phone keeps its own look. The app's avatar preferences
// (prefs.avatarBg, avatarPortrait, avatarUri) are always the open wallet's:
// on a switch, the one being left is saved under its profile index and the
// one opening is put back, so every screen keeps reading them as before. Its
// handle and name are remembered too, for the wallet switcher, which can only
// read the open wallet's own storage. So are its first steps (prefs.tourDone,
// setupHidden), as the prototype keeps them per wallet: a new wallet starts
// them afresh, with its own tour and Get set up. Backing up is the phrase's,
// not a wallet's (decision 3), so it isn't among them.
import { useEffect, useRef } from 'react'
import { useActiveProfileIndex, useWallet } from '@bsv/expo-wallet-toolbox'
import { DISPLAY_NAME_KV_KEY, HANDLE_KV_KEY } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileKeys'
import { getPrefs, setPref, usePrefs, type WalletLook } from './prefs'

const lookOf = (): WalletLook => {
  const p = getPrefs()
  return { avatarBg: p.avatarBg, avatarPortrait: p.avatarPortrait, avatarUri: p.avatarUri, tourDone: p.tourDone, setupHidden: p.setupHidden }
}

const saveLook = (index: number, look: Partial<WalletLook>) => {
  const looks = getPrefs().looks
  setPref('looks', { ...looks, [index]: { ...looks[index], ...look } })
}

/** Mounted once inside the wallet provider. */
export function WalletLooksSync() {
  const prefs = usePrefs()
  const active = useActiveProfileIndex()
  const { storage, switchingProfile } = useWallet()
  const last = useRef<number | null>(null)
  // the storage that was open when the switch began: still the old wallet's
  const leaving = useRef<unknown>(null)

  // a switch: keep the old wallet's look, put the new one's back
  useEffect(() => {
    if (!prefs.loaded) return
    const prev = last.current
    last.current = active
    if (prev === null) {
      saveLook(active, lookOf())
      return
    }
    if (prev === active) return
    leaving.current = storage
    saveLook(prev, lookOf())
    const p = getPrefs()
    // a wallet being made has opened: its pending handle is for it from now on
    if (p.pendingHandleProfile === -1 && !p.looks[active]) setPref('pendingHandleProfile', active)
    const known = p.looks[active]
    const next = known ?? p.stagedLook
    if (p.stagedLook && !known) setPref('stagedLook', null)
    setPref('avatarBg', next?.avatarBg ?? null)
    setPref('avatarPortrait', next?.avatarPortrait ?? null)
    setPref('avatarUri', next?.avatarUri ?? null)
    // its first steps: a wallet new here starts them afresh; one remembered
    // from before they were kept per wallet goes on as the phone was
    setPref('tourDone', known ? (known.tourDone ?? p.tourDone) : false)
    setPref('setupHidden', known ? (known.setupHidden ?? p.setupHidden) : false)
    saveLook(active, { ...next, tourDone: getPrefs().tourDone, setupHidden: getPrefs().setupHidden })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- storage is read at the moment of the switch
  }, [active, prefs.loaded])

  // the open wallet's look and first steps, kept up to date as they change
  useEffect(() => {
    if (prefs.loaded && last.current === active) saveLook(active, lookOf())
  }, [prefs.avatarBg, prefs.avatarPortrait, prefs.avatarUri, prefs.tourDone, prefs.setupHidden, prefs.loaded, active])

  // and its handle and name, from its own storage (once it's open: the index
  // moves before the switched-to wallet's storage does), again after a claim
  useEffect(() => {
    if (!storage || !prefs.loaded || storage === leaving.current || switchingProfile) return
    let live = true
    void Promise.all([storage.getKeyValue(HANDLE_KV_KEY).catch(() => undefined), storage.getKeyValue(DISPLAY_NAME_KV_KEY).catch(() => undefined)]).then(
      ([handle, displayName]) => {
        if (live && getPrefs().looks[active]?.handle !== (handle ?? null)) saveLook(active, { handle: handle ?? null, displayName: displayName ?? null })
      }
    )
    return () => {
      live = false
    }
  }, [storage, active, prefs.loaded, prefs.pendingHandle, switchingProfile])

  return null
}
