package org.bsv.walletbridge

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/**
 * All Android notification posting (spec 6.10). Content comes from the pure [NotificationSpecs]; this file only maps the
 * spec's Ints to Android constants and builds the notifications. Not on the pure-JVM include list. No site name, no secret.
 */
object AttentionPoster {
  const val SESSION_ID = 4101
  const val ATTENTION_ID = 4102
  const val ACTION_DISCONNECT = "org.bsv.walletbridge.action.DISCONNECT"

  fun ensureChannels(ctx: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
    val session = NotificationSpecs.session(0, 0)
    val attention = NotificationSpecs.attention()
    nm.createNotificationChannel(channel(session, "Connected sites"))
    nm.createNotificationChannel(channel(attention, "Requests that need you"))
  }

  private fun channel(spec: NotificationSpec, name: String): NotificationChannel =
    NotificationChannel(spec.channelId, name, spec.importance).apply {
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      setShowBadge(false)
    }

  private fun canPost(ctx: Context): Boolean {
    val nm = ctx.getSystemService(NotificationManager::class.java) ?: return false
    if (Build.VERSION.SDK_INT >= 33 &&
      ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return false
    }
    return nm.areNotificationsEnabled()
  }

  private fun smallIcon(ctx: Context): Int =
    if (ctx.applicationInfo.icon != 0) ctx.applicationInfo.icon else android.R.drawable.ic_dialog_info

  /** Explicit-component, immutable PendingIntent to the host's main activity (never the trampoline). */
  private fun openApp(ctx: Context, requestCode: Int): PendingIntent? {
    val component = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.component ?: return null
    val i =
      Intent(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_LAUNCHER)
        setComponent(component)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      }
    return PendingIntent.getActivity(ctx, requestCode, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun disconnect(ctx: Context): PendingIntent {
    val i = Intent(ctx, BridgeService::class.java).setAction(ACTION_DISCONNECT)
    return PendingIntent.getService(ctx, 1, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun base(ctx: Context, spec: NotificationSpec): Notification.Builder {
    ensureChannels(ctx)
    val publicVersion =
      Notification.Builder(ctx, spec.channelId).setSmallIcon(smallIcon(ctx)).setContentTitle(spec.publicText).build()
    return Notification.Builder(ctx, spec.channelId)
      .setSmallIcon(smallIcon(ctx))
      .setContentTitle(spec.publicText)
      .setContentText(spec.text)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion)
      .setOnlyAlertOnce(true)
  }

  /** The foreground-service notification (channel `bridge-session`, LOW). */
  fun buildSession(ctx: Context, sites: Int, waiting: Int): Notification {
    val spec = NotificationSpecs.session(sites, waiting)
    val b = base(ctx, spec).setOngoing(true).setCategory(Notification.CATEGORY_SERVICE)
    openApp(ctx, 0)?.let { b.setContentIntent(it) }
    b.addAction(Notification.Action.Builder(null, "Disconnect", disconnect(ctx)).build())
    return b.build()
  }

  fun updateSession(ctx: Context, sites: Int, waiting: Int) {
    if (!canPost(ctx)) return
    ctx.getSystemService(NotificationManager::class.java)?.notify(SESSION_ID, buildSession(ctx, sites, waiting))
  }

  /** `kind` ('consent' | 'prompt' | 'wallet-not-ready') changes nothing visible: the text is generic by design. */
  fun postAttention(ctx: Context) {
    if (!canPost(ctx)) return
    val spec = NotificationSpecs.attention()
    val b = base(ctx, spec).setCategory(Notification.CATEGORY_MESSAGE).setAutoCancel(true)
    openApp(ctx, 2)?.let { b.setContentIntent(it) }
    ctx.getSystemService(NotificationManager::class.java)?.notify(ATTENTION_ID, b.build())
  }

  fun cancelAttention(ctx: Context) {
    ctx.getSystemService(NotificationManager::class.java)?.cancel(ATTENTION_ID)
  }

  fun cancelSession(ctx: Context) {
    ctx.getSystemService(NotificationManager::class.java)?.cancel(SESSION_ID)
  }
}
