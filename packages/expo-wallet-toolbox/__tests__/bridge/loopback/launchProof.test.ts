import {
  bindingSecret,
  buildIntentLink,
  buildLaunchUri,
  connectAck,
  describeAck,
  helloMac,
  launchProof,
  parseLaunchUri,
  timingSafeEqualB64u,
  type LaunchMessage
} from '../../../core/bridge/loopback/launchProof'
import { b64uDecode, b64uEncode } from '../../../core/bridge/protocol/base64url'
import V from './fixtures/launch-vectors.json'

const SCHEME = 'bsv-wallet-bridge'
const PKG = 'org.bsvblockchain.wallet'
const k = b64uDecode(V.k)
const msg: LaunchMessage = {
  wallet: V.wallet,
  epoch: V.epoch,
  origin: V.origin,
  challenge: V.challenge,
  host: V.host,
  nonce: V.nonce
}

describe('loopback launch proof MACs', () => {
  it('helloMac vector', () => {
    expect(helloMac(k, { origin: V.origin, challenge: V.challenge, host: V.host })).toBe(V.helloMac)
  })
  it('describeAck vector', () => {
    expect(
      describeAck(k, { wallet: V.wallet, origin: V.origin, challenge: V.challenge, host: V.host, nonce: V.nonce })
    ).toBe(V.describeAck)
  })
  it('launchProof vector', () => expect(launchProof(k, msg)).toBe(V.launchProof))
  it('connectAck vector', () => expect(connectAck(k, msg)).toBe(V.connectAck))
  it('bindingSecret vector', () => expect(bindingSecret(k, msg)).toBe(V.bindingSecret))

  it('labels make the five outputs differ for one input', () => {
    const outs = [helloMac(k, msg), describeAck(k, msg), launchProof(k, msg), connectAck(k, msg), bindingSecret(k, msg)]
    expect(new Set(outs).size).toBe(5)
  })

  it('each of origin, challenge, host, epoch, nonce, wallet identity changes launchProof', () => {
    const base = launchProof(k, msg)
    const other = b64uEncode(new Uint8Array(32).fill(7))
    const variants: LaunchMessage[] = [
      { ...msg, origin: 'https://other.example' },
      { ...msg, challenge: other },
      { ...msg, host: '[::1]:3321' },
      { ...msg, epoch: '123e4567-e89b-42d3-a456-426614174001' },
      { ...msg, nonce: b64uEncode(new Uint8Array(16).fill(9)) },
      { ...msg, wallet: { ...msg.wallet, instanceId: 'inst-0002' } },
      { ...msg, wallet: { ...msg.wallet, continuityKey: '03' + 'cd'.repeat(32) } }
    ]
    for (const v of variants) expect(launchProof(k, v)).not.toBe(base)
    expect(launchProof(b64uDecode(other), msg)).not.toBe(base)
  })

  it('JCS key order independent of insertion order', () => {
    const reordered: LaunchMessage = {
      nonce: msg.nonce,
      host: msg.host,
      challenge: msg.challenge,
      origin: msg.origin,
      epoch: msg.epoch,
      wallet: { continuityKey: msg.wallet.continuityKey, instanceId: msg.wallet.instanceId }
    }
    expect(launchProof(k, reordered)).toBe(V.launchProof)
  })

  it('timingSafeEqualB64u false on length difference', () => {
    expect(timingSafeEqualB64u('abc', 'abcd')).toBe(false)
    expect(timingSafeEqualB64u('', 'a')).toBe(false)
    expect(timingSafeEqualB64u(V.launchProof, V.launchProof)).toBe(true)
    expect(timingSafeEqualB64u(V.launchProof, V.connectAck)).toBe(false)
  })
})

