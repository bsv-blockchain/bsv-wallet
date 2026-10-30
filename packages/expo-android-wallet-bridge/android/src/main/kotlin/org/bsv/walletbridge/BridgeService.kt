package org.bsv.walletbridge

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/**
 * Foreground service (spec 6.10): holds the notification and the foreground priority so the process stays alive while
 * Chrome is in front. It owns no sockets (the server is process-wide, started and stopped by JS). `START_NOT_STICKY`, no
 * boot receiver, never started from the background (JS calls `ensureService()` after accepting a launch).
 */
class BridgeService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val selfStop = Runnable { if (!BridgeState.serverRunning) shutDown() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == AttentionPoster.ACTION_DISCONNECT) {
      // Same native stop as `stopServer`; emits onServerStopped {reason:'user-disconnect'} to JS when the module is alive.
      BridgeState.stopServer("user-disconnect")
      shutDown()
      return START_NOT_STICKY
    }
    try {
      val n = AttentionPoster.buildSession(this, BridgeState.sites, BridgeState.waiting)
      if (Build.VERSION.SDK_INT >= 34) {
        startForeground(AttentionPoster.SESSION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(AttentionPoster.SESSION_ID, n)
      }
      running = true
    } catch (e: Exception) {
      // Android refused the foreground state: do not linger as a plain background service.
      running = false
      stopSelf()
      return START_NOT_STICKY
    }
    // Kotlin Handler timer (not JS): no server within 60 s of the service starting means stop.
    handler.removeCallbacks(selfStop)
    handler.postDelayed(selfStop, NO_SERVER_STOP_MS)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(selfStop)
    running = false
    super.onDestroy()
  }

  private fun shutDown() {
    handler.removeCallbacks(selfStop)
    AttentionPoster.cancelSession(this)
    stopForeground(STOP_FOREGROUND_REMOVE)
    running = false
    stopSelf()
  }

  companion object {
    const val NO_SERVER_STOP_MS = 60_000L

    @Volatile var running = false

    fun intent(ctx: Context): Intent = Intent(ctx, BridgeService::class.java)
  }
}
