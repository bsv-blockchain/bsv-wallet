package org.bsv.walletbridge

/**
 * Obscured-touch filter for the sheet (spec 7.4). The Activity passes `MotionEvent.getFlags()`. After [DROP_LIMIT]
 * dropped touches [noteDrop] says to forward to `MainActivity` (the in-wallet sheet) rather than leave a prompt the user
 * cannot answer. Both destinations install the same native filter.
 */
class TouchGuard {
  companion object {
    /** `MotionEvent.FLAG_WINDOW_IS_OBSCURED` */
    const val OBSCURED = 0x1
    /** `MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED` */
    const val PARTIALLY_OBSCURED = 0x2
    const val DROP_LIMIT = 3
  }

  private var drops = 0

  fun shouldDrop(flags: Int): Boolean = (flags and (OBSCURED or PARTIALLY_OBSCURED)) != 0

  /** Consume obscured input before any approval view or React callback sees it. */
  fun dispatch(flags: Int, deliver: () -> Boolean): Boolean = if (shouldDrop(flags)) true else deliver()

  /** Counts one dropped touch; true once [DROP_LIMIT] drops have happened. */
  fun noteDrop(): Boolean {
    drops++
    return drops >= DROP_LIMIT
  }

  fun reset() {
    drops = 0
  }
}
