/** The descriptor endpoints a loopback wallet advertises (spec 6.2.1). Same list on every response. */
import type { DescriptorEndpoint } from '../protocol/descriptor'
import type { LoopbackBound } from './hostCheck'

export function loopbackEndpoints(b: LoopbackBound): DescriptorEndpoint[] {
  const out: DescriptorEndpoint[] = []
  if (b.ipv4) out.push({ id: 'json-ipv4', type: 'http-json', address: `http://127.0.0.1:${b.port}` })
  if (b.ipv6) out.push({ id: 'json-ipv6', type: 'http-json', address: `http://[::1]:${b.port}` })
  if (b.ipv4 && b.ipv6) out.push({ id: 'json-localhost', type: 'http-json', address: `http://localhost:${b.port}` })
  return out
}
