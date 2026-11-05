package org.bsv.walletbridge

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class ReceiveByteBudgetTest {
  private val head = "POST /x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5242880\r\n\r\n".toByteArray()

  @Test fun concurrentIncompleteBodiesShareOneBudgetAndReleaseOnDisconnect() {
    val budget = ReceiveByteBudget(5_242_880)
    val waiting = CountDownLatch(1)
    val disconnect = CountDownLatch(1)
    val stalled = object : InputStream() {
      var pos = 0
      override fun read(): Int = if (pos < head.size) head[pos++].toInt() and 255 else -1
      override fun read(b: ByteArray, off: Int, len: Int): Int {
        waiting.countDown()
        disconnect.await(3, TimeUnit.SECONDS)
        return -1
      }
    }
    val first = Thread { HttpParser(clock = { 0L }, bodyBudget = budget).readRequest(stalled) }
    first.start()
    assertTrue(waiting.await(2, TimeUnit.SECONDS))
    try {
      assertEquals(5_242_880L, budget.usedBytes())
      repeat(31) {
        val result = HttpParser(clock = { 0L }, bodyBudget = budget).readRequest(ByteArrayInputStream(head))
        assertEquals(503, (result as HttpParser.ParseResult.Reject).status)
      }
    } finally { disconnect.countDown(); first.join(3000) }
    assertEquals(0L, budget.usedBytes())
  }

  @Test fun failureAndSuccessReleaseReservation() {
    val budget = ReceiveByteBudget(32)
    val h = "POST /x HTTP/1.1\r\nContent-Length: 1\r\n\r\n".toByteArray()
    for (body in listOf(byteArrayOf(65), byteArrayOf(0xff.toByte()), byteArrayOf())) {
      HttpParser(clock = { 0L }, bodyBudget = budget).readRequest(ByteArrayInputStream(h + body))
      assertEquals(0L, budget.usedBytes())
    }
    val timeout = object : ByteArrayInputStream(h) {
      override fun read(b: ByteArray, off: Int, len: Int): Int = throw SocketTimeoutException()
    }
    assertEquals(408, (HttpParser(clock = { 0L }, bodyBudget = budget).readRequest(timeout) as HttpParser.ParseResult.Reject).status)
    assertEquals(0L, budget.usedBytes())
  }

  @Test fun inadmissibleHeadersNeverReadOrReserveBody() {
    val budget = ReceiveByteBudget(32)
    val stream = object : ByteArrayInputStream(head) {
      override fun read(b: ByteArray, off: Int, len: Int): Int = error("body read before header admission")
    }
    val parser = HttpParser(clock = { 0L }, bodyBudget = budget, admitHead = { _, _, _, _ ->
      HttpParser.ParseResult.Reject(403, "host")
    })
    assertEquals(403, (parser.readRequest(stream) as HttpParser.ParseResult.Reject).status)
    assertEquals(0L, budget.usedBytes())
  }
}
