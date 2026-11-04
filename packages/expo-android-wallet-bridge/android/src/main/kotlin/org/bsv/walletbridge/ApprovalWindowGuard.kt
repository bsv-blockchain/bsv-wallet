package org.bsv.walletbridge

import android.app.Activity
import android.os.Build
import android.view.MotionEvent
import android.view.Window

/** Native protection follows the approval when its presentation moves between activities. */
internal class ApprovalWindowGuard(private val wrapped: Window.Callback) : Window.Callback by wrapped {
  private val touches = TouchGuard()

  override fun dispatchTouchEvent(event: MotionEvent): Boolean =
    touches.dispatch(event.flags) { wrapped.dispatchTouchEvent(event) }

  companion object {
    /** Main-thread only. Reinstall after resume if the host replaced its Window.Callback. */
    fun install(activity: Activity) {
      val window = activity.window
      val callback = window.callback
      if (callback != null && callback !is ApprovalWindowGuard) window.callback = ApprovalWindowGuard(callback)
      if (Build.VERSION.SDK_INT >= 31) {
        try {
          window.setHideOverlayWindows(true)
        } catch (_: SecurityException) {
          // The native callback still blocks obscured input if overlay hiding is unavailable.
        }
      }
    }
  }
}
