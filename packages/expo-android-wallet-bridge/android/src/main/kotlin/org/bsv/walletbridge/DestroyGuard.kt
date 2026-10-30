package org.bsv.walletbridge

enum class DestroyAction { UNLOAD_ONLY, SUPER }

/**
 * [clearCurrentSheetRef] is true only when the destroyed sheet instance is the one the module still points at, so an old
 * instance destroyed after a newer sheet replaced it never nulls the newer sheet's reference.
 */
data class DestroyDecision(val action: DestroyAction, val clearCurrentSheetRef: Boolean)

/**
 * Sheet `onDestroy` guard (spec 7.4, S4). The sheet shares the React host with `MainActivity`; the default delegate's
 * `onDestroy` would destroy that host. With `MainActivity` alive only the sheet's own root is unloaded; not alive or
 * unknown calls `super` (the sheet is then the last owner and may tear the host down).
 */
object DestroyGuard {
  fun decide(mainAlive: Boolean?, sheetIsCurrent: Boolean): DestroyDecision =
    DestroyDecision(if (mainAlive == true) DestroyAction.UNLOAD_ONLY else DestroyAction.SUPER, sheetIsCurrent)
}
