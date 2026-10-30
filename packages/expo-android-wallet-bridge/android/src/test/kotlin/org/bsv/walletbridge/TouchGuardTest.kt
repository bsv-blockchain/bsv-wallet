package org.bsv.walletbridge

import org.junit.Assert.*
import org.junit.Test

class TouchGuardTest {
  @Test fun `drops obscured`() = assertTrue(TouchGuard().shouldDrop(TouchGuard.OBSCURED))
  @Test fun `drops partially obscured`() = assertTrue(TouchGuard().shouldDrop(TouchGuard.PARTIALLY_OBSCURED))
  @Test fun `drops both`() = assertTrue(TouchGuard().shouldDrop(TouchGuard.OBSCURED or TouchGuard.PARTIALLY_OBSCURED))
  @Test fun `passes 0`() = assertFalse(TouchGuard().shouldDrop(0))
  @Test fun `passes unrelated flags`() = assertFalse(TouchGuard().shouldDrop(0x4))

  @Test fun `constants equal the MotionEvent values 1 and 2`() {
    assertEquals(1, TouchGuard.OBSCURED)
    assertEquals(2, TouchGuard.PARTIALLY_OBSCURED)
    assertEquals(3, TouchGuard.DROP_LIMIT)
  }

  @Test fun `noteDrop is false for two drops and true at the third`() {
    val g = TouchGuard()
    assertFalse(g.noteDrop())
    assertFalse(g.noteDrop())
    assertTrue(g.noteDrop())
  }

  @Test fun `reset clears the count`() {
    val g = TouchGuard()
    g.noteDrop()
    g.noteDrop()
    g.reset()
    assertFalse(g.noteDrop())
    assertFalse(g.noteDrop())
    assertTrue(g.noteDrop())
  }
}
