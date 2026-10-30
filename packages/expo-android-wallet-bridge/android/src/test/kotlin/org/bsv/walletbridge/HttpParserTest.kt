package org.bsv.walletbridge

import java.io.ByteArrayInputStream
import java.io.InputStream
import org.bsv.walletbridge.HttpParser.ParseResult
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpParserTest {
  private fun parse(
    raw: ByteArray,
    limits: HttpParser.Limits = HttpParser.Limits.DEFAULT,
    clock: () -> Long = { 0L }
  ): ParseResult = HttpParser(limits, clock).readRequest(ByteArrayInputStream(raw))

  private fun parse(raw: String, limits: HttpParser.Limits = HttpParser.Limits.DEFAULT, clock: () -> Long = { 0L }) =
    parse(raw.toByteArray(Charsets.ISO_8859_1), limits, clock)

  private fun req(
    start: String = "GET /x HTTP/1.1",
    headers: List<String> = listOf("Host: 127.0.0.1:3321"),
    body: String = ""
  ): String = start + "\r\n" + headers.joinToString("") { it + "\r\n" } + "\r\n" + body

  private fun rejected(r: ParseResult, status: Int) {
    assertTrue("expected Reject($status) got ${r::class.simpleName}", r is ParseResult.Reject)
    assertEquals(status, (r as ParseResult.Reject).status)
  }

  private fun ok(r: ParseResult): ParseResult.Ok {
    assertTrue("expected Ok got ${(r as? ParseResult.Reject)?.let { "Reject(${it.status} ${it.reason})" }}", r is ParseResult.Ok)
    return r as ParseResult.Ok
  }

  // ---- smuggling set

  @Test fun `duplicate Origin is 403`() {
    rejected(parse(req(headers = listOf("Host: a", "Origin: x", "origin: y"))), 403)
  }

  @Test fun `duplicate Host is 403`() {
    rejected(parse(req(headers = listOf("Host: a", "HOST: b"))), 403)
  }

  @Test fun `other duplicate header is 400`() {
    rejected(parse(req(headers = listOf("Host: a", "X-Foo: 1", "x-foo: 2"))), 400)
  }

  @Test fun `duplicate Content-Length 400`() {
    rejected(parse(req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: 1", "Content-Length: 1"), "a")), 400)
  }

  @Test fun `non-numeric Content-Length 400`() {
    for (v in listOf("abc", "+1", "-1", "1 2", "", "0x10", "1.5", "99999999999")) {
      rejected(parse(req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: $v"))), 400)
    }
  }

  @Test fun `Transfer-Encoding 411`() {
    rejected(parse(req("POST /x HTTP/1.1", listOf("Host: a", "Transfer-Encoding: chunked"), "0\r\n\r\n")), 411)
  }

  @Test fun `POST or DELETE without Content-Length is 411`() {
    rejected(parse(req("POST /x HTTP/1.1")), 411)
    rejected(parse(req("DELETE /x HTTP/1.1")), 411)
    ok(parse(req("GET /x HTTP/1.1")))
    ok(parse(req("OPTIONS /x HTTP/1.1")))
  }

  @Test fun `duplicate Accept, Accept-Encoding or User-Agent is accepted and absent from the headers passed on`() {
    val r = ok(
      parse(
        req(
          headers = listOf(
            "Host: a", "Accept: a", "accept: b", "Accept-Encoding: x", "accept-encoding: y",
            "User-Agent: u1", "user-agent: u2", "Origin: https://example.com"
          )
        )
      )
    )
    assertEquals(listOf("host" to "a", "origin" to "https://example.com"), r.headers)
  }

  @Test fun `single Accept and User-Agent are also dropped`() {
    val r = ok(parse(req(headers = listOf("Host: a", "Accept: */*", "User-Agent: z"))))
    assertEquals(listOf("host" to "a"), r.headers)
  }

  @Test fun `bare LF 400`() {
    rejected(parse("GET /x HTTP/1.1\nHost: a\n\n"), 400)
    rejected(parse("GET /x HTTP/1.1\r\nHost: a\nX: 1\r\n\r\n"), 400)
  }

  @Test fun `bare CR 400`() {
    rejected(parse("GET /x HTTP/1.1\r\nHost: a\rX: 1\r\n\r\n"), 400)
  }

  @Test fun `obs-fold 400`() {
    rejected(parse(req(headers = listOf("Host: a", "X-Foo: 1", " continued"))), 400)
    rejected(parse(req(headers = listOf("Host: a", "X-Foo: 1", "\tcontinued"))), 400)
  }

  @Test fun `Expect 417`() {
    rejected(parse(req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: 1", "Expect: 100-continue"), "a")), 417)
  }

  @Test fun `header names must be tokens and lines need a colon`() {
    rejected(parse(req(headers = listOf("Host: a", "Bad Name: 1"))), 400)
    rejected(parse(req(headers = listOf("Host: a", "NoColon"))), 400)
    rejected(parse(req(headers = listOf("Host: a", ": empty"))), 400)
  }

  @Test fun `pipelined extra bytes rejected`() {
    rejected(parse(req() + "GET /y HTTP/1.1\r\n\r\n"), 400)
    rejected(parse(req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: 1"), "aGET /y HTTP/1.1\r\n\r\n")), 400)
  }

  @Test fun `HTTP 1_0 answered as 1_1`() {
    val r = ok(parse(req("GET /x HTTP/1.0")))
    assertEquals("GET", r.method)
    rejected(parse(req("GET /x HTTP/2.0")), 505)
    rejected(parse(req("GET /x FOO/1.1")), 400)
    // The reply is always 1.1.
    assertTrue(String(HttpWriter.response(200, emptyList(), ByteArray(0))).startsWith("HTTP/1.1 200"))
  }

  // ---- caps

  @Test fun `request line 2049 B 414_400`() {
    val atCap = "/" + "a".repeat(2048 - "GET  HTTP/1.1".length - 1)
    ok(parse(req("GET $atCap HTTP/1.1")))
    val over = "/" + "a".repeat(2049 - "GET  HTTP/1.1".length - 1 + 0)
    val r = parse(req("GET $over HTTP/1.1")) as ParseResult.Reject
    assertTrue(r.status == 414 || r.status == 400)
  }

  @Test fun `65 header lines`() {
    val ok64 = (1..63).map { "X-H$it: v" } + "Host: a"
    ok(parse(req(headers = ok64)))
    val over = (1..64).map { "X-H$it: v" } + "Host: a"
    rejected(parse(req(headers = over)), 431)
  }

  @Test fun `head over 16384`() {
    val big = listOf("Host: a") + (1..20).map { "X-Big$it: " + "v".repeat(1000) }
    rejected(parse(req(headers = big)), 431)
  }

  @Test fun `Content-Length over 5 MiB is 413 and the body is not read`() {
    val raw = req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: 5242881"), "abcdef")
    val stream = ByteArrayInputStream(raw.toByteArray(Charsets.ISO_8859_1))
    val r = HttpParser(clock = { 0L }).readRequest(stream)
    rejected(r, 413)
    assertEquals("body bytes untouched", 6, stream.available())
  }

  @Test fun `Content-Length exactly 5 MiB is admitted to the body read`() {
    val n = 5_242_880
    val raw = (req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: $n")) ).toByteArray() + ByteArray(n) { 'a'.code.toByte() }
    assertEquals(n, ok(parse(raw)).body.size)
  }

  // ---- targets

  @Test fun `absolute-form, asterisk, authority-form 400`() {
    rejected(parse(req("GET http://127.0.0.1:3321/x HTTP/1.1")), 400)
    rejected(parse(req("OPTIONS * HTTP/1.1")), 400)
    rejected(parse(req("GET 127.0.0.1:3321 HTTP/1.1")), 400)
  }

  @Test fun `target never percent-decoded`() {
    val r = ok(parse(req("GET /a%2e%2e/b%2Fc?q=%41 HTTP/1.1")))
    assertEquals("/a%2e%2e/b%2Fc?q=%41", r.target)
    assertEquals("/a/../b", ok(parse(req("GET /a/../b HTTP/1.1"))).target)
  }

  @Test fun `target with spaces or controls 400`() {
    rejected(parse(req("GET /a b HTTP/1.1")), 400)
    rejected(parse(req("GET /a\u0001b HTTP/1.1")), 400)
  }

  // ---- methods

  @Test fun `PUT 405`() {
    rejected(parse(req("PUT /x HTTP/1.1")), 405)
    rejected(parse(req("PATCH /x HTTP/1.1")), 405)
    rejected(parse(req("HEAD /x HTTP/1.1")), 405)
    rejected(parse(req("get /x HTTP/1.1")), 405)
  }

  // ---- body

  @Test fun `multibyte body is read by byte length`() {
    val text = "{\"a\":\"é€😀\"}"
    val bytes = text.toByteArray(Charsets.UTF_8)
    assertTrue(bytes.size > text.length)
    val raw = req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: ${bytes.size}")).toByteArray() + bytes
    val r = ok(parse(raw))
    assertArrayEquals(bytes, r.body)
    assertEquals(text, String(r.body, Charsets.UTF_8))
  }

  @Test fun `multibyte body declared by character count is a violation`() {
    val text = "é€😀"
    val bytes = text.toByteArray(Charsets.UTF_8)
    // Declared as the character count: fewer bytes are read, the rest is a pipelined leftover.
    val raw = req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: ${text.length}")).toByteArray() + bytes
    val r = parse(raw)
    assertTrue(r is ParseResult.Reject)
  }

  @Test fun `short body then EOF is 400`() {
    rejected(parse(req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: 10"), "abc")), 400)
  }

  @Test fun `longer body than declared is 400`() {
    rejected(parse(req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: 2"), "abcd")), 400)
  }

  @Test fun `non-UTF-8 body 400`() {
    val bad = byteArrayOf(0x7b, 0xc3.toByte(), 0x28, 0x7d)
    val raw = req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: ${bad.size}")).toByteArray() + bad
    rejected(parse(raw), 400)
  }

  @Test fun `empty body POST with Content-Length 0 is ok`() {
    val r = ok(parse(req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: 0"))))
    assertEquals(0, r.body.size)
  }

  // ---- timing

  @Test fun `slow-trickle head over 10 s with fake clock rejected`() {
    var now = 0L
    // 1 s of fake time per clock read: far more than 10 s before the head ends.
    val r = parse(req(), clock = { now += 1000; now })
    rejected(r, 408)
  }

  @Test fun `head inside 10 s with fake clock is accepted`() {
    val r = parse(req("GET /x HTTP/1.1", listOf("Host: a")), clock = { 0L })
    ok(r)
  }

  @Test fun `body over 30 s rejected`() {
    // The head is read with a frozen clock, then the clock jumps past the body deadline.
    val body = "abcdefghij"
    val raw = req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: ${body.length}"), body)
    var calls = 0
    val headReads = req("POST /x HTTP/1.1", listOf("Host: a", "Content-Length: ${body.length}")).length
    val parser = HttpParser(clock = { if (++calls <= headReads + 4) 0L else 31_000L })
    // Feed the body in slow 1-byte reads so the loop consults the clock between reads.
    val slow = object : InputStream() {
      private val inner = ByteArrayInputStream(raw.toByteArray())
      override fun read(): Int = inner.read()
      override fun read(b: ByteArray, off: Int, len: Int): Int = inner.read(b, off, 1)
      override fun available(): Int = inner.available()
    }
    rejected(parser.readRequest(slow), 408)
  }

  @Test fun `no timeout applies once handed off`() {
    var now = 0L
    val parser = HttpParser(clock = { now })
    val r = parser.readRequest(ByteArrayInputStream(req().toByteArray()))
    ok(r)
    now += 3_600_000L // an hour later: the parser holds no deadline for the handed-off request
    // The parser is reusable and a fresh request measures from its own start.
    ok(parser.readRequest(ByteArrayInputStream(req().toByteArray())))
  }

  @Test fun `socket read timeout maps to 408 and silent close`() {
    val stalls = object : InputStream() {
      override fun read(): Int = throw java.net.SocketTimeoutException("stalled")
    }
    val r = HttpParser(clock = { 0L }).readRequest(stalls) as ParseResult.Reject
    assertEquals(408, r.status)
    assertTrue(r.closeSilently)
  }

  @Test fun `EOF before any byte closes silently`() {
    val r = parse(ByteArray(0)) as ParseResult.Reject
    assertTrue(r.closeSilently)
  }

  @Test fun `Ok headers keep order and lowercase names`() {
    val r = ok(parse(req(headers = listOf("Host: h", "Origin: https://e.com", "BRC-185-Epoch: 5", "X-A:  spaced  "))))
    assertEquals(
      listOf("host" to "h", "origin" to "https://e.com", "brc-185-epoch" to "5", "x-a" to "spaced"),
      r.headers
    )
    assertFalse(r.headers.any { it.first.any { c -> c.isUpperCase() } })
  }
}
