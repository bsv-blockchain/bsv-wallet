package org.bsv.walletbridge

import org.junit.Assert.*
import org.junit.Test

class NotificationSpecTest {
  @Test fun `session spec names no site and has visibility 0 (private) with public text BSV Wallet and immutable true`() {
    val s = NotificationSpecs.session(2, 0)
    assertEquals("bridge-session", s.channelId)
    assertEquals(2, s.importance)
    assertEquals(0, s.visibility)
    assertEquals("BSV Wallet", s.publicText)
    assertTrue(s.immutable)
    assertFalse(s.text.contains("://"))
    assertFalse(s.text.contains(".com"))
  }

  @Test fun `attention text is generic`() {
    val a = NotificationSpecs.attention()
    assertEquals("A website wants to continue. Tap to review.", a.text)
    assertEquals("bridge-attention", a.channelId)
    assertEquals(4, a.importance)
    assertEquals(0, a.visibility)
    assertEquals("BSV Wallet", a.publicText)
    assertTrue(a.immutable)
  }

  @Test fun `session text counts only`() {
    assertEquals("3 sites connected", NotificationSpecs.session(3, 0).text)
    assertEquals("1 site connected", NotificationSpecs.session(1, 0).text)
    assertEquals("2 requests waiting. Tap to review", NotificationSpecs.session(5, 2).text)
    assertEquals("1 request waiting. Tap to review", NotificationSpecs.session(1, 1).text)
  }

  @Test fun `FLAG_IMMUTABLE is 0x04000000 and FLAG_UPDATE_CURRENT is 0x08000000`() {
    assertEquals(0x04000000, NotificationSpec.FLAG_IMMUTABLE)
    assertEquals(0x08000000, NotificationSpec.FLAG_UPDATE_CURRENT)
  }

  @Test fun `pendingFlags contains IMMUTABLE`() {
    assertEquals(NotificationSpec.FLAG_IMMUTABLE, NotificationSpec.pendingFlags() and NotificationSpec.FLAG_IMMUTABLE)
    assertEquals(NotificationSpec.FLAG_UPDATE_CURRENT, NotificationSpec.pendingFlags() and NotificationSpec.FLAG_UPDATE_CURRENT)
  }

  @Test fun `TARGET_CLASS is the sheet Activity`() {
    assertEquals("org.bsv.walletbridge.BridgeSheetActivity", NotificationSpec.TARGET_CLASS)
  }
}
