package org.bsv.walletbridge

/**
 * Loopback Host check (DNS rebinding defence, spec 6.2). Pure JVM. Mirrors `allowedHosts` in the toolbox
 * (`core/bridge/loopback/hostCheck.ts`); both are tested against the shared `host-check.json`.
 * Exact, case-sensitive comparison: no normalisation, no trailing dot, no default-port elision.
 */
object HostCheck {
  fun allowedHosts(port: Int, ipv4: Boolean, ipv6: Boolean): List<String> {
    val out = ArrayList<String>(3)
    if (ipv4) out.add("127.0.0.1:$port")
    if (ipv6) out.add("[::1]:$port")
    if (ipv4 && ipv6) out.add("localhost:$port")
    return out
  }

  fun allowed(host: String?, port: Int, ipv4: Boolean, ipv6: Boolean): Boolean {
    if (host == null) return false
    return allowedHosts(port, ipv4, ipv6).contains(host)
  }
}
