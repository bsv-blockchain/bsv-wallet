// Setting up the vault: the shared core's enrolment wizard (two or more
// YubiKeys, each with a PIN and a touch), unchanged, under this app's header.
// The core's Vault screen opens the same wizard; this skips its intro, which
// Vault (app/vault/index.tsx) already gives in the prototype's words.
import React from 'react'
import { View } from 'react-native'
import { Redirect, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { isVaultEnabled } from '@bsv/expo-wallet-toolbox'
import { EnrollWizard } from '@bsv/expo-wallet-toolbox/ui'
import { usePalette } from '../../src/theme'
import { PageHeader } from '../../src/ui/PageHeader'
import { DevKeys } from '../../src/vault/DevKeys'

export default function VaultSetup() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  if (!isVaultEnabled()) return <Redirect href="/" />
  return (
    <View style={{ flex: 1, backgroundColor: palette.background, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <View style={{ paddingHorizontal: 16 }}>
        <PageHeader title="Set up your vault" onBack={() => router.back()} />
      </View>
      <EnrollWizard mode="enroll" onDone={() => router.back()} onCancel={() => router.back()} />
      {__DEV__ && (
        <View style={{ paddingHorizontal: 16 }}>
          <DevKeys />
        </View>
      )}
    </View>
  )
}
