package org.bsv.walletbridge

import java.io.IOException
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** One admitted request handed to JS. [headers] are `[lowercasedName, value]` in arrival order. */
data class RequestEvent(
  val id: String,
  val method: String,
  val target: String,
  val headers: List<Pair<String, String>>,
  val body: String
)

/**
 * The loopback HTTP server (spec 6.2). Pure JVM (`java.net` only). Kotlin is a dumb pipe: bind, accept, parse, apply
 * transport caps and the Host check, hand a request to JS, hold the connection open until JS answers or the peer goes,
 * write, close. One thread per connection; one request per connection. There is no deadline on a held response
 * (BRC-219); the only timers are receive timeouts (inside the parser) and a write stall on a peer that stopped reading.
 */
class LoopbackServer(
  private val allocator: PortAllocator,
  private val listener: Listener,
  private val writeStallMs: Long = 30_000,
  private val maxConnections: Int = 32
) {
  interface Listener {
    fun onRequest(r: RequestEvent)

    fun onClientGone(id: String)

    fun onServerStopped(reason: String)
  }

  private class Conn(val id: String, val socket: Socket) {
    /** Set by whoever claims the connection first (respond, abort, stop, the watcher); makes the claim exclusive. */
    val claimed = AtomicBoolean(false)
    @Volatile var held = false
  }

  private val lock = Any()
  private val conns = ConcurrentHashMap<String, Conn>()
  private val ids = AtomicLong(0)
  private var bound: BoundListener? = null
  private var running = false
  private var stopped = AtomicBoolean(true)
  private var watchdog: ScheduledExecutorService? = null

  private val baseHeaders =
    listOf("Cache-Control" to "no-store", "Vary" to "Origin", "X-Content-Type-Options" to "nosniff")

  fun start(): BoundListener {
    synchronized(lock) {
      check(!running) { "already started" }
      val b = allocator.bind()
      bound = b
      running = true
      stopped = AtomicBoolean(false)
      watchdog =
        Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "bridge-write-watchdog").also { it.isDaemon = true } }
      acceptLoop(b.v4, b)
      b.v6?.let { acceptLoop(it, b) }
      return b
    }
  }

  fun stop(reason: String) {
    val flag: AtomicBoolean
    val toClose: List<Conn>
    synchronized(lock) {
      if (!running) return
      running = false
      flag = stopped
      val b = bound
      bound = null
      try {
        b?.v4?.close()
      } catch (_: IOException) {}
      try {
        b?.v6?.close()
      } catch (_: IOException) {}
      toClose = conns.values.toList()
      conns.clear()
      watchdog?.shutdownNow()
      watchdog = null
    }
    for (c in toClose) {
      c.claimed.set(true)
      closeQuietly(c.socket)
    }
    if (flag.compareAndSet(false, true)) listener.onServerStopped(reason)
  }

  /** Writes the response for [id]; false if the connection is gone, already answered, or the write failed. */
  fun respond(id: String, status: Int, headers: List<Pair<String, String>>, body: String): Boolean {
    val c = conns[id] ?: return false
    if (!c.held || !c.claimed.compareAndSet(false, true)) return false
    conns.remove(id)
    val bytes =
      try {
        HttpWriter.response(status, headers, body.toByteArray(Charsets.UTF_8))
      } catch (e: IllegalArgumentException) {
        HttpWriter.response(500, baseHeaders, ByteArray(0))
      }
    val ok = writeWithStallGuard(c.socket, bytes)
    closeQuietly(c.socket)
    return ok
  }

  /** Closes [id] without a response (JS asked). No onClientGone follows. */
  fun abort(id: String) {
    val c = conns[id] ?: return
    if (!c.claimed.compareAndSet(false, true)) return
    conns.remove(id)
    closeQuietly(c.socket)
  }

  private fun acceptLoop(server: ServerSocket, owner: BoundListener) {
    val t =
      Thread(
        {
          while (true) {
            val s =
              try {
                server.accept()
              } catch (e: IOException) {
                break
              }
            admit(s, owner)
          }
          // The accept loop ended: if nobody called stop(), a listener died under us.
          val dead = synchronized(lock) { running && bound === owner }
          if (dead) stop("listener-closed")
        },
        "bridge-accept-${server.localPort}"
      )
    t.isDaemon = true
    t.start()
  }

  private fun admit(s: Socket, owner: BoundListener) {
    val conn = Conn("c" + ids.incrementAndGet(), s)
    val admitted =
      synchronized(lock) {
        if (!running || bound !== owner || conns.size >= maxConnections) {
          false
        } else {
          conns[conn.id] = conn
          true
        }
      }
    if (!admitted) {
      val t =
        Thread {
          try {
            s.soTimeout = 2000
            s.getOutputStream().write(HttpWriter.response(503, baseHeaders + ("Retry-After" to "1"), ByteArray(0)))
            s.getOutputStream().flush()
          } catch (_: IOException) {} finally {
            closeQuietly(s)
          }
        }
      t.isDaemon = true
      t.start()
      return
    }
    val t = Thread({ serve(conn, owner) }, "bridge-conn-${conn.id}")
    t.isDaemon = true
    t.start()
  }

  private fun serve(c: Conn, owner: BoundListener) {
    val s = c.socket
    try {
      s.tcpNoDelay = true
      s.soTimeout = 10_000
      val parser = HttpParser(clock = { System.nanoTime() / 1_000_000 })
      when (val r = parser.readRequest(s.getInputStream())) {
        is HttpParser.ParseResult.Reject -> {
          if (!r.closeSilently && c.claimed.compareAndSet(false, true)) {
            conns.remove(c.id)
            writeWithStallGuard(s, HttpWriter.response(r.status, baseHeaders, ByteArray(0)))
          }
          release(c)
        }
        is HttpParser.ParseResult.Ok -> {
          val host = r.headers.firstOrNull { it.first == "host" }?.second
          if (!HostCheck.allowed(host, owner.port, true, owner.v6 != null)) {
            if (c.claimed.compareAndSet(false, true)) {
              conns.remove(c.id)
              writeWithStallGuard(s, HttpWriter.response(403, baseHeaders, ByteArray(0)))
            }
            release(c)
            return
          }
          // Handed off: no receive timeout applies any more, and a held response has no deadline.
          s.soTimeout = 0
          c.held = true
          listener.onRequest(RequestEvent(c.id, r.method, r.target, r.headers, String(r.body, Charsets.UTF_8)))
          watchForGone(c)
        }
      }
    } catch (e: Exception) {
      release(c)
    }
  }

  /** Blocks on the socket's input: EOF, reset or any extra byte means the peer left or broke the protocol. */
  private fun watchForGone(c: Conn) {
    try {
      c.socket.getInputStream().read()
    } catch (_: IOException) {}
    if (c.claimed.compareAndSet(false, true)) {
      conns.remove(c.id)
      closeQuietly(c.socket)
      listener.onClientGone(c.id)
    }
  }

  private fun release(c: Conn) {
    c.claimed.set(true)
    conns.remove(c.id)
    closeQuietly(c.socket)
  }

  /** Writes in chunks; each chunk must finish within [writeStallMs] or the socket is closed (peer stopped reading). */
  private fun writeWithStallGuard(s: Socket, bytes: ByteArray): Boolean {
    val wd = synchronized(lock) { watchdog } ?: return false
    return try {
      val out: OutputStream = s.getOutputStream()
      var off = 0
      while (off < bytes.size) {
        val n = minOf(16_384, bytes.size - off)
        val guard = wd.schedule({ closeQuietly(s) }, writeStallMs, TimeUnit.MILLISECONDS)
        try {
          out.write(bytes, off, n)
        } finally {
          guard.cancel(false)
        }
        off += n
      }
      out.flush()
      true
    } catch (e: Exception) {
      false
    }
  }

  private fun closeQuietly(s: Socket) {
    try {
      s.close()
    } catch (_: IOException) {}
  }
}
