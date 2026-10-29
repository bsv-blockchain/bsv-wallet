/** Loopback Host check (spec 6.2, DNS rebinding defence). Pure: shared in behaviour with the Kotlin HostCheck. */

export interface LoopbackBound {
  port: number
  ipv4: boolean
  ipv6: boolean
}

/**
 * The exact `Host` header values accepted for a bound port: `127.0.0.1:p`, `[::1]:p` when IPv6 is bound, and
 * `localhost:p` only when both families are bound (BRC-185 forbids reaching another wallet through `localhost`).
 */
export function allowedHosts(b: LoopbackBound): string[] {
  const out: string[] = []
  if (b.ipv4) out.push(`127.0.0.1:${b.port}`)
  if (b.ipv6) out.push(`[::1]:${b.port}`)
  if (b.ipv4 && b.ipv6) out.push(`localhost:${b.port}`)
  return out
}

/** Exact, case-sensitive comparison: no normalisation, no trailing dot, no default-port elision. */
export function isAllowedHost(value: string | undefined | null, bound: LoopbackBound): boolean {
  if (typeof value !== 'string') return false
  return allowedHosts(bound).includes(value)
}
