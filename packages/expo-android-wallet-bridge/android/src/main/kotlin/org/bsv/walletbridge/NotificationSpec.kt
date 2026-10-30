package org.bsv.walletbridge

/**
 * Notification content (spec 6.10, 7.4). Pure JVM: plain Ints stand in for the Android constants so no `android.*` class
 * is needed here (posting is `AttentionPoster.kt`). Mapping:
 *  - importance 2 = NotificationManager.IMPORTANCE_LOW, 4 = IMPORTANCE_HIGH
 *  - visibility 0 = Notification.VISIBILITY_PRIVATE (the lock screen shows [publicText] only)
 *  - immutable true = PendingIntents use PendingIntent.FLAG_IMMUTABLE with an explicit component
 * No spec names a site: counts and generic text only.
 */
data class NotificationSpec(
  val channelId: String,
  val importance: Int,
  val visibility: Int,
  val text: String,
  val publicText: String,
  val immutable: Boolean
) {
  /** Notification tap PendingIntent shape (M2): explicit component, immutable. Values pinned against the platform constants by a test. */
  companion object {
    const val TARGET_CLASS = "org.bsv.walletbridge.BridgeSheetActivity"
    const val FLAG_IMMUTABLE = 0x04000000
    const val FLAG_UPDATE_CURRENT = 0x08000000

    fun pendingFlags(): Int = FLAG_IMMUTABLE or FLAG_UPDATE_CURRENT
  }
}

object NotificationSpecs {
  const val SESSION_CHANNEL = "bridge-session"
  const val ATTENTION_CHANNEL = "bridge-attention"
  const val IMPORTANCE_LOW = 2
  const val IMPORTANCE_HIGH = 4
  const val VISIBILITY_PRIVATE = 0
  const val PUBLIC_TEXT = "BSV Wallet"

  fun session(sites: Int, waiting: Int): NotificationSpec {
    val text =
      if (waiting > 0) "$waiting ${if (waiting == 1) "request" else "requests"} waiting. Tap to review"
      else "$sites ${if (sites == 1) "site" else "sites"} connected"
    return NotificationSpec(SESSION_CHANNEL, IMPORTANCE_LOW, VISIBILITY_PRIVATE, text, PUBLIC_TEXT, true)
  }

  fun attention(): NotificationSpec =
    NotificationSpec(
      ATTENTION_CHANNEL,
      IMPORTANCE_HIGH,
      VISIBILITY_PRIVATE,
      "A website wants to continue. Tap to review.",
      PUBLIC_TEXT,
      true
    )
}
