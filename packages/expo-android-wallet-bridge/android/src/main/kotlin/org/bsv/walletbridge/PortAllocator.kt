package org.bsv.walletbridge

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

/**
 * Loopback port allocation (spec 6.2.1). Pure JVM: no android.* imports. The bind is the allocation: for each
 * candidate port, bind 127.0.0.1 then [::1]; both families or move up (IPv6 only absent when the family is
 * unavailable). Never probe-then-bind, never a wildcard or non-loopback address.
 */
enum class BindErrorKind {
  IN_USE,
  UNAVAILABLE,
  OTHER
}

private val IN_USE_TEXT = listOf("EADDRINUSE", "Address already in use")
private val UNAVAILABLE_TEXT =
  listOf(
    "EADDRNOTAVAIL",
    "Cannot assign requested address",
    "EAFNOSUPPORT",
    "Address family not supported",
    "Protocol family unavailable"
  )

private const val ERRNO_EADDRINUSE = 98
private const val ERRNO_EADDRNOTAVAIL = 99
private const val ERRNO_EAFNOSUPPORT = 97

/** Reads `errno` from an android.system.ErrnoException without linking against it (JVM tests have no Android). */
private fun errnoOf(t: Throwable): Int? {
  val cls = t.javaClass
  if (cls.name != "android.system.ErrnoException" && cls.simpleName != "ErrnoException") return null
  return try {
    val f = runCatching { cls.getField("errno") }.getOrElse { cls.getDeclaredField("errno").also { it.isAccessible = true } }
    f.getInt(t)
  } catch (e: Exception) {
    null
  }
}

/** Walks the cause chain (cycle-safe) and classifies a bind failure. Not reliant on one message format. */
fun classifyBindError(e: Throwable): BindErrorKind {
  val seen = java.util.IdentityHashMap<Throwable, Boolean>()
  var unavailable = false
  var cur: Throwable? = e
  while (cur != null && seen.put(cur, true) == null) {
    val msg = cur.message
    if (msg != null && IN_USE_TEXT.any { msg.contains(it) }) return BindErrorKind.IN_USE
    when (errnoOf(cur)) {
      ERRNO_EADDRINUSE -> return BindErrorKind.IN_USE
      ERRNO_EADDRNOTAVAIL, ERRNO_EAFNOSUPPORT -> unavailable = true
    }
    if (msg != null && UNAVAILABLE_TEXT.any { msg.contains(it) }) unavailable = true
    cur = cur.cause
  }
  return if (unavailable) BindErrorKind.UNAVAILABLE else BindErrorKind.OTHER
}

class BoundListener(val port: Int, val v4: ServerSocket, val v6: ServerSocket?)

class PortsExhausted(val basePort: Int, val lastPort: Int) : Exception("no free loopback port in $basePort..$lastPort")

class BindFailed(val errnoText: String, cause: Throwable? = null) : Exception("bind failed: $errnoText", cause)

class PortAllocator(
  private val basePort: Int = 3321,
  private val maxOffset: Int = 63,
  private val binder: (InetAddress, Int) -> ServerSocket = ::bindLoopback
) {
  private val addr4: InetAddress = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
  private val addr6: InetAddress = InetAddress.getByAddress(ByteArray(15) + byteArrayOf(1))

  fun bind(): BoundListener {
    val last = minOf(basePort + maxOffset, 65535)
    for (p in basePort..last) {
      val s4 =
        try {
          binder(addr4, p)
        } catch (e: IOException) {
          if (classifyBindError(e) == BindErrorKind.IN_USE) continue
          throw BindFailed(describe(e), e)
        }
      try {
        return BoundListener(p, s4, binder(addr6, p))
      } catch (e: IOException) {
        when (classifyBindError(e)) {
          BindErrorKind.UNAVAILABLE -> return BoundListener(p, s4, null)
          BindErrorKind.IN_USE -> {
            // Another program owns [::1]:p. Keeping IPv4 only would let a page using `localhost` reach it.
            closeQuietly(s4)
            continue
          }
          BindErrorKind.OTHER -> {
            closeQuietly(s4)
            throw BindFailed(describe(e), e)
          }
        }
      }
    }
    throw PortsExhausted(basePort, last)
  }

  private fun describe(e: Throwable): String = e.message ?: e.javaClass.simpleName

  private fun closeQuietly(s: ServerSocket) {
    try {
      s.close()
    } catch (_: IOException) {}
  }
}

/** SO_REUSEADDR before bind: lets a restart rebind over TIME_WAIT sockets; a live listener still fails. */
private fun bindLoopback(addr: InetAddress, port: Int): ServerSocket {
  val s = ServerSocket()
  try {
    s.reuseAddress = true
    s.bind(InetSocketAddress(addr, port))
  } catch (e: IOException) {
    try {
      s.close()
    } catch (_: IOException) {}
    throw e
  }
  return s
}
