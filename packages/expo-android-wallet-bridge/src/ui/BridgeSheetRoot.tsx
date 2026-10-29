/**
 * The second React root's component, registered as `BsvBridgeSheet` (spec 6.11, 7.4). It renders the same
 * `PermissionSheet` the main tree renders, from contexts relayed out of the first root, inside a translucent Activity
 * over Chrome. It adds no text of its own.
 *
 * - Only while the sheet window owns the sheet (`useSheetOwnerDeferred('overlay')`); otherwise it renders nothing.
 * - The scrim is `rgba(0,0,0,0.9)` while something is pending and fully transparent otherwise, so an empty sheet is
 *   visually clear. It has no press handler: an outside tap does nothing.
 * - `filterTouchesWhenObscured` on the root, and native `setSheetInteractive(pending)` on every change of "something
 *   pending" so the window takes touches only while there is something to answer.
 */
import React, { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ContextRelaySubscriber } from '@bsv/expo-wallet-toolbox/ui/bridgeSheet/ContextRelay'
import PermissionSheet, { usePermissionSheetBusy } from '@bsv/expo-wallet-toolbox/ui/components/ui/PermissionSheet'
import { signalSheetResumed } from '@bsv/expo-wallet-toolbox/ui/components/ui/sheetResumeSignal'
import { getBsvAndroidBridge, type BsvAndroidBridgeNative } from '../native'
import { useSheetOwnerDeferred } from './sheetOwner'

/**
 * `filterTouchesWhenObscured` is an Android `View` property that React Native's typings do not declare (0.86). The
 * prop is stated on the root as the spec requires; the guarantee itself comes from `BridgeSheetActivity`, which sets it
 * on the Activity's content view natively (and from `TouchGuard`, which drops obscured touches before they get here).
 */
const OBSCURED_FILTER = { filterTouchesWhenObscured: true } as object

export const SCRIM_COLOR = 'rgba(0,0,0,0.9)'

type SheetNative = Pick<BsvAndroidBridgeNative, 'setSheetInteractive' | 'hostLifecycle' | 'addListener'>

let nativeOverride: SheetNative | undefined
/** Tests inject a fake; the app uses the real module. */
export function setBridgeSheetNative(native: SheetNative | undefined): void {
  nativeOverride = native
}
const nativeOf = (): SheetNative => nativeOverride ?? getBsvAndroidBridge()

let mounts = 0

function Pending(): React.ReactElement {
  const pending = usePermissionSheetBusy()
  useEffect(() => {
    nativeOf().setSheetInteractive(pending)
  }, [pending])
  return (
    <>
      <View
        testID="bridge-sheet-scrim"
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: pending ? SCRIM_COLOR : 'transparent' }]}
      />
      <PermissionSheet backdropDismisses={false} />
    </>
  )
}

function Mounted(): React.ReactElement {
  useEffect(() => {
    mounts += 1
    // Counts only, never a value (O13).
    console.log(`BsvBridgeSheet sheet-root mount n=${mounts}`)
    // A sheet that mounted after the Activity resumed missed `AppState`'s `active`: nudge its open position when the
    // sheet window resumes later too.
    const sub = nativeOf().addListener('onHostLifecycle', l => {
      if (l.sheetResumed) signalSheetResumed()
    })
    if (nativeOf().hostLifecycle().sheetResumed) signalSheetResumed()
    return () => {
      sub.remove()
    }
  }, [])
  return (
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaProvider>
        <View testID="bridge-sheet-root" style={styles.fill} {...OBSCURED_FILTER}>
          <ContextRelaySubscriber>
            <Pending />
          </ContextRelaySubscriber>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

export function BridgeSheetRoot(): React.ReactElement | null {
  const mayRender = useSheetOwnerDeferred('overlay')
  return mayRender ? <Mounted /> : null
}

const styles = StyleSheet.create({ fill: { flex: 1 } })

export default BridgeSheetRoot
