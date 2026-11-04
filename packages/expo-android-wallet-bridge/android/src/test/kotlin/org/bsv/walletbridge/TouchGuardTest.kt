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
  @Test fun `fallback keeps rejecting obscured gestures in the main window`() {
    val sheet = TouchGuard()
    val main = TouchGuard()
    var approvals = 0
    repeat(TouchGuard.DROP_LIMIT) { sheet.dispatch(TouchGuard.OBSCURED) { approvals++; false } }
    repeat(20) {
      assertTrue(main.dispatch(TouchGuard.OBSCURED) { approvals++; false })
      assertTrue(main.dispatch(TouchGuard.PARTIALLY_OBSCURED) { approvals++; false })
    }
    assertEquals(0, approvals)
    assertFalse(main.dispatch(0) { approvals++; false })
    assertEquals(1, approvals)
  }

  @Test fun `unobscured callbacks preserve their result`() {
    val guard = TouchGuard()
    assertTrue(guard.dispatch(0) { true })
    assertFalse(guard.dispatch(0) { false })
  }
}
