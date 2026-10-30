package org.bsv.walletbridge

import java.io.IOException
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.SocketException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Stands in for android.system.ErrnoException: matched by class name, errno read reflectively. */
class ErrnoException(message: String, @JvmField val errno: Int) : Exception(message)

class PortAllocatorTest {
  private val v4 = InetAddress.getByName("127.0.0.1")
  private val v6 = InetAddress.getByName("::1")
  private val held = ArrayList<ServerSocket>()

  @After fun closeAll() {
    held.forEach { runCatching { it.close() } }
  }

  private fun hasV6(): Boolean =
    try {
      ServerSocket().use {
        it.reuseAddress = true
        it.bind(InetSocketAddress(v6, 0))
      }
      true
    } catch (e: IOException) {
      false
    }

  /** A base port with the next few ports free on v4, so tests do not collide with a real wallet on 3321. */
  private fun freeBase(): Int {
    repeat(50) {
      val base = ServerSocket(0).use { it.localPort }
      if (base + 70 > 65535) return@repeat
      val ok =
        (0..8).all { off ->
          try {
            ServerSocket().use { s -> s.bind(InetSocketAddress(v4, base + off)) }
            true
          } catch (e: IOException) {
            false
          }
        }
      if (ok) return base
    }
    throw IllegalStateException("no free base port")
  }

  private fun occupy(addr: InetAddress, port: Int): ServerSocket {
    val s = ServerSocket()
    s.reuseAddress = true
    s.bind(InetSocketAddress(addr, port))
    held.add(s)
    return s
  }

  @Test fun `free port binds the lowest on both families`() {
    assumeTrue(hasV6())
    val base = freeBase()
    val b = PortAllocator(base, 8).bind()
    held.add(b.v4)
    b.v6?.let { held.add(it) }
    assertEquals(base, b.port)
    assertNotNull(b.v6)
    assertEquals(base, b.v4.localPort)
    assertEquals(base, b.v6!!.localPort)
  }

  @Test fun `default base port is 3321`() {
    assumeTrue(hasV6())
    // Only meaningful when 3321 is free on this machine.
    val free =
      try {
        ServerSocket().use { it.bind(InetSocketAddress(v4, 3321)) }
        true
      } catch (e: IOException) {
        false
      }
    assumeTrue(free)
    val b = PortAllocator().bind()
    held.add(b.v4)
    b.v6?.let { held.add(it) }
    assertEquals(3321, b.port)
  }

  @Test fun `taken v4 moves up`() {
    val base = freeBase()
    occupy(v4, base)
    val b = PortAllocator(base, 8).bind()
    held.add(b.v4)
    b.v6?.let { held.add(it) }
    assertEquals(base + 1, b.port)
  }

  @Test fun `taken v6 only closes v4 and moves up`() {
    assumeTrue(hasV6())
    val base = freeBase()
    occupy(v6, base)
    val b = PortAllocator(base, 8).bind()
    held.add(b.v4)
    b.v6?.let { held.add(it) }
    assertEquals(base + 1, b.port)
    // The v4 socket on the abandoned port was closed: it can be bound again by someone else.
    ServerSocket().use {
      it.reuseAddress = true
      it.bind(InetSocketAddress(v4, base))
    }
  }

  @Test fun `no loopback v6 interface succeeds with v4 only`() {
    val base = freeBase()
    val binder: (InetAddress, Int) -> ServerSocket = { addr, port ->
      if (addr is java.net.Inet6Address) throw SocketException("Protocol family unavailable")
      ServerSocket().apply {
        reuseAddress = true
        bind(InetSocketAddress(addr, port))
      }
    }
    val b = PortAllocator(base, 8, binder).bind()
    held.add(b.v4)
    assertEquals(base, b.port)
    assertNull(b.v6)
  }

  @Test fun `other errors surface as BindFailed and never move up`() {
    val base = freeBase()
    var calls = 0
    val binder: (InetAddress, Int) -> ServerSocket = { _, _ ->
      calls++
      throw SocketException("Permission denied")
    }
    try {
      PortAllocator(base, 8, binder).bind()
      fail("expected BindFailed")
    } catch (e: BindFailed) {
      assertTrue(e.errnoText.contains("Permission denied"))
    }
    assertEquals(1, calls)
  }

  @Test fun `other v6 error closes v4 and surfaces BindFailed`() {
    val base = freeBase()
    val opened = ArrayList<ServerSocket>()
    val binder: (InetAddress, Int) -> ServerSocket = { addr, port ->
      if (addr is java.net.Inet6Address) throw SocketException("Permission denied")
      ServerSocket().apply {
        reuseAddress = true
        bind(InetSocketAddress(addr, port))
        opened.add(this)
      }
    }
    try {
      PortAllocator(base, 8, binder).bind()
      fail("expected BindFailed")
    } catch (e: BindFailed) {
      // expected
    }
    assertTrue(opened.all { it.isClosed })
  }

