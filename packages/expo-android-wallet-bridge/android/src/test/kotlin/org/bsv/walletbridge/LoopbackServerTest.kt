package org.bsv.walletbridge

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoopbackServerTest {
  private class Rec : LoopbackServer.Listener {
    val requests = CopyOnWriteArrayList<RequestEvent>()
    val gone = CopyOnWriteArrayList<String>()
    val stopped = CopyOnWriteArrayList<String>()
    val reqLatch = CountDownLatch(1)
    val goneLatch = CountDownLatch(1)

    override fun onRequest(r: RequestEvent) {
      requests.add(r)
      reqLatch.countDown()
    }

    override fun onClientGone(id: String) {
      gone.add(id)
      goneLatch.countDown()
    }

    override fun onServerStopped(reason: String) {
      stopped.add(reason)
    }
  }

  private val base = 43000 + (System.nanoTime() % 5000).toInt().let { if (it < 0) -it else it }
  private var server: LoopbackServer? = null
  private val sockets = ArrayList<Socket>()

  @After fun cleanup() {
    sockets.forEach { runCatching { it.close() } }
    server?.stop("test-cleanup")
  }

  private fun boot(rec: Rec, writeStallMs: Long = 30_000): BoundListener {
    val s = LoopbackServer(PortAllocator(base, 63), rec, writeStallMs)
    server = s
    return s.start()
  }

  private fun connect(port: Int): Socket {
    val s = Socket()
    s.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 2000)
    sockets.add(s)
    return s
  }

  private fun send(s: Socket, text: String) {
    s.getOutputStream().write(text.toByteArray(Charsets.ISO_8859_1))
    s.getOutputStream().flush()
  }

  private fun readAll(s: Socket): String {
    s.soTimeout = 5000
    val out = ByteArrayOutputStream()
    val buf = ByteArray(4096)
    while (true) {
      val n = s.getInputStream().read(buf)
      if (n < 0) break
      out.write(buf, 0, n)
    }
    return out.toString("ISO-8859-1")
  }

  private fun get(port: Int, host: String, path: String = "/x"): String =
    "GET $path HTTP/1.1\r\nHost: $host\r\nX-Foo: Bar\r\n\r\n"

  @Test fun `valid request reaches onRequest with lowercased headers`() {
    val rec = Rec()
    val b = boot(rec)
    val c = connect(b.port)
    send(c, get(b.port, "127.0.0.1:${b.port}"))
    assertTrue(rec.reqLatch.await(3, TimeUnit.SECONDS))
    val r = rec.requests[0]
    assertEquals("GET", r.method)
    assertEquals("/x", r.target)
    assertTrue(r.headers.contains("x-foo" to "Bar"))
    assertTrue(r.headers.contains("host" to "127.0.0.1:${b.port}"))
    assertTrue(server!!.respond(r.id, 200, listOf("Content-Type" to "application/json"), "{\"a\":\"é\"}"))
    val text = readAll(c)
    assertTrue(text.startsWith("HTTP/1.1 200 "))
    assertTrue(text.contains("Connection: close"))
    assertTrue(text.contains("Content-Length: 10"))
  }

  @Test fun `wrong Host never reaches onRequest and gets 403`() {
    val rec = Rec()
    val b = boot(rec)
    val c = connect(b.port)
    send(c, get(b.port, "evil.example:${b.port}"))
    val text = readAll(c)
    assertTrue(text.startsWith("HTTP/1.1 403 "))
    assertFalse(text.contains("Access-Control"))
    assertEquals(0, rec.requests.size)
  }

  @Test fun `held response stays open for 3 s with no timeout and completes on respond`() {
    val rec = Rec()
    val b = boot(rec)
    val c = connect(b.port)
    send(c, get(b.port, "127.0.0.1:${b.port}"))
    assertTrue(rec.reqLatch.await(3, TimeUnit.SECONDS))
    c.soTimeout = 3000
    var timedOut = false
    try {
      c.getInputStream().read()
    } catch (e: SocketTimeoutException) {
      timedOut = true
    }
    assertTrue("nothing written and not closed during the hold", timedOut)
    assertTrue(server!!.respond(rec.requests[0].id, 204, emptyList(), ""))
    assertTrue(readAll(c).startsWith("HTTP/1.1 204 "))
  }

  @Test fun `client close fires onClientGone and respond returns false`() {
    val rec = Rec()
    val b = boot(rec)
    val c = connect(b.port)
    send(c, get(b.port, "127.0.0.1:${b.port}"))
    assertTrue(rec.reqLatch.await(3, TimeUnit.SECONDS))
    c.close()
    assertTrue(rec.goneLatch.await(3, TimeUnit.SECONDS))
    assertEquals(rec.requests[0].id, rec.gone[0])
    assertFalse(server!!.respond(rec.requests[0].id, 200, emptyList(), ""))
  }

  @Test fun `abort closes without a response and without onClientGone`() {
    val rec = Rec()
    val b = boot(rec)
    val c = connect(b.port)
    send(c, get(b.port, "127.0.0.1:${b.port}"))
    assertTrue(rec.reqLatch.await(3, TimeUnit.SECONDS))
    server!!.abort(rec.requests[0].id)
    assertEquals("", readAll(c))
    Thread.sleep(200)
    assertEquals(0, rec.gone.size)
  }

  @Test fun `33rd connection gets 503 Retry-After 1`() {
    val rec = Rec()
    val b = boot(rec)
    repeat(32) { connect(b.port) }
    Thread.sleep(200)
    val extra = connect(b.port)
    val text = readAll(extra)
    assertTrue(text.startsWith("HTTP/1.1 503 "))
    assertTrue(text.contains("Retry-After: 1"))
  }

  @Test fun `stop closes held connections and fires onServerStopped once`() {
    val rec = Rec()
    val b = boot(rec)
    val c = connect(b.port)
    send(c, get(b.port, "127.0.0.1:${b.port}"))
    assertTrue(rec.reqLatch.await(3, TimeUnit.SECONDS))
    server!!.stop("user")
    server!!.stop("again")
    assertEquals("", readAll(c))
    assertEquals(listOf("user"), rec.stopped.toList())
    assertEquals(0, rec.gone.size)
  }

  @Test fun `no listener remains after stop and rebind succeeds immediately`() {
    val rec = Rec()
    val b = boot(rec)
    val port = b.port
    server!!.stop("x")
    var refused = false
    try {
      Socket().use { it.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 500) }
    } catch (e: java.io.IOException) {
      refused = true
    }
    assertTrue(refused)
    val again = server!!.start()
    assertEquals(port, again.port)
  }

  @Test fun `write stall closes the connection`() {
    val rec = Rec()
    val b = boot(rec, writeStallMs = 300)
    val c = connect(b.port)
    c.receiveBufferSize = 4096
    send(c, get(b.port, "127.0.0.1:${b.port}"))
    assertTrue(rec.reqLatch.await(3, TimeUnit.SECONDS))
    val big = "a".repeat(32 * 1024 * 1024)
    val start = System.nanoTime()
    val ok = server!!.respond(rec.requests[0].id, 200, emptyList(), big)
    val ms = (System.nanoTime() - start) / 1_000_000
    assertFalse(ok)
    assertTrue("stalled write was cut off promptly ($ms ms)", ms < 5000)
  }

  @Test fun `Timers set replaces a same-named timer, clear cancels, scheduler fires emit`() {
    class Fake : Scheduler {
      val pending = LinkedHashMap<String, () -> Unit>()

      override fun postDelayed(name: String, ms: Long, fn: () -> Unit) {
        pending[name] = fn
      }

      override fun cancel(name: String) {
        pending.remove(name)
      }
    }
    val fake = Fake()
    val fired = ArrayList<String>()
    val t = Timers(fake) { fired.add(it) }
    t.set("a", 10)
    t.set("a", 20)
    assertEquals(1, fake.pending.size)
    fake.pending["a"]!!.invoke()
    assertEquals(listOf("a"), fired)
    t.set("b", 5)
    t.clear("b")
    assertEquals(0, fake.pending.filterKeys { it == "b" }.size)
  }
}
