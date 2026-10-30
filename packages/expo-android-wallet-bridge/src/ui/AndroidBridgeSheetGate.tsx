/**
 * Wraps the main tree's `PermissionSheet` (the host puts it around the one it renders). While the overlay window owns
 * the sheet the children are not rendered, so only one `PermissionSheet` exists across the two React roots. The handover
 * order lives in `useSheetOwnerDeferred`.
 */
import React from 'react'
import { useSheetOwnerDeferred } from './sheetOwner'

export function AndroidBridgeSheetGate({ children }: { children?: React.ReactNode }): React.ReactElement | null {
  const mayRender = useSheetOwnerDeferred('main')
  return mayRender ? <>{children}</> : null
}
