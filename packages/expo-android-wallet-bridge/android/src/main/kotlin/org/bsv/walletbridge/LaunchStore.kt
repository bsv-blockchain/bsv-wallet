package org.bsv.walletbridge

/**
 * Process-memory store of trampoline launch URIs (spec 6.3, 7.5). Pure JVM. Expiry and deletion are Kotlin's: entries
 * older than [ttlMs] are dropped on [put] and [take], and [take] is atomic and destructive. The URI holds secrets: it is
 * never logged and never leaves this object except through [take].
 */
class LaunchStore(private val clock: () -> Long, private val capacity: Int = 32, private val ttlMs: Long = 120_000) {
  data class Taken(val seq: Long, val uri: String, val ageMs: Long)

  private class Entry(val seq: Long, val uri: String, val createdAt: Long)

  private val entries = ArrayDeque<Entry>()
  private var nextSeq = 1L

  @Synchronized
  fun put(uri: String): Long {
    val now = clock()
    dropExpired(now)
    while (entries.size >= capacity) entries.removeFirst()
    val seq = nextSeq++
    entries.addLast(Entry(seq, uri, now))
    return seq
  }

  @Synchronized
  fun take(): List<Taken> {
    val now = clock()
    dropExpired(now)
    val out = entries.map { Taken(it.seq, it.uri, now - it.createdAt) }
    entries.clear()
    return out
  }

  @Synchronized
  fun size(): Int {
    dropExpired(clock())
    return entries.size
  }

  private fun dropExpired(now: Long) {
    entries.removeAll { now - it.createdAt > ttlMs }
  }

  override fun toString(): String = "LaunchStore(size=${entries.size})"
}
