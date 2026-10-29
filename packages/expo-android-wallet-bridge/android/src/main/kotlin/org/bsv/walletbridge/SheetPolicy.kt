package org.bsv.walletbridge

enum class LaunchMode { OVERLAY, FOREGROUND }
enum class CreateAction { FINISH, FORWARD_TO_MAIN, SHOW }
enum class ResumeAction { STAY, FORWARD_TO_MAIN }

/** Pure decisions for `BridgeSheetActivity` and the trampoline (spec 7.4). */
object SheetPolicy {
  const val SHOW_WINDOW_MS = 120000L
  const val SHOW_MIN_GAP_MS = 30000L

  /**
   * A notification tap carries no sequence number and starts the sheet, so the platform pauses a resumed wallet just
   * before the sheet's onCreate. A pause this recent counts as "still resumed" for that tap.
   */
  const val TAP_PAUSE_GRACE_MS = 500L

  /** Overlay only when the host is attached and ready, the tracker has caught up, and main is alive but not resumed. */
  fun chooseMode(hostAttached: Boolean, ready: Boolean, life: HostLifecycle): LaunchMode =
    if (hostAttached && ready && life.registered && life.mainAlive && !life.mainResumed) LaunchMode.OVERLAY
    else LaunchMode.FOREGROUND

  /** A restored instance finishes at once and arms nothing. */
  fun onCreateAction(
    hasSavedState: Boolean,
    hostAttached: Boolean,
    ready: Boolean,
    life: HostLifecycle,
    mainPausedAgoMs: Long? = null
  ): CreateAction =
    when {
      hasSavedState -> CreateAction.FINISH
      mainPausedAgoMs != null && mainPausedAgoMs in 0 until TAP_PAUSE_GRACE_MS -> CreateAction.FORWARD_TO_MAIN
      chooseMode(hostAttached, ready, life) == LaunchMode.OVERLAY -> CreateAction.SHOW
      else -> CreateAction.FORWARD_TO_MAIN
    }

  /** Two resumed windows would leave an invisible translucent sheet swallowing touches. */
  fun onResumeAction(life: HostLifecycle): ResumeAction =
    if (life.mainResumed) ResumeAction.FORWARD_TO_MAIN else ResumeAction.STAY

  /** A stale or absent sequence number never resets a root that already shows. */
  fun shouldResetRoot(shownSeq: Long?, incomingSeq: Long?): Boolean =
    shownSeq == null || (incomingSeq != null && incomingSeq > shownSeq)

  fun shouldFinishOnStop(leftMark: Boolean): Boolean = leftMark

  /** Used only by the background-show variant (11-W). */
  fun mayShowInBackground(nowMs: Long, lastLaunchMs: Long?, lastShowMs: Long?): Boolean {
    if (lastLaunchMs == null || nowMs - lastLaunchMs > SHOW_WINDOW_MS) return false
    if (lastShowMs != null && nowMs - lastShowMs < SHOW_MIN_GAP_MS) return false
    return true
  }
}

/**
 * The Home rule: `onUserLeaveHint` marks left; `onResume` and `onNewIntent` clear it; `onStop` finishes only with the mark
 * set, so a screen-off stop (no leave hint) or a leave that returned does not finish the sheet.
 */
class LeaveMark {
  private var left = false

  fun onUserLeaveHint() {
    left = true
  }

  fun onResume() {
    left = false
  }

  fun onNewIntent() {
    left = false
  }

  fun shouldFinishOnStop(): Boolean = SheetPolicy.shouldFinishOnStop(left)
}

enum class ReturnAction { FINISH_SHEET, FINISH_SHEET_THEN_MOVE_TASK_TO_BACK, MOVE_TASK_TO_BACK, NONE }

/**
 * `returnToBrowser` decision (spec 7.4, S3 (d)): finish returns to the task directly below the sheet. A live sheet always
 * finishes; when the wallet was also raised by the bridge the executor then moves the main task to back only if main is
 * resumed after the finish (the OS left the user in the wallet), so that row is FINISH_SHEET_THEN_MOVE_TASK_TO_BACK and
 * the move is conditional at execution time. Nothing to return from is NONE (a Back race is a no-op).
 */
object ReturnPolicy {
  fun decide(liveSheet: Boolean, raisedByBridge: Boolean, mainResumed: Boolean): ReturnAction =
    when {
      liveSheet && raisedByBridge -> ReturnAction.FINISH_SHEET_THEN_MOVE_TASK_TO_BACK
      liveSheet -> ReturnAction.FINISH_SHEET
      raisedByBridge && mainResumed -> ReturnAction.MOVE_TASK_TO_BACK
      else -> ReturnAction.NONE
    }
}
