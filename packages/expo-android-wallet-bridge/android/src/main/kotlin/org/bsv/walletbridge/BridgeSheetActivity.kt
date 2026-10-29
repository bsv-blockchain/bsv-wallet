package org.bsv.walletbridge

import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicInteger

/**
 * The overlay sheet over Chrome (spec 6.3, 7.4): a translucent `ReactActivity` that renders the second React root
 * (`BsvBridgeSheet`) of the host's one React host. Its own task (`taskAffinity`), `singleTask`, not exported.
 *
 * What makes it safe next to `MainActivity` (every point measured in spike S4):
 *  - the guarded delegate: `onDestroy` with `MainActivity` alive only stops this sheet's own root (`unloadApp`); the default
 *    delegate would call `onHostDestroy` and tear down the host `MainActivity` still uses;
 *  - Back is native `finish()`, never `super` and never JS (a JS `BackHandler` listener must not see the sheet's Back);
 *  - the Home rule: a leave hint marks the sheet left and `onStop` with the mark finishes it, a screen-off stop does not;
 *  - launches: a new sequence number resets the root; a stale or absent one does not; a restored instance finishes and
 *    arms nothing (no `LaunchStore`, no server, no notification).
 *
 * Mode is decided BEFORE `super.onCreate` (the notification tap always targets this Activity): `OVERLAY` shows the sheet;
 * `FOREGROUND` forwards to `MainActivity` and finishes. A skipped branch still calls `super.onCreate` (the platform throws
 * `SuperNotCalledException` otherwise) but on an inert delegate: it loads no React root and touches no React host, so the
 * wallet never sees this Activity. That is the closest equivalent to "never reaching the root load".
 */
class BridgeSheetActivity : ReactActivity() {
  private var shownSeq: Long? = null
  private val leave = LeaveMark()
  private var mountCount = 0
  private var backCallback: Any? = null

  private val sheetDelegate: SheetDelegate
    get() = reactActivityDelegate as SheetDelegate

  override fun getMainComponentName(): String = "BsvBridgeSheet"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    SheetDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    val action =
      SheetPolicy.onCreateAction(
        savedInstanceState != null,
        BridgeState.hostAttached,
        BridgeState.hostReady,
        BridgeState.life.snapshot()
      )
    if (action != CreateAction.SHOW) {
      sheetDelegate.inert = true
      if (action == CreateAction.FORWARD_TO_MAIN) forwardToMain()
      finish()
      super.onCreate(null)
      return
    }
    shownSeq = seqOf(intent)
    super.onCreate(null)
    mountCount++
    BridgeState.sheet = WeakReference(this)
    registerBackCallback()
    Log.i(TAG, "sheet-activity create n=${creates.incrementAndGet()} seq=${shownSeq?.toString() ?: "none"}")
  }

  /** Foreground mode: the wallet comes to the front with nothing but the launch intent. `raisedByBridge` stays false. */
  private fun forwardToMain() {
    val next = packageManager.getLaunchIntentForPackage(packageName) ?: return
    next.data = null
    next.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      startActivity(next)
    } catch (_: Exception) {}
  }

  override fun onResume() {
    // Two resumed windows would leave an invisible translucent sheet swallowing touches: step aside.
    val forward = !sheetDelegate.inert && SheetPolicy.onResumeAction(BridgeState.life.snapshot()) == ResumeAction.FORWARD_TO_MAIN
    if (forward) sheetDelegate.skipHostLifecycle = true
    super.onResume()
    leave.onResume()
    if (forward) {
      forwardToMain()
      finish()
    }
  }

  override fun onUserLeaveHint() {
    leave.onUserLeaveHint()
    super.onUserLeaveHint()
  }

  override fun onStop() {
    super.onStop()
    if (leave.shouldFinishOnStop()) finish()
  }

  /** Reads the sequence number from the intent it is given (never from `getIntent()` after a replace). */
  private fun seqOf(i: Intent?): Long? {
    val v = i?.getLongExtra(LaunchTrampolineActivity.EXTRA_SEQ, -1L) ?: -1L
    return if (v < 0) null else v
  }

  override fun onNewIntent(intent: Intent) {
    val incoming = seqOf(intent)
    setIntent(Intent())
    leave.onNewIntent()
    var reset = false
    if (!sheetDelegate.inert && SheetPolicy.shouldResetRoot(shownSeq, incoming)) {
      reset = true
      sheetDelegate.resetRoot()
      mountCount++
      if (incoming != null) shownSeq = incoming
    }
    Log.i(TAG, "sheet-activity newintent reset=$reset")
    super.onNewIntent(intent)
  }

  // Back is native finish(): never super (it would reach the default back stack handling and JS), never JS.
  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    finish()
  }

  private fun registerBackCallback() {
    if (Build.VERSION.SDK_INT < 33) return
    val cb = OnBackInvokedCallback { finish() }
    backCallback = cb
    onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb)
  }

  override fun onDestroy() {
    if (Build.VERSION.SDK_INT >= 33) {
      (backCallback as? OnBackInvokedCallback)?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
    }
    backCallback = null
    super.onDestroy() // ReactActivity.onDestroy -> the guarded delegate decides what reaches the React host
  }

  /**
   * Default delegate plus the S4 destroy guard. `inert` (a forwarded or restored instance) loads and touches nothing;
   * `skipHostLifecycle` keeps a sheet that is stepping aside from becoming the React host's current activity.
   */
  class SheetDelegate(private val sheet: BridgeSheetActivity, name: String, fabric: Boolean) :
    DefaultReactActivityDelegate(sheet, name, fabric) {
    @Volatile var inert = false
    @Volatile var skipHostLifecycle = false

    override fun onCreate(savedInstanceState: Bundle?) {
      if (inert) return
      super.onCreate(savedInstanceState)
    }

    override fun onResume() {
      if (inert || skipHostLifecycle) return
      super.onResume()
    }

    override fun onPause() {
      if (inert || skipHostLifecycle) return
      super.onPause()
    }

    override fun onUserLeaveHint() {
      if (inert) return
      super.onUserLeaveHint()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
      if (inert) return
      super.onWindowFocusChanged(hasFocus)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
      if (inert) return
      super.onConfigurationChanged(newConfig)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = !inert && super.onKeyDown(keyCode, event)

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean = !inert && super.onKeyUp(keyCode, event)

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent): Boolean = !inert && super.onKeyLongPress(keyCode, event)

    override fun onNewIntent(intent: Intent?): Boolean = !inert && super.onNewIntent(intent)

    override fun onDestroy() {
      if (inert) return
      val d = DestroyGuard.decide(BridgeState.life.mainAlive(), BridgeState.sheet?.get() === sheet)
      when (d.action) {
        DestroyAction.UNLOAD_ONLY -> reactDelegate?.unloadApp()
        DestroyAction.SUPER -> super.onDestroy()
      }
      if (d.clearCurrentSheetRef) BridgeState.sheet = null
    }

    /** A new launch: stop this sheet's root and start a fresh one (the pending prompt lives in JS and is untouched). */
    fun resetRoot() {
      reactDelegate?.unloadApp()
      loadApp(mainComponentName)
    }
  }

  companion object {
    private const val TAG = "BsvBridgeSheet"
    private val creates = AtomicInteger(0)
  }
}