  @Test fun `exhaustion throws PortsExhausted`() {
    val base = freeBase()
    for (i in 0..2) occupy(v4, base + i)
    try {
      PortAllocator(base, 2).bind()
      fail("expected PortsExhausted")
    } catch (e: PortsExhausted) {
      // expected
    }
  }

  @Test fun `every bound socket is loopback`() {
    val base = freeBase()
    val b = PortAllocator(base, 8).bind()
    held.add(b.v4)
    b.v6?.let { held.add(it) }
    assertTrue(b.v4.inetAddress.isLoopbackAddress)
    b.v6?.let { assertTrue(it.inetAddress.isLoopbackAddress) }
  }

  @Test fun `serve close and rebind returns the same port`() {
    val base = freeBase()
    val a = PortAllocator(base, 8)
    val first = a.bind()
    val port = first.port
    // One served connection leaves a TIME_WAIT socket on the port once the server closes first.
    val client = java.net.Socket(v4, port)
    val server = first.v4.accept()
    server.close()
    client.close()
    first.v4.close()
    first.v6?.close()
    val second = a.bind()
    held.add(second.v4)
    second.v6?.let { held.add(it) }
    assertEquals(port, second.port)
  }

  @Test fun `a live second listener still fails`() {
    val base = freeBase()
    val first = PortAllocator(base, 8).bind()
    held.add(first.v4)
    first.v6?.let { held.add(it) }
    val second = PortAllocator(base, 8).bind()
    held.add(second.v4)
    second.v6?.let { held.add(it) }
    assertEquals(first.port + 1, second.port)
    try {
      ServerSocket().use {
        it.reuseAddress = true
        it.bind(InetSocketAddress(v4, first.port))
      }
      fail("expected the live listener to block a second bind")
    } catch (e: BindException) {
      assertEquals(BindErrorKind.IN_USE, classifyBindError(e))
    }
  }

  @Test fun `classifier - android style messages`() {
    assertEquals(BindErrorKind.IN_USE, classifyBindError(BindException("bind failed: EADDRINUSE (Address already in use)")))
    assertEquals(BindErrorKind.IN_USE, classifyBindError(SocketException("EADDRINUSE")))
    assertEquals(BindErrorKind.UNAVAILABLE, classifyBindError(BindException("bind failed: EADDRNOTAVAIL (Cannot assign requested address)")))
    assertEquals(BindErrorKind.UNAVAILABLE, classifyBindError(SocketException("socket failed: EAFNOSUPPORT (Address family not supported by protocol)")))
  }

  @Test fun `classifier - desktop style messages`() {
    assertEquals(BindErrorKind.IN_USE, classifyBindError(BindException("Address already in use")))
    assertEquals(BindErrorKind.IN_USE, classifyBindError(BindException("Address already in use (Bind failed)")))
    assertEquals(BindErrorKind.UNAVAILABLE, classifyBindError(BindException("Cannot assign requested address")))
    assertEquals(BindErrorKind.UNAVAILABLE, classifyBindError(SocketException("Address family not supported by protocol family")))
    assertEquals(BindErrorKind.UNAVAILABLE, classifyBindError(SocketException("Protocol family unavailable")))
  }

  @Test fun `classifier - other`() {
    assertEquals(BindErrorKind.OTHER, classifyBindError(SocketException("Permission denied")))
    assertEquals(BindErrorKind.OTHER, classifyBindError(RuntimeException()))
    assertEquals(BindErrorKind.OTHER, classifyBindError(IOException(null as String?)))
  }

  @Test fun `classifier - walks the cause chain`() {
    val e = RuntimeException("wrapper", IOException("mid", BindException("bind failed: EADDRINUSE (Address already in use)")))
    assertEquals(BindErrorKind.IN_USE, classifyBindError(e))
  }

  @Test fun `classifier - cyclic cause chain terminates`() {
    val a = RuntimeException("a")
    val b = RuntimeException("b", a)
    a.initCause(b)
    assertEquals(BindErrorKind.OTHER, classifyBindError(a))
  }

  @Test fun `classifier - errno cases by class name`() {
    assertEquals(BindErrorKind.IN_USE, classifyBindError(ErrnoException("bind", 98)))
    assertEquals(BindErrorKind.UNAVAILABLE, classifyBindError(ErrnoException("bind", 99)))
    assertEquals(BindErrorKind.UNAVAILABLE, classifyBindError(ErrnoException("socket", 97)))
    assertEquals(BindErrorKind.OTHER, classifyBindError(ErrnoException("bind", 13)))
    assertEquals(BindErrorKind.IN_USE, classifyBindError(SocketException("bind failed").apply { initCause(ErrnoException("bind", 98)) }))
  }
}
