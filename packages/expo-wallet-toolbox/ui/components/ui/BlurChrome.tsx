import React from 'react'
import { StyleSheet, View, Platform } from 'react-native'
import { useTheme } from '@bsv/expo-wallet-toolbox'

interface BlurChromeProps {
  children: React.ReactNode
  intensity?: number
  borderRadius?: number
  style?: any
}

/**
 * expo-blur ships an untransformed ESM barrel
 * (`export { default as BlurView } from './BlurView'`), which Jest cannot
 * parse for any consumer of the `ui` package barrel — even on Android/test
 * environments that never render it. Required lazily (only when actually
 * rendering on iOS), same pattern as core/context/WalletContext.tsx's lazy
 * expo-router load.
 */
type BlurViewComponent = typeof import('expo-blur').BlurView
let blurViewComponent: BlurViewComponent | undefined
function loadBlurView(): BlurViewComponent {
  if (!blurViewComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    blurViewComponent = require('expo-blur').BlurView as BlurViewComponent
  }
  return blurViewComponent
}

/**
 * Translucent wrapper using expo-blur on iOS, solid fallback on Android.
 * Used for toolbar chrome and floating glass pill fallbacks.
 */
export const BlurChrome: React.FC<BlurChromeProps> = ({
  children,
  intensity = 80,
  borderRadius = 0,
  style
}) => {
  const { isDark, colors } = useTheme()

  if (Platform.OS === 'ios') {
    const BlurView = loadBlurView()
    return (
      <BlurView
        intensity={intensity}
        tint={isDark ? 'dark' : 'light'}
        style={[styles.container, { borderRadius }, style]}
      >
        {children}
      </BlurView>
    )
  }

  return (
    <View
      style={[
        styles.container,
        { borderRadius, backgroundColor: colors.chromeBackground },
        style
      ]}
    >
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
})
