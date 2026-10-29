package org.bsv.walletbridge

import org.junit.Assert.*
import org.junit.Test

class DestroyGuardTest {
  private fun check(alive: Boolean?, current: Boolean, action: DestroyAction) {
    val d = DestroyGuard.decide(alive, current)
    assertEquals("action alive=$alive current=$current", action, d.action)
    assertEquals("clear alive=$alive current=$current", current, d.clearCurrentSheetRef)
  }

  @Test fun `main alive current`() = check(true, true, DestroyAction.UNLOAD_ONLY)
  @Test fun `main alive not current`() = check(true, false, DestroyAction.UNLOAD_ONLY)
  @Test fun `main dead current`() = check(false, true, DestroyAction.SUPER)
  @Test fun `main dead not current`() = check(false, false, DestroyAction.SUPER)
  @Test fun `main unknown current`() = check(null, true, DestroyAction.SUPER)
  @Test fun `main unknown not current`() = check(null, false, DestroyAction.SUPER)
}
