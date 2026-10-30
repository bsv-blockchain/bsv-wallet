package org.bsv.walletbridge

import java.io.File
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostCheckTest {
  @Test fun `parity - every case in host-check json gives the fixture's expected result`() {
    val path = System.getProperty("hostCheckFixture")
    assertTrue("hostCheckFixture system property", path != null)
    val arr = JSONArray(File(path!!).readText())
    assertTrue(arr.length() > 0)
    for (i in 0 until arr.length()) {
      val c = arr.getJSONObject(i)
      val host = if (c.isNull("host")) null else c.getString("host")
      val got = HostCheck.allowed(host, c.getInt("port"), c.getBoolean("ipv4"), c.getBoolean("ipv6"))
      assertEquals(c.getString("name"), c.getBoolean("expected"), got)
    }
  }

  @Test fun `allowedHosts lists exactly the bound spellings`() {
    assertEquals(listOf("127.0.0.1:3321", "[::1]:3321", "localhost:3321"), HostCheck.allowedHosts(3321, true, true))
    assertEquals(listOf("127.0.0.1:3321"), HostCheck.allowedHosts(3321, true, false))
    assertEquals(listOf("[::1]:3321"), HostCheck.allowedHosts(3321, false, true))
    assertTrue(HostCheck.allowedHosts(3321, false, false).isEmpty())
  }

  @Test fun `localhost is refused unless both families are bound`() {
    assertFalse(HostCheck.allowed("localhost:3321", 3321, true, false))
    assertFalse(HostCheck.allowed("localhost:3321", 3321, false, true))
    assertTrue(HostCheck.allowed("localhost:3321", 3321, true, true))
  }
}
