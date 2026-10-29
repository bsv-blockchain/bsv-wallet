package org.bsv.walletbridge

import org.junit.Assert.*
import org.junit.Test

class LifecycleStateTest {
  @Test fun `unregistered until catchUp and mainAlive is null`() {
    val s = LifecycleState()
    assertFalse(s.registered())
    assertNull(s.mainAlive())
    s.catchUp(true, false)
    assertTrue(s.registered())
    assertEquals(true, s.mainAlive())
  }

  @Test fun `snapshot maps unknown alive to false with registered false`() {
    assertEquals(HostLifecycle(false, false, false, false), LifecycleState().snapshot())
  }

  @Test fun `catchUp alive and not resumed marks alive only`() {
    val s = LifecycleState()
    s.catchUp(true, false)
    assertEquals(HostLifecycle(true, true, false, false), s.snapshot())
  }

  @Test fun `catchUp with main resumed gives mainResumed true (cold start already resumed)`() {
    val s = LifecycleState()
    s.catchUp(true, true)
    assertTrue(s.mainResumed())
    assertEquals(HostLifecycle(true, true, true, false), s.snapshot())
  }

  @Test fun `onResumed main backstop marks main alive and registers when catchUp missed it`() {
    val s = LifecycleState()
    s.onResumed(Role.MAIN)
    assertTrue(s.registered())
    assertEquals(true, s.mainAlive())
    assertTrue(s.mainResumed())
  }

  @Test fun `onDestroyed main clears alive and resumed`() {
    val s = LifecycleState()
    s.catchUp(true, true)
    s.onDestroyed(Role.MAIN)
    assertEquals(false, s.mainAlive())
    assertFalse(s.mainResumed())
  }

  @Test fun `sheet resumed with main not resumed`() {
    val s = LifecycleState()
    s.catchUp(true, true)
    s.onPaused(Role.MAIN)
    s.onResumed(Role.SHEET)
    assertEquals(HostLifecycle(true, true, false, true), s.snapshot())
  }

  @Test fun `handover main-to-sheet then sheet-to-main keeps alive true throughout`() {
    val s = LifecycleState()
    s.catchUp(true, true)
    s.onPaused(Role.MAIN)
    assertEquals(true, s.mainAlive())
    s.onCreated(Role.SHEET)
    s.onResumed(Role.SHEET)
    assertEquals(true, s.mainAlive())
    s.onPaused(Role.SHEET)
    assertEquals(true, s.mainAlive())
    s.onResumed(Role.MAIN)
    assertEquals(true, s.mainAlive())
    assertTrue(s.mainResumed())
    assertFalse(s.sheetResumed())
  }

  @Test fun `onCreated alone does not register`() {
    val s = LifecycleState()
    s.onCreated(Role.MAIN)
    s.onCreated(Role.SHEET)
    assertFalse(s.registered())
    assertNull(s.mainAlive())
  }

  @Test fun `a stale catchUp after an observed resume does not overwrite it`() {
    val s = LifecycleState()
    s.onResumed(Role.MAIN)
    s.catchUp(false, false)
    assertEquals(HostLifecycle(true, true, true, false), s.snapshot())
  }
}
