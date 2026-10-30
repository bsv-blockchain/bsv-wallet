package org.bsv.walletbridge

import java.io.IOException
import java.io.InputStream
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * Strict HTTP/1.1 request reader for the loopback server (spec 6.2). Pure JVM.
 *
 * One request per connection: the head is read byte by byte so nothing past it is consumed, the body is read to exactly
 * `Content-Length`, and any byte left after the request is a protocol violation. Receive deadlines (head, body) are
 * measured with the injected [clock] and apply only while receiving; once [readRequest] returns they no longer exist.
 * Only verbs and framing are policed here; paths, per-path 405 and 404 belong to the router.
 */
class HttpParser(private val limits: Limits = Limits.DEFAULT, private val clock: () -> Long) {
  data class Limits(
    val requestLineMax: Int = 2048,
    val maxHeaderLines: Int = 64,
    val maxHeadBytes: Int = 16384,
    val maxBodyBytes: Long = 5_242_880L,
    val headTimeoutMs: Long = 10_000L,
    val bodyTimeoutMs: Long = 30_000L
  ) {
    companion object {
      val DEFAULT = Limits()
    }
  }

  sealed class ParseResult {
    /** [headers] are `[lowercasedName, value]` in arrival order, with Accept, Accept-Encoding and User-Agent dropped. */
    class Ok(
      val method: String,
      val target: String,
      val headers: List<Pair<String, String>>,
      val body: ByteArray
    ) : ParseResult()

    /** [closeSilently] means do not answer: the peer is gone or sent nothing usable. */
    class Reject(val status: Int, val reason: String, val closeSilently: Boolean = false) : ParseResult()
  }

  private class Stop(val result: ParseResult.Reject) : Exception(null, null, false, false)

  private fun fail(status: Int, reason: String, silent: Boolean = false): Nothing =
    throw Stop(ParseResult.Reject(status, reason, silent))

  private val methods = setOf("GET", "POST", "DELETE", "OPTIONS")
  private val dropped = setOf("accept", "accept-encoding", "user-agent")
  private val tokenChars = "!#$%&'*+-.^_`|~"

  private fun isToken(s: String): Boolean {
    if (s.isEmpty()) return false
    for (c in s) {
      val ok = (c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9') || tokenChars.indexOf(c) >= 0
      if (!ok) return false
    }
    return true
  }

  fun readRequest(input: InputStream): ParseResult {
    return try {
      parse(input)
    } catch (s: Stop) {
      s.result
    } catch (e: SocketTimeoutException) {
      ParseResult.Reject(408, "receive timeout", true)
    } catch (e: IOException) {
      ParseResult.Reject(400, "io", true)
    }
  }

  private class Head(val startMs: Long) {
    var bytes = 0
  }

  private fun parse(input: InputStream): ParseResult {
    val head = Head(clock())
    val requestLine = readLine(input, head, limits.requestLineMax, true)
    if (requestLine == null) fail(400, "empty", true)
    val parts = requestLine.split(' ')
    if (parts.size != 3 || parts.any { it.isEmpty() }) fail(400, "request line")
    val method = parts[0]
    val target = parts[1]
    val version = parts[2]
    if (!isToken(method)) fail(400, "method")
    if (version != "HTTP/1.1" && version != "HTTP/1.0") {
      if (version.startsWith("HTTP/")) fail(505, "version") else fail(400, "version")
    }
    if (!methods.contains(method)) fail(405, "method not allowed")
    if (!target.startsWith("/")) fail(400, "target form")
    for (c in target) if (c.code <= 0x20 || c.code >= 0x7f) fail(400, "target characters")

    val raw = ArrayList<Pair<String, String>>()
    while (true) {
      val line = readLine(input, head, Int.MAX_VALUE, false) ?: break
      if (raw.size >= limits.maxHeaderLines) fail(431, "too many header lines")
      if (line[0] == ' ' || line[0] == '\t') fail(400, "obs-fold")
      val colon = line.indexOf(':')
      if (colon <= 0) fail(400, "header line")
      val name = line.substring(0, colon)
      if (!isToken(name)) fail(400, "header name")
      val value = line.substring(colon + 1).trim(' ', '\t')
      for (c in value) if ((c.code < 0x20 && c != '\t') || c.code == 0x7f) fail(400, "header value")
      raw.add(name.lowercase() to value)
    }

    // Duplicates: Origin/Host first (403, as the router answers), then any other repeated header (400),
    // except the three whose value is irrelevant.
    val seen = HashSet<String>()
    val dup = HashSet<String>()
    for ((n, _) in raw) if (!seen.add(n)) dup.add(n)
    if (dup.contains("origin") || dup.contains("host")) fail(403, "duplicate origin or host")
    if (dup.any { !dropped.contains(it) }) fail(400, "duplicate header")

    if (raw.any { it.first == "transfer-encoding" }) fail(411, "transfer-encoding")
    if (raw.any { it.first == "expect" }) fail(417, "expect")

    val clRaw = raw.firstOrNull { it.first == "content-length" }?.second
    var contentLength = 0L
    if (clRaw != null) {
      if (clRaw.isEmpty() || clRaw.length > 10 || !clRaw.all { it in '0'..'9' }) fail(400, "content-length")
      contentLength = clRaw.toLong()
      if (contentLength > limits.maxBodyBytes) fail(413, "body too large")
    } else if (method == "POST" || method == "DELETE") {
      fail(411, "length required")
    }

    val body = ByteArray(contentLength.toInt())
    val bodyStart = clock()
    var got = 0
    while (got < body.size) {
      if (clock() - bodyStart > limits.bodyTimeoutMs) fail(408, "body timeout", true)
      val n = input.read(body, got, body.size - got)
      if (n < 0) fail(400, "body shorter than content-length")
      got += n
    }
    if (input.available() > 0) fail(400, "pipelined bytes", true)

    if (body.isNotEmpty()) {
      try {
        Charsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(body))
      } catch (e: CharacterCodingException) {
        fail(400, "body not utf-8")
      }
    }

    val headers = raw.filter { !dropped.contains(it.first) }
    return ParseResult.Ok(method, target, headers, body)
  }

  /**
   * Reads one CRLF-terminated line (without the CRLF). Returns null for the blank line that ends the head.
   * Bare LF and bare CR are rejected. [isRequestLine] selects the 414 cap; every line counts toward the head budget.
   */
  private fun readLine(input: InputStream, head: Head, max: Int, isRequestLine: Boolean): String? {
    val sb = StringBuilder()
    while (true) {
      if (clock() - head.startMs > limits.headTimeoutMs) fail(408, "head timeout", true)
      val b = input.read()
      if (b < 0) fail(400, "eof in head", sb.isEmpty() && head.bytes == 0)
      head.bytes++
      if (head.bytes > limits.maxHeadBytes) fail(431, "head too large")
      if (b == '\r'.code) {
        if (clock() - head.startMs > limits.headTimeoutMs) fail(408, "head timeout", true)
        val n = input.read()
        if (n < 0) fail(400, "eof in head")
        head.bytes++
        if (n != '\n'.code) fail(400, "bare CR")
        return if (sb.isEmpty()) {
          if (isRequestLine) fail(400, "empty request line") else null
        } else sb.toString()
      }
      if (b == '\n'.code) fail(400, "bare LF")
      if (b == 0) fail(400, "NUL")
      if (sb.length >= max) fail(if (isRequestLine) 414 else 431, "line too long")
      sb.append(b.toChar())
    }
  }
}
