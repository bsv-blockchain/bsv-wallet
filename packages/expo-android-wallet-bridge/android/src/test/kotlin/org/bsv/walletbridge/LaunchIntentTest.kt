package org.bsv.walletbridge

import org.junit.Assert.*
import org.junit.Test

class LaunchIntentTest {
  private val ok = "bsv-wallet-bridge://launch?v=1&e=0b1c2d3e-0000-4000-8000-000000000000&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&n=AAAAAAAAAAAAAAAAAAAAAA"

  @Test fun `validate accepts the spec URI and refuses wrong scheme, wrong host, 513 bytes, null`() {
    assertEquals(ok, LaunchIntent.validate(ok, "bsv-wallet-bridge"))
    assertNull(LaunchIntent.validate("https://launch?v=1", "bsv-wallet-bridge"))
    assertNull(LaunchIntent.validate("bsv-wallet-bridge://other?v=1", "bsv-wallet-bridge"))
    assertNull(LaunchIntent.validate("bsv-wallet-bridge://launcher?v=1", "bsv-wallet-bridge"))
    assertNull(LaunchIntent.validate("bsv-wallet-bridge://launch.evil.com/?v=1", "bsv-wallet-bridge"))
    assertNull(LaunchIntent.validate(null, "bsv-wallet-bridge"))
    val base = "bsv-wallet-bridge://launch?v=1&x="
    assertNotNull(LaunchIntent.validate(base + "a".repeat(512 - base.length), "bsv-wallet-bridge"))
    assertNull(LaunchIntent.validate(base + "a".repeat(513 - base.length), "bsv-wallet-bridge"))
  }

  @Test fun `size is measured in UTF-8 bytes`() {
    val base = "bsv-wallet-bridge://launch?v=1&x="
    val pad = (512 - base.length) / 2 + 1
    assertNull(LaunchIntent.validate(base + "é".repeat(pad), "bsv-wallet-bridge"))
  }

  @Test fun `StartThrottle first start true, second within 3 s false, true again after 3 s`() {
    var now = 10_000L
    val t = StartThrottle({ now })
    assertTrue(t.shouldStart())
    now += 2_999
    assertFalse(t.shouldStart())
    now += 1
    assertTrue(t.shouldStart())
  }

  @Test fun `StartThrottle window runs from the last allowed start not the last attempt`() {
    var now = 0L
    val t = StartThrottle({ now })
    assertTrue(t.shouldStart())
    now = 2_000
    assertFalse(t.shouldStart())
    now = 2_900
    assertFalse(t.shouldStart())
    now = 3_000
    assertTrue(t.shouldStart())
  }
}
