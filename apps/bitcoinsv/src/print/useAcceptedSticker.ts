// What the "BitcoinSV Accepted Here" sticker needs from the open wallet: its
// pay link as a website link (https://<domain>/pay/<identity key>?url=…, the
// same link Get paid shares, for any amount), as a QR code a phone camera
// opens, and its @handle. Safe to share: it only ever pays this wallet.
//
// The printed link outlives a build's settings, so it's on the app's link
// domain, and bitcoinsv.com while that isn't set (src/links/linkDomain.ts).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { NO_MESSAGE_BOX, peerPayLinkFor, useWallet } from '@bsv/expo-wallet-toolbox'
import { useMessageBoxConfig } from '@bsv/expo-wallet-toolbox/ui'
import { HANDLE_KV_KEY } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileKeys'
import { toWebLink } from '../links/webLinks'
import { LINK_DOMAIN } from '../links/linkDomain'
import type { AcceptedSticker } from './labelPlan'

/** Where printed links point: the app's link domain, or bitcoinsv.com. */
export const STICKER_DOMAIN = LINK_DOMAIN || 'bitcoinsv.com'

/** The sticker's link and QR code for the open wallet, once its identity is known; null until then. */
export function useAcceptedSticker(): { link: string; sticker: (shop?: string) => AcceptedSticker } | null {
  const { t } = useTranslation()
  const { managers, adminOriginator, storage, switchingProfile } = useWallet()
  const { messageBoxUrl } = useMessageBoxConfig(t)
  const [identityKey, setIdentityKey] = useState('')
  const [handle, setHandle] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)

  const wallet = managers.permissionsManager
  useEffect(() => {
    let alive = true
    if (switchingProfile) return
    wallet
      ?.getPublicKey({ identityKey: true }, adminOriginator)
      .then(r => alive && setIdentityKey(r.publicKey))
      .catch(() => {})
    storage
      ?.getKeyValue(HANDLE_KV_KEY)
      .then(v => alive && setHandle(v ?? null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [wallet, adminOriginator, storage, switchingProfile])

  const box = messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX ? messageBoxUrl : undefined
  const link = identityKey ? toWebLink(peerPayLinkFor(identityKey, undefined, box), STICKER_DOMAIN) : ''

  useEffect(() => {
    let alive = true
    if (!link) return
    void QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000', light: '#0000' } }).then(x => alive && setQr(x))
    return () => {
      alive = false
    }
  }, [link])

  if (!link || !qr) return null
  const at = handle ? `@${handle.split('@')[0]}` : null
  return { link, sticker: (shop?: string) => ({ qr, handle: at, shop }) }
}
