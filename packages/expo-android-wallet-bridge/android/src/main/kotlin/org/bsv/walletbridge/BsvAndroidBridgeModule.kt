package org.bsv.walletbridge

import android.Manifest
import android.app.NotificationManager
import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** The single object argument of `startServer` (spec 6.2): `{ basePort, maxOffset }`. */
class StartServerOptions : Record {
  @Field var basePort: Int = 0

  @Field var maxOffset: Int = 0
}

/** The single object argument of `setHostState`: `{ attached, ready }`. */
class HostStateOptions : Record {
  @Field var attached: Boolean = false

  @Field var ready: Boolean = false
}

class PortsExhaustedException(m: String) : CodedException("ERR_PORTS_EXHAUSTED", m, null)

class BindFailedException(m: String, cause: Throwable?) : CodedException("ERR_BIND_FAILED", m, cause)

class NoActivityException : CodedException("ERR_NO_ACTIVITY", "No foreground activity", null)

/**
 * The M1 native surface (spec 6.2). Thin: every behaviour lives in [BridgeState] and the pure classes. Request bodies,
 * headers and launch URIs are never logged.
 */
class BsvAndroidBridgeModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val sink =
    object : EventSink {
      override fun emit(name: String, payload: Map<String, Any?>) {
        try {
          sendEvent(name, payload)
        } catch (_: Exception) {
          // JS runtime detached mid-event: the event is dropped, native state is unchanged.
        }
      }
    }

  override fun definition() = ModuleDefinition {
    Name("BsvAndroidBridge")

    Events("onRequest", "onClientGone", "onServerStopped", "onLaunch", "onTimer", "onHostLifecycle")

    OnCreate {
      BridgeState.sink = sink
      // Registration is idempotent (a reload runs OnCreate again). The catch-up covers the Activity that already existed.
      (appContext.reactContext?.applicationContext as? Application)?.let { BridgeState.tracker.register(it) }
      BridgeState.tracker.catchUp(appContext.currentActivity)
    }

    OnDestroy {
      if (BridgeState.sink === sink) BridgeState.sink = null
    }

    AsyncFunction("startServer") { o: StartServerOptions ->
      try {
        val b = BridgeState.startServer(o.basePort, o.maxOffset)
        mapOf("port" to b.port, "ipv4" to true, "ipv6" to (b.v6 != null))
      } catch (e: PortsExhausted) {
        throw PortsExhaustedException(e.message ?: "no free port")
      } catch (e: BindFailed) {
        throw BindFailedException(e.message ?: "bind failed", e)
      } catch (e: Exception) {
        throw BindFailedException(e.message ?: "bind failed", e)
      }
    }

    AsyncFunction("stopServer") { BridgeState.stopServer("stopped") }

    AsyncFunction("respond") { id: String, status: Int, headers: List<List<String>>, body: String ->
      BridgeState.respond(id, status, headers.map { it[0] to it[1] }, body)
    }

    Function("abortConnection") { id: String -> BridgeState.abort(id) }

    Function("takeLaunches") {
      BridgeState.launchStore.take().map { mapOf("seq" to it.seq, "uri" to it.uri, "ageMs" to it.ageMs) }
    }

    Function("elapsedRealtime") { SystemClock.elapsedRealtime().toDouble() }

    Function("setTimer") { name: String, ms: Double -> BridgeState.timers.set(name, ms.toLong()) }

    Function("clearTimer") { name: String -> BridgeState.timers.clear(name) }

    AsyncFunction("ensureService") {
      val ctx = context
      try {
        AttentionPoster.ensureChannels(ctx)
        // startForegroundService is API 26; minSdk is 24.
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(BridgeService.intent(ctx))
        else ctx.startService(BridgeService.intent(ctx))
        true
      } catch (e: Exception) {
        // ForegroundServiceStartNotAllowedException and friends: the controller opens no port and stays IDLE.
        false
      }
    }

    Function("setSession") { sites: Int, waiting: Int ->
      BridgeState.sites = sites
      BridgeState.waiting = waiting
      if (BridgeService.running) AttentionPoster.updateSession(context, sites, waiting)
    }

    Function("stopSession") {
      val ctx = context
      BridgeState.sites = 0
      BridgeState.waiting = 0
      ctx.stopService(BridgeService.intent(ctx))
      AttentionPoster.cancelSession(ctx)
    }

    Function("postAttention") { _: String -> AttentionPoster.postAttention(context) }

    Function("cancelAttention") { AttentionPoster.cancelAttention(context) }

    Function("notificationPermission") { notificationPermission(context) }

    AsyncFunction("requestNotificationPermission") { promise: Promise ->
      val ctx = context
      if (notificationPermission(ctx) == "granted") return@AsyncFunction promise.resolve("granted")
      if (Build.VERSION.SDK_INT < 33) return@AsyncFunction promise.resolve("denied")
      if (appContext.currentActivity == null) throw NoActivityException()
      val perms = appContext.permissions ?: throw NoActivityException()
      prefs(ctx).edit().putBoolean(KEY_ASKED, true).apply()
      perms.askForPermissions({ result ->
        val r = result[Manifest.permission.POST_NOTIFICATIONS]
        promise.resolve(if (r?.status == PermissionsStatus.GRANTED) "granted" else "denied")
      }, Manifest.permission.POST_NOTIFICATIONS)
    }

    Function("setHostState") { s: HostStateOptions ->
      BridgeState.hostAttached = s.attached
      BridgeState.hostReady = s.ready
    }

    Function("hostLifecycle") {
      val l = BridgeState.tracker.snapshot
      mapOf(
        "registered" to l.registered,
        "mainAlive" to l.mainAlive,
        "mainResumed" to l.mainResumed,
        "sheetResumed" to l.sheetResumed
      )
    }

    // Body in Task 7 (window flags); declared now so the JS surface is stable.
    Function("setSheetInteractive") { _: Boolean -> }

    // Only the owner-decision variant (11-W) gives showSheet a body.
    Function("showSheet") { _: String -> }

    Function("hideSheet") { BridgeState.finishSheet() }

    // moveTaskToBack of the foreground activity, only when the bridge raised it (the wallet was not already open).
    Function("returnToBrowser") {
      val activity = appContext.currentActivity ?: throw NoActivityException()
      if (BridgeState.raisedByBridge) {
        BridgeState.raisedByBridge = false
        activity.runOnUiThread { activity.moveTaskToBack(true) }
      }
    }
  }

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun notificationPermission(ctx: Context): String {
    if (Build.VERSION.SDK_INT < 33) {
      val nm = ctx.getSystemService(NotificationManager::class.java)
      return if (nm?.areNotificationsEnabled() == true) "granted" else "denied"
    }
    if (ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
      return "granted"
    }
    return if (prefs(ctx).getBoolean(KEY_ASKED, false)) "denied" else "undetermined"
  }

  companion object {
    private const val PREFS = "bsv_android_bridge"
    private const val KEY_ASKED = "notification_permission_asked"
  }
}
