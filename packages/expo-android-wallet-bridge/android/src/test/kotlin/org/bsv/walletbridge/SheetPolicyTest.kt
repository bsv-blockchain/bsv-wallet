package org.bsv.walletbridge

import org.junit.Assert.*
import org.junit.Test

class SheetPolicyTest {
  private val ok = HostLifecycle(registered = true, mainAlive = true, mainResumed = false, sheetResumed = false)

  @Test fun `chooseMode false inputs give FOREGROUND`() {
    assertEquals(LaunchMode.FOREGROUND, SheetPolicy.chooseMode(false, true, ok))
    assertEquals(LaunchMode.FOREGROUND, SheetPolicy.chooseMode(true, false, ok))
    assertEquals(LaunchMode.FOREGROUND, SheetPolicy.chooseMode(true, true, ok.copy(registered = false)))
    assertEquals(LaunchMode.FOREGROUND, SheetPolicy.chooseMode(true, true, ok.copy(mainAlive = false)))
  }

  @Test fun `chooseMode all true with main not resumed is OVERLAY`() {
    assertEquals(LaunchMode.OVERLAY, SheetPolicy.chooseMode(true, true, ok))
  }

  @Test fun `registered false with mainAlive true is FOREGROUND`() {
    assertEquals(LaunchMode.FOREGROUND, SheetPolicy.chooseMode(true, true, ok.copy(registered = false, mainAlive = true)))
  }

  @Test fun `mainResumed true with everything else true is FOREGROUND`() {
    assertEquals(LaunchMode.FOREGROUND, SheetPolicy.chooseMode(true, true, ok.copy(mainResumed = true)))
  }

  @Test fun `onCreateAction restored state is FINISH`() {
    assertEquals(CreateAction.FINISH, SheetPolicy.onCreateAction(true, true, true, ok))
    assertEquals(CreateAction.FINISH, SheetPolicy.onCreateAction(true, false, false, ok.copy(registered = false)))
  }

  @Test fun `onCreateAction fresh with overlay conditions is SHOW`() {
    assertEquals(CreateAction.SHOW, SheetPolicy.onCreateAction(false, true, true, ok))
  }

  @Test fun `onCreateAction fresh cold or locked or main resumed is FORWARD_TO_MAIN`() {
    assertEquals(CreateAction.FORWARD_TO_MAIN, SheetPolicy.onCreateAction(false, false, false, ok.copy(registered = false)))
    assertEquals(CreateAction.FORWARD_TO_MAIN, SheetPolicy.onCreateAction(false, true, false, ok))
    assertEquals(CreateAction.FORWARD_TO_MAIN, SheetPolicy.onCreateAction(false, true, true, ok.copy(mainResumed = true)))
  }

  @Test fun `onResumeAction main resumed forwards`() {
    assertEquals(ResumeAction.FORWARD_TO_MAIN, SheetPolicy.onResumeAction(ok.copy(mainResumed = true)))
  }

  @Test fun `onResumeAction main not resumed stays`() {
    assertEquals(ResumeAction.STAY, SheetPolicy.onResumeAction(ok))
  }

  @Test fun `first root resets`() = assertTrue(SheetPolicy.shouldResetRoot(null, 5L))
  @Test fun `newer sequence resets`() = assertTrue(SheetPolicy.shouldResetRoot(4L, 5L))

  @Test fun `equal and lower do not reset`() {
    assertFalse(SheetPolicy.shouldResetRoot(5L, 5L))
    assertFalse(SheetPolicy.shouldResetRoot(5L, 4L))
  }

  @Test fun `absent sequence does not reset a shown root`() = assertFalse(SheetPolicy.shouldResetRoot(5L, null))
  @Test fun `absent sequence on the first root resets`() = assertTrue(SheetPolicy.shouldResetRoot(null, null))

  @Test fun `screen-off stop without leave mark does not finish`() = assertFalse(SheetPolicy.shouldFinishOnStop(false))
  @Test fun `stop with leave mark finishes`() = assertTrue(SheetPolicy.shouldFinishOnStop(true))

  @Test fun `leave then resume then stop does not finish`() {
    val m = LeaveMark()
    m.onUserLeaveHint()
    m.onResume()
    assertFalse(m.shouldFinishOnStop())
  }

  @Test fun `leave then stop finishes and new intent clears the mark`() {
    val m = LeaveMark()
    m.onUserLeaveHint()
    assertTrue(m.shouldFinishOnStop())
    m.onNewIntent()
    assertFalse(m.shouldFinishOnStop())
  }

  @Test fun `mayShowInBackground window and gap`() {
    assertTrue(SheetPolicy.mayShowInBackground(100000L, 50000L, null))
    assertFalse(SheetPolicy.mayShowInBackground(200000L, 50000L, null))
    assertFalse(SheetPolicy.mayShowInBackground(100000L, null, null))
    assertFalse(SheetPolicy.mayShowInBackground(100000L, 50000L, 80000L))
    assertTrue(SheetPolicy.mayShowInBackground(100000L, 50000L, 70000L))
  }
}
