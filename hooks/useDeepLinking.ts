import { useCallback, useEffect } from 'react'
import { Linking } from 'react-native'
import { router } from 'expo-router'

/**
 * Deep linking for a payments-only wallet:
 *  - peerpay:            → /pay (PeerPay payment handles)
 *  - bsv-wallet://pair   → /connections (pairing QR codes scanned outside the app)
 */
export function useDeepLinking() {
  const handlePeerPayLink = useCallback((url: string) => {
    router.replace({ pathname: '/pay', params: { cell: 'pay-handle', peerpay: url } })
  }, [])

  /**
   * Handle bsv-wallet://pair?topic=...&backendIdentityKey=...&protocolID=...&origin=...&expiry=...&sig=...
   * Parses pairing parameters and navigates to /connections with them.
   */
  const handlePairingLink = useCallback((url: string) => {
    try {
      // URL constructor needs a host to parse search params
      const parsed = new URL(url.replace('bsv-wallet://', 'bsv-wallet://host/'))
      const get = (key: string) => parsed.searchParams.get(key) ?? undefined

      const topic = get('topic')
      const backendIdentityKey = get('backendIdentityKey')
      const protocolID = get('protocolID')
      const origin = get('origin')
      const expiry = get('expiry')
      const sig = get('sig')

      if (!topic || !backendIdentityKey || !protocolID || !origin || !expiry) {
        console.warn('[Deep Link] Pairing link missing required params, ignoring:', url)
        return
      }

      router.push({
        pathname: '/connections',
        params: { topic, backendIdentityKey, protocolID, origin, expiry, sig }
      })
    } catch (error) {
      console.error('[Deep Link] Error handling pairing link:', error)
    }
  }, [])

  useEffect(() => {
    let active = true

    const handleUrl = (url: string) => {
      if (!url) return
      if (url.startsWith('bsv-wallet://pair')) {
        handlePairingLink(url)
      } else if (url.toLowerCase().startsWith('peerpay:')) {
        handlePeerPayLink(url)
      }
    }

    Linking.getInitialURL()
      .then(url => {
        if (active && url) handleUrl(url)
      })
      .catch(error => console.error('[Deep Link] Failed to read initial URL:', error))

    const subscription = Linking.addEventListener('url', event => handleUrl(event.url))
    return () => {
      active = false
      subscription.remove()
    }
  }, [handlePairingLink, handlePeerPayLink])
}
