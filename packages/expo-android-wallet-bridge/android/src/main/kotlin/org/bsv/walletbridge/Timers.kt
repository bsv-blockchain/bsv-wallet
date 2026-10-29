package org.bsv.walletbridge

/**
 * Named deadline timers (spec 7.1). Pure JVM: the scheduler is injected. In the module the Scheduler is bound to an
 * Android `Handler` so timers fire while no ReactActivity is resumed; JS only reacts to the emitted name.
 */
interface Scheduler {
  fun postDelayed(name: String, ms: Long, fn: () -> Unit)

  fun cancel(name: String)
}

class Timers(private val scheduler: Scheduler, private val emit: (String) -> Unit) {
  /** Replaces any timer of the same name. */
  fun set(name: String, ms: Long) {
    scheduler.cancel(name)
    scheduler.postDelayed(name, ms) { emit(name) }
  }

  fun clear(name: String) {
    scheduler.cancel(name)
  }
}