describe('launch URI', () => {
  const epoch = '123e4567-e89b-42d3-a456-426614174000'
  const n = V.nonce
  const q = (o: Partial<Record<string, string>> = {}, drop: string[] = []) => {
    const p: Record<string, string> = { v: '1', e: epoch, k: V.k, n, ...o }
    for (const d of drop) delete p[d]
    return (
      `${SCHEME}://launch?` +
      Object.entries(p)
        .map(([a, b]) => `${a}=${b}`)
        .join('&')
    )
  }

  it('parseLaunchUri accepts the spec shape', () => {
    const r = parseLaunchUri(q(), SCHEME)
    expect(r?.epoch).toBe(epoch)
    expect(r?.n).toBe(n)
    expect(b64uEncode(r!.k)).toBe(V.k)
    expect(parseLaunchUri(buildLaunchUri({ scheme: SCHEME, epoch, k, n }), SCHEME)?.epoch).toBe(epoch)
    expect(buildLaunchUri({ scheme: SCHEME, epoch, k, n })).toBe(q())
  })

  const refused: [string, string][] = [
    ['v=2', q({ v: '2' })],
    ['uppercase epoch', q({ e: epoch.toUpperCase() })],
    ['non-v4 epoch', q({ e: '123e4567-e89b-12d3-a456-426614174000' })],
    ['31-byte k', q({ k: b64uEncode(new Uint8Array(31)) })],
    ['padded k', q({ k: V.k + '=' })],
    ['15-byte n', q({ n: b64uEncode(new Uint8Array(15)) })],
    ['extra param', q() + '&x=1'],
    ['duplicate k', q() + '&k=' + V.k],
    ['missing n', q({}, ['n'])],
    ['percent-encoded value', q({ n: n.slice(0, -1) + '%41' })],
    ['fragment', q() + '#frag'],
    ['513 bytes', q() + '&' + 'z'.repeat(513 - q().length - 1)],
    ['wrong host', q().replace('//launch', '//other')],
    ['wrong scheme', q().replace(SCHEME, 'other-scheme')],
    ['empty', '']
  ]
  it.each(refused)('parseLaunchUri refuses %s', (_name, uri) => {
    expect(parseLaunchUri(uri, SCHEME)).toBeUndefined()
  })

  it('buildIntentLink round-trips through the Android intent URI rewrite', () => {
    const link = buildIntentLink({ scheme: SCHEME, packageId: PKG, epoch, k, n })
    expect(link).toBe(`intent://launch?v=1&e=${epoch}&k=${V.k}&n=${n}#Intent;scheme=${SCHEME};package=${PKG};end`)
    // Android rewrites intent://<rest>#Intent;scheme=S;...;end to S://<rest>.
    const m = /^intent:\/\/(.*)#Intent;scheme=([^;]+);package=([^;]+);end$/.exec(link)!
    expect(parseLaunchUri(`${m[2]}://${m[1]}`, SCHEME)?.epoch).toBe(epoch)
    expect(link.length).toBeLessThanOrEqual(512)
  })

  it('S.browser_fallback_url is url-encoded and absent when none', () => {
    const fb = 'https://example.com/get app?x=1&y=2;z'
    const link = buildIntentLink({ scheme: SCHEME, packageId: PKG, epoch, k, n, fallbackUrl: fb })
    expect(link).toContain(`;S.browser_fallback_url=${encodeURIComponent(fb)};end`)
    expect(link.split('#Intent;')[1]).not.toMatch(/[ ?&]/)
    expect(buildIntentLink({ scheme: SCHEME, packageId: PKG, epoch, k, n })).not.toContain('browser_fallback_url')
  })

  it('buildLaunchUri refuses wrong-size secrets', () => {
    expect(() => buildLaunchUri({ scheme: SCHEME, epoch, k: new Uint8Array(31), n })).toThrow()
    expect(() => buildLaunchUri({ scheme: SCHEME, epoch, k, n: b64uEncode(new Uint8Array(15)) })).toThrow()
    expect(() => buildLaunchUri({ scheme: SCHEME, epoch: 'nope', k, n })).toThrow()
  })
})
