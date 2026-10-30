package org.bsv.walletbridge

import org.junit.Assert.*
import org.junit.Test

class ReturnPolicyTest {
  @Test fun `all eight rows`() {
    for (live in listOf(true, false)) for (raised in listOf(true, false)) for (resumed in listOf(true, false)) {
      val want =
        when {
          live && raised -> ReturnAction.FINISH_SHEET_THEN_MOVE_TASK_TO_BACK
          live -> ReturnAction.FINISH_SHEET
          raised && resumed -> ReturnAction.MOVE_TASK_TO_BACK
          else -> ReturnAction.NONE
        }
      assertEquals("live=$live raised=$raised resumed=$resumed", want, ReturnPolicy.decide(live, raised, resumed))
    }
  }

  @Test fun `live sheet never yields NONE or a bare move`() {
    for (raised in listOf(true, false)) for (resumed in listOf(true, false)) {
      val a = ReturnPolicy.decide(true, raised, resumed)
      assertTrue(a == ReturnAction.FINISH_SHEET || a == ReturnAction.FINISH_SHEET_THEN_MOVE_TASK_TO_BACK)
    }
  }

  @Test fun `no sheet and not raised is NONE (Back race no-op)`() {
    assertEquals(ReturnAction.NONE, ReturnPolicy.decide(false, false, true))
    assertEquals(ReturnAction.NONE, ReturnPolicy.decide(false, false, false))
    assertEquals(ReturnAction.NONE, ReturnPolicy.decide(false, true, false))
  }

  @Test fun `no sheet raised and main resumed moves task to back`() {
    assertEquals(ReturnAction.MOVE_TASK_TO_BACK, ReturnPolicy.decide(false, true, true))
  }
}
