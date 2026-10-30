/**
 * Registers the overlay's React root under the name the sheet Activity asks for (`getMainComponentName`). The component
 * is loaded when React Native first asks for it (the sheet Activity starting), not when the host entry runs: the root
 * pulls in the permission sheet and the toolbox contexts, which the host entry has no use for at module scope.
 */
import { AppRegistry } from 'react-native'

export const SHEET_COMPONENT_NAME = 'BsvBridgeSheet'

let registered = false

/** Idempotent: module scope runs again on Fast Refresh. */
export function registerSheetRoot(): void {
  if (registered) return
  registered = true
  AppRegistry.registerComponent(
    SHEET_COMPONENT_NAME,
    () => (require('./BridgeSheetRoot') as typeof import('./BridgeSheetRoot')).BridgeSheetRoot
  )
}

/** Test seam. */
export function __resetSheetRootRegistrationForTests(): void {
  registered = false
}
