package org.bsv.walletbridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpWriterTest {
  private fun split(bytes: ByteArray): Pair<String, ByteArray> {
    val s = String(bytes, Charsets.ISO_8859_1)
    val i = s.indexOf("\r\n\r\n")
    assertTrue(i > 0)
    return s.substring(0, i) to bytes.copyOfRange(i + 4, bytes.size)
  }

  @Test fun `always Connection close and exact Content-Length`() {
    val body = "héllo".toByteArray(Charsets.UTF_8)
    val (head, b) = split(HttpWriter.response(200, listOf("Content-Type" to "application/json"), body))
    val lines = head.split("\r\n")
    assertEquals("HTTP/1.1 200 OK", lines[0])
    assertTrue(lines.contains("Connection: close"))
    assertTrue(lines.contains("Content-Length: ${body.size}"))
    assertTrue(lines.contains("Content-Type: application/json"))
    assertEquals(body.toList(), b.toList())
  }

  @Test fun `empty body has Content-Length 0`() {
    val (head, b) = split(HttpWriter.response(403, emptyList(), ByteArray(0)))
    assertTrue(head.startsWith("HTTP/1.1 403 Forbidden"))
    assertTrue(head.contains("Content-Length: 0"))
    assertEquals(0, b.size)
  }

  @Test fun `no Server or Date`() {
    val (head, _) = split(
      HttpWriter.response(200, listOf("Server" to "x", "date" to "y", "Connection" to "keep-alive", "Content-Length" to "99"), ByteArray(2))
    )
    val lower = head.lowercase()
    assertFalse(lower.contains("\r\nserver:"))
    assertFalse(lower.contains("\r\ndate:"))
    assertFalse(lower.contains("keep-alive"))
    assertFalse(lower.contains("content-length: 99"))
    assertTrue(head.contains("Content-Length: 2"))
    assertEquals(1, Regex("(?i)connection:").findAll(head).count())
  }

  @Test fun `503 carries Retry-After`() {
    val (head, _) = split(HttpWriter.response(503, listOf("Retry-After" to "1"), ByteArray(0)))
    assertTrue(head.startsWith("HTTP/1.1 503 Service Unavailable"))
    assertTrue(head.contains("Retry-After: 1"))
  }

  @Test fun `header injection is refused`() {
    var threw = false
    try {
      HttpWriter.response(200, listOf("X-A" to "a\r\nSet-Cookie: z"), ByteArray(0))
    } catch (e: IllegalArgumentException) {
      threw = true
    }
    assertTrue(threw)
  }

  @Test fun `header order is preserved`() {
    val (head, _) = split(HttpWriter.response(200, listOf("A" to "1", "B" to "2", "C" to "3"), ByteArray(0)))
    val lines = head.split("\r\n")
    assertEquals(listOf("A: 1", "B: 2", "C: 3"), lines.subList(1, 4))
  }
}
