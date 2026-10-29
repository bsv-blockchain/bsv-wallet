package org.bsv.walletbridge

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * The only exported component (spec 6.3). No React Native, no JS, no UI. `onCreate` validates the launch data (scheme,
 * host `launch`, at most 512 bytes), stores it in process memory, starts the main component WITHOUT the URI (an explicit
 * intent, only a sequence number as an extra) at most once per 3 s, then finishes. A rapid further launch still stores its
 * record. The URI holds secrets: it is never logged and never put on another intent.
 *
 * The scheme is the one the matched intent filter delivered (the config plugin owns it); the check here is on shape. A
 * caller that targets this component directly gains nothing a web page does not have: an unprovable record that JS burns.
 */
class LaunchTrampolineActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    try {
      handle(intent)
    } finally {
      finish()
    }
  }

  private fun handle(i: Intent?) {
    val data = i?.dataString ?: return
    val scheme = i.data?.scheme ?: return
    val uri = LaunchIntent.validate(data, scheme) ?: return
    val seq = BridgeState.launchStore.put(uri)
    if (BridgeState.startThrottle.shouldStart()) {
      val next = packageManager.getLaunchIntentForPackage(packageName)
      if (next != null) {
        next.data = null
        next.putExtra(EXTRA_SEQ, seq)
        next.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        BridgeState.raisedByBridge = true
        try {
          startActivity(next)
        } catch (e: Exception) {
          BridgeState.raisedByBridge = false
        }
      }
    }
    BridgeState.sink?.emit("onLaunch", mapOf("seq" to seq))
  }

  companion object {
    const val EXTRA_SEQ = "org.bsv.walletbridge.extra.SEQ"
  }
}
