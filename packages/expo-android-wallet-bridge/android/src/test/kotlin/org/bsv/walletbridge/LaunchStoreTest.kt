package org.bsv.walletbridge

import org.junit.Assert.*
import org.junit.Test

class LaunchStoreTest {
  @Test fun `put assigns increasing sequence numbers`() {
    val s = LaunchStore({ 0L })
    val a = s.put("a")
    val b = s.put("b")
    assertTrue(b > a)
  }

  @Test fun `take returns every unexpired entry once and empties the store`() {
    val s = LaunchStore({ 0L })
    s.put("a")
    s.put("b")
    assertEquals(listOf("a", "b"), s.take().map { it.uri })
    assertEquals(0, s.size())
  }

  @Test fun `a second take is empty`() {
    val s = LaunchStore({ 0L })
    s.put("a")
    s.take()
    assertTrue(s.take().isEmpty())
  }

  @Test fun `entries older than 120 s are dropped on put and on take`() {
    var now = 0L
    val s = LaunchStore({ now })
    s.put("old")
    now = 120_001
    s.put("new")
    assertEquals(listOf("new"), s.take().map { it.uri })
    s.put("x")
    now += 120_001
    assertTrue(s.take().isEmpty())
  }

  @Test fun `an entry exactly 120 s old is still live`() {
    var now = 0L
    val s = LaunchStore({ now })
    s.put("a")
    now = 120_000
    assertEquals(1, s.take().size)
  }

  @Test fun `ageMs is measured from the creation stamp`() {
    var now = 1_000L
    val s = LaunchStore({ now })
    val seq = s.put("a")
    now = 8_500
    val t = s.take().single()
    assertEquals(7_500L, t.ageMs)
    assertEquals(seq, t.seq)
  }

  @Test fun `capacity 32 displaces the oldest`() {
    val s = LaunchStore({ 0L })
    for (i in 0 until 33) s.put("u$i")
    assertEquals(32, s.size())
    val uris = s.take().map { it.uri }
    assertEquals("u1", uris.first())
    assertEquals("u32", uris.last())
  }

  @Test fun `a second launch within 3 s still stores its record (LaunchStore does not depend on the throttle)`() {
    var now = 0L
    val s = LaunchStore({ now })
    val throttle = StartThrottle({ now })
    s.put("a")
    assertTrue(throttle.shouldStart())
    now = 1_000
    s.put("b")
    assertFalse(throttle.shouldStart())
    assertEquals(2, s.take().size)
  }
}
