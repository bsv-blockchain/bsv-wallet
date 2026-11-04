package org.bsv.walletbridge

/** Shared native reservation for body arrays belonging to incomplete requests. */
class ReceiveByteBudget(private val limit: Long) {
  private var used = 0L
  @Synchronized fun reserve(bytes: Long): Boolean {
    if (bytes < 0 || bytes > limit - used) return false
    used += bytes
    return true
  }
  @Synchronized fun release(bytes: Long) { used -= bytes }
  @Synchronized fun usedBytes(): Long = used
}
