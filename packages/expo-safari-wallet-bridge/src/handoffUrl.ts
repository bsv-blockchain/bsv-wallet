/**
 * The handoff URL is a doorbell, not data (spec 6.7): `<scheme>://bridge?v=1&n=<nonce>`. It is accepted
 * only if the scheme equals the host's `BSVBridgeScheme`, the host is `bridge` and `v` is `1`. Every other
 * part, the nonce included, is ignored and never trusted.
 */
export function parseHandoffUrl(url: string, scheme: string): boolean {
  if (typeof url !== 'string' || typeof scheme !== 'string' || scheme === '') return false
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)\/?(?:\?([^#]*))?(?:#.*)?$/.exec(url)
  if (m === null) return false
  if (m[1].toLowerCase() !== scheme.toLowerCase()) return false
  if (m[2] !== 'bridge') return false
  const versions = (m[3] ?? '')
    .split('&')
    .filter(p => p === 'v' || p.startsWith('v='))
    .map(p => p.slice(2))
  return versions.length === 1 && versions[0] === '1'
}
