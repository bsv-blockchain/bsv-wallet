import { useEffect } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { isE2eBuild } from '@bsv/expo-wallet-toolbox'
import { presentE2eConsentFixture } from '@bsv/expo-wallet-toolbox/core/e2e/consentFixture'

/**
 * Harness-only route. A production build redirects home and never registers
 * a consent fixture. The E2E suite opens it to raise the PermissionSheet.
 */
export default function E2eConsentRoute() {
  const router = useRouter()

  useEffect(() => {
    if (!isE2eBuild()) {
      router.replace('/')
      return
    }
    presentE2eConsentFixture()
  }, [router])

  if (!isE2eBuild()) return null
  return <View testID="e2e-consent-route" style={{ flex: 1 }} />
}
