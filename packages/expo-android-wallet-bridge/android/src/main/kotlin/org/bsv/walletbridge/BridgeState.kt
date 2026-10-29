package org.bsv.walletbridge

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.lang.ref.WeakReference

/** Receives events from process-wide components (server, timers, trampoline) and forwards them to JS while the module lives. */
interface EventSink {
  fun emit(name: String, payload: Map<String, Any?>)
}

/**
 * Process-wide bridge state (spec 6.2, 6.3, 6.10). The server, the launch store and the timers are singletons of the
 * process, not of the Expo module, so a launch stored by the trampoline, a Handler timer, or the service's Disconnect
 * action works while no module instance (no JS runtime) is alive. Nothing here is logged: the launch store holds secrets.
 */
object BridgeState {
  /** Set by the trampoline when it starts the main component; cleared by `returnToBrowser` and when MainActivity is destroyed. */
  @Volatile var raisedByBridge = false

  @Volatile var sink: EventSink? = null

  /** Mirrored from JS (`setHostState`): the toolbox bridge host is attached and ready. */
  @Volatile var hostAttached = false
  @Volatile var hostReady = false

  /** The live sheet Activity, set and cleared by `BridgeSheetActivity` (never strong: a destroyed sheet must not leak). */
  @Volatile var sheet: WeakReference<Activity>? = null

  /** Single owner of the lifecycle model; the tracker is its only writer. Events go to JS through [sink]. */
  val life = LifecycleState()
  val tracker = LifecycleTracker(life) { l ->
    sink?.emit(
      "onHostLifecycle",
      mapOf(
        "registered" to l.registered,
        "mainAlive" to l.mainAlive,
        "mainResumed" to l.mainResumed,
        "sheetResumed" to l.sheetResumed
      )
    )
  }

  /** The only way to end the live sheet: posts `finish()` to the main thread; a no-op without a live sheet. */
  fun finishSheet() {
    val a = sheet?.get() ?: return
    if (a.isFinishing) return
    Handler(Looper.getMainLooper()).post { if (!a.isFinishing) a.finish() }
  }

  @Volatile var serverRunning = false

  /** Notification counts last given to `setSession` (counts only, never a site). */
  @Volatile var sites = 0
  @Volatile var waiting = 0

  private val clock: () -> Long = { SystemClock.elapsedRealtime() }

  val launchStore = LaunchStore(clock)
  val startThrottle = StartThrottle(clock)

  private val lock = Any()
  private var server: LoopbackServer? = null
  private var generation = 0L

  /** Starts a new server, replacing (silently) any earlier one left by a previous JS runtime. */
  fun startServer(basePort: Int, maxOffset: Int): BoundListener {
    synchronized(lock) {
      val old = server
      val myGen = ++generation // events from the replaced server are dropped by generation
      server = null
      old?.stop("stopped")
      val listener =
        object : LoopbackServer.Listener {
          override fun onRequest(r: RequestEvent) {
            if (generation != myGen) return
            sink?.emit(
              "onRequest",
              mapOf(
                "id" to r.id,
                "method" to r.method,
                "target" to r.target,
                "headers" to r.headers.map { listOf(it.first, it.second) },
                "body" to r.body
              )
            )
          }

          override fun onClientGone(id: String) {
            if (generation != myGen) return
            sink?.emit("onClientGone", mapOf("id" to id))
          }

          override fun onServerStopped(reason: String) {
            if (generation != myGen) return
            serverRunning = false
            sink?.emit("onServerStopped", mapOf("reason" to reason))
          }
        }
      val s = LoopbackServer(PortAllocator(basePort, maxOffset), listener)
      val bound = s.start()
      server = s
      serverRunning = true
      return bound
    }
  }

  /** `reason` is 'stopped' (JS asked), 'user-disconnect' (notification action) or 'error'. */
  fun stopServer(reason: String) {
    val s = synchronized(lock) { server.also { server = null } }
    s?.stop(reason)
    serverRunning = false
  }

  fun respond(id: String, status: Int, headers: List<Pair<String, String>>, body: String): Boolean =
    synchronized(lock) { server }?.respond(id, status, headers, body) ?: false

  fun abort(id: String) {
    synchronized(lock) { server }?.abort(id)
  }

  /** Named deadline timers on the main-thread Handler: they fire with no ReactActivity resumed. */
  val timers = Timers(HandlerScheduler()) { name -> sink?.emit("onTimer", mapOf("name" to name)) }
}

private class HandlerScheduler : Scheduler {
  private val handler = Handler(Looper.getMainLooper())
  private val tasks = HashMap<String, Runnable>()

  override fun postDelayed(name: String, ms: Long, fn: () -> Unit) {
    val r =
      Runnable {
        synchronized(tasks) { tasks.remove(name) }
        fn()
      }
    synchronized(tasks) { tasks[name] = r }
    handler.postDelayed(r, ms)
  }

  override fun cancel(name: String) {
    val r = synchronized(tasks) { tasks.remove(name) } ?: return
    handler.removeCallbacks(r)
  }
}
