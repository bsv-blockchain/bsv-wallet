package org.bsv.walletbridge

/**
 * Launch URI gate (spec 6.3, 7.5). Pure JVM. The trampoline calls [validate] before storing a URI; it checks scheme, host
 * and size only and never parses `e`, `k` or `n` (JS does, in `launchRegistry.ts`).
 */
object LaunchIntent {
  const val HOST = "launch"
  const val MAX_BYTES = 512

  /** Returns [uri] unchanged when it is `<scheme>://launch` (optionally followed by `?`, `#` or `/`) and at most 512 UTF-8 bytes; else null. */
  fun validate(uri: String?, scheme: String): String? {
    if (uri == null) return null
    if (uri.toByteArray(Charsets.UTF_8).size > MAX_BYTES) return null
    val prefix = "$scheme://$HOST"
    if (!uri.regionMatches(0, prefix, 0, prefix.length, ignoreCase = true)) return null
    if (uri.length == prefix.length) return uri
    return if (uri[prefix.length] == '?' || uri[prefix.length] == '#' || uri[prefix.length] == '/') uri else null
  }
}

/**
 * Trampoline restart limiter (spec 6.3): the next component is started at most once per [windowMs]. The window runs from
 * the last allowed start, not from the last attempt. Storing a launch record never depends on this.
 */
class StartThrottle(private val clock: () -> Long, private val windowMs: Long = 3000) {
  private var last: Long? = null

  @Synchronized
  fun shouldStart(): Boolean {
    val now = clock()
    val l = last
    if (l != null && now - l < windowMs) return false
    last = now
    return true
  }
}
