package org.bsv.walletbridge

enum class Role { MAIN, SHEET, OTHER }

data class HostLifecycle(
  val registered: Boolean,
  val mainAlive: Boolean,
  val mainResumed: Boolean,
  val sheetResumed: Boolean
)

/**
 * Pure lifecycle model behind the Android `LifecycleTracker` adapter. Not thread safe: the adapter calls it on the main
 * thread.
 *
 * On a cold start the module registers about 1.8 s after `MainActivity.onCreate`, usually after it has already resumed, so
 * [catchUp] carries both facts. Registration happens only through [catchUp] or an observed `onResumed(MAIN)` (the
 * backstop when the catch-up missed it). Once registered, observed events are authoritative, so a late [catchUp] cannot
 * overwrite them with a stale snapshot.
 */
class LifecycleState {
  private var registered = false
  private var mainAlive = false
  private var mainResumed = false
  private var sheetResumed = false

  fun onCreated(role: Role) {
    if (role == Role.MAIN && registered) mainAlive = true
  }

  fun onResumed(role: Role) {
    when (role) {
      Role.MAIN -> {
        registered = true
        mainAlive = true
        mainResumed = true
      }
      Role.SHEET -> sheetResumed = true
      Role.OTHER -> {}
    }
  }

  fun onPaused(role: Role) {
    when (role) {
      Role.MAIN -> mainResumed = false
      Role.SHEET -> sheetResumed = false
      Role.OTHER -> {}
    }
  }

  fun onDestroyed(role: Role) {
    when (role) {
      Role.MAIN -> {
        mainAlive = false
        mainResumed = false
      }
      Role.SHEET -> sheetResumed = false
      Role.OTHER -> {}
    }
  }

  fun catchUp(mainAlive: Boolean, mainResumed: Boolean) {
    if (registered) return
    registered = true
    this.mainAlive = mainAlive
    this.mainResumed = mainResumed
  }

  fun registered(): Boolean = registered

  /** `null` until registered (unknown). */
  fun mainAlive(): Boolean? = if (registered) mainAlive else null

  fun mainResumed(): Boolean = mainResumed

  fun sheetResumed(): Boolean = sheetResumed

  /** An unknown `mainAlive` maps to false; the unregistered case is decided by `registered` alone. */
  fun snapshot(): HostLifecycle = HostLifecycle(registered, mainAlive == true && registered, mainResumed, sheetResumed)
}
