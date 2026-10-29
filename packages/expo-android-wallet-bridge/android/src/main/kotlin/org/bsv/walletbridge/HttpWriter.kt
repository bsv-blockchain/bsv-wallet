package org.bsv.walletbridge

/**
 * Response serialiser (spec 6.2). Pure JVM. Always HTTP/1.1, `Connection: close` and an exact `Content-Length`; never a
 * `Server` or `Date` header. Caller-supplied `Content-Length`, `Connection`, `Server`, `Date` and
 * `Transfer-Encoding` are dropped so the framing cannot be contradicted.
 */
object HttpWriter {
  private val reserved = setOf("content-length", "connection", "server", "date", "transfer-encoding")

  private fun reason(status: Int): String =
    when (status) {
      200 -> "OK"
      204 -> "No Content"
      400 -> "Bad Request"
      403 -> "Forbidden"
      404 -> "Not Found"
      405 -> "Method Not Allowed"
      408 -> "Request Timeout"
      409 -> "Conflict"
      411 -> "Length Required"
      413 -> "Payload Too Large"
      414 -> "URI Too Long"
      417 -> "Expectation Failed"
      429 -> "Too Many Requests"
      431 -> "Request Header Fields Too Large"
      500 -> "Internal Server Error"
      503 -> "Service Unavailable"
      505 -> "HTTP Version Not Supported"
      else -> "Status"
    }

  private fun clean(s: String, what: String): String {
    for (c in s) {
      if (c == '\r' || c == '\n' || c.code > 0x7e || (c.code < 0x20 && c != '\t')) {
        throw IllegalArgumentException("invalid character in $what")
      }
    }
    return s
  }

  fun response(status: Int, headers: List<Pair<String, String>>, body: ByteArray): ByteArray {
    val head = StringBuilder()
    head.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n")
    for ((name, value) in headers) {
      if (reserved.contains(name.lowercase())) continue
      head.append(clean(name, "header name")).append(": ").append(clean(value, "header value")).append("\r\n")
    }
    head.append("Content-Length: ").append(body.size).append("\r\n")
    head.append("Connection: close\r\n\r\n")
    val h = head.toString().toByteArray(Charsets.US_ASCII)
    val out = ByteArray(h.size + body.size)
    System.arraycopy(h, 0, out, 0, h.size)
    System.arraycopy(body, 0, out, h.size, body.size)
    return out
  }
}
