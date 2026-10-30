package org.bsv.walletbridge

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner

/**
 * `Application.ActivityLifecycleCallbacks` adapter around one [LifecycleState] (spec 7.4, tracker race). Every callback
 * runs on the main thread; the published [snapshot] is a volatile copy so the module's synchronous `hostLifecycle()`
 * getter may read it from the JS thread. [onChange] fires after any callback or catch-up that changed the snapshot.
 *
 * The registration flag is process-wide: a module `OnCreate` that runs again after a JS reload never registers the
 * callbacks twice. `raisedByBridge` is cleared when `MainActivity` is destroyed (a wallet the bridge raised is gone).
 */
class LifecycleTracker(private val state: LifecycleState, private val onChange: (HostLifecycle) -> Unit) :
  Application.ActivityLifecycleCallbacks {
  @Volatile var snapshot: HostLifecycle = state.snapshot()
    private set

  private var registeredWith: Application? = null

  /** Idempotent. */
  @Synchronized
  fun register(app: Application) {
    if (registeredWith != null) return
    registeredWith = app
    app.registerActivityLifecycleCallbacks(this)
  }

  /**
   * Reads the Activity that existed before the callbacks were registered (the module loads about 1.8 s after a cold start,
   * usually after `MainActivity` resumed). A no-op once an observed event has registered the state.
   */
  fun catchUp(current: Activity?) {
    val alive = current != null && roleOf(current) == Role.MAIN && !current.isFinishing && !current.isDestroyed
    val resumed =
      alive && ((current as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true)
    state.catchUp(alive, resumed)
    publish()
  }

  private fun publish() {
    val next = state.snapshot()
    if (next == snapshot) return
    snapshot = next
    onChange(next)
  }

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
    state.onCreated(roleOf(activity))
    publish()
  }

  override fun onActivityResumed(activity: Activity) {
    state.onResumed(roleOf(activity))
    publish()
  }

  override fun onActivityPaused(activity: Activity) {
    val role = roleOf(activity)
    if (role == Role.MAIN) BridgeState.mainPausedAtMs = SystemClock.uptimeMillis()
    state.onPaused(role)
    publish()
  }

  override fun onActivityDestroyed(activity: Activity) {
    val role = roleOf(activity)
    state.onDestroyed(role)
    if (role == Role.MAIN) BridgeState.raisedByBridge = false
    publish()
  }

  override fun onActivityStarted(activity: Activity) {}

  override fun onActivityStopped(activity: Activity) {}

  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

  companion object {
    fun roleOf(a: Activity): Role {
      val name = a.javaClass.name
      return when {
        name == NotificationSpec.TARGET_CLASS -> Role.SHEET
        name.endsWith(".MainActivity") -> Role.MAIN
        else -> Role.OTHER
      }
    }
  }
}
