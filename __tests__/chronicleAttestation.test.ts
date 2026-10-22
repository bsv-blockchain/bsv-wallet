/**
 * BRC-207 C.0 (0207:10224-10264) — the Chronicle attestation signature vector,
 * run through the PATCHED @bsv/sdk ECDSA seam (patches/@bsv+sdk+4.0.0.patch).
 *
 * In jest no Nitro module is installed, so `ECDSA.sign` routes through the
 * @noble/secp256k1 tier; forcing `globalThis.__bsvSecpNative = {}` makes the
 * seam fall through to the SDK's own pure-JS EC. Both must produce the exact
 * low-S RFC 6979 bytes of the vector. Verification must accept BOTH the low-S
 * and the high-S encoding (BSV Chronicle: S is never normalized away, high-S
 * stays valid), and only with the BRC-42 derived child, never the bare
 * identity key. This is a regression gate for the patch rebase: a rebased
 * seam that rejected high-S, or diverged from the SDK bytes, fails here.
 */
import { ProtoWallet, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'

const g = globalThis as Record<string, any>

const MSG =
  '1color-admit:v1:tm_color_c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f_0:05fabadb4a03eb7d5e54713824a483161a82ecc7061b124e99a13e9778131931:0,2'
const LOW =
  '3045022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be02203eff5870ae5215047d1d624733b29f563d5037660ce5c4ed0ce4ac52cc56758a'
const HIGH =
  '3046022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be022100c100a78f51adeafb82e29db8cc4d60a87d5ea580a262db4eb2edb23a03dfcbb7'
const SIGNER = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
const DERIVED = '033520aaa77b6914019796e974d1737acc890c5283c0921ddcfc2d5c815db8fb90'
const ARGS = { protocolID: [2, 'color admission attestation'] as [2, string], keyID: '1' }

describe('BRC-207 C.0 Chronicle attestation through the patched sdk', () => {
  afterEach(() => {
    delete g.__bsvSecpNative
  })

  it.each([
    ['noble tier', () => delete g.__bsvSecpNative],
    ['pure-JS tier', () => (g.__bsvSecpNative = {})]
  ])('signs C.0 byte-exactly (RFC 6979, low-S) via the %s', async (_tier, select) => {
    select()
    const { signature } = await new ProtoWallet(new PrivateKey(5555)).createSignature({
      data: Utils.toArray(MSG, 'utf8'),
      ...ARGS,
      counterparty: 'anyone'
    })
    expect(Utils.toHex(signature)).toBe(LOW)
  })

  it('derives the vector child signing key', async () => {
    const { publicKey } = await new ProtoWallet(new PrivateKey(5555)).getPublicKey({
      ...ARGS,
      counterparty: 'anyone',
      forSelf: true
    })
    expect(new PrivateKey(5555).toPublicKey().toString()).toBe(SIGNER)
    expect(publicKey).toBe(DERIVED)
  })

  it.each([
    ['low-S', LOW],
    ['high-S', HIGH]
  ])('verifies the %s encoding with the derived child, never the bare key', async (_name, sig) => {
    const ok = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(MSG, 'utf8'),
      signature: Utils.toArray(sig, 'hex'),
      ...ARGS,
      counterparty: SIGNER
    })
    expect(ok.valid).toBe(true)
    // PublicKey.verify hashes MSG with SHA-256 once internally.
    const bare = PublicKey.fromString(SIGNER).verify(MSG, Signature.fromDER(Utils.toArray(sig, 'hex')), 'utf8')
    expect(bare).toBe(false)
    const child = PublicKey.fromString(DERIVED).verify(MSG, Signature.fromDER(Utils.toArray(sig, 'hex')), 'utf8')
    expect(child).toBe(true)
  })

  it('never normalizes S: the high-S DER round-trips unchanged', () => {
    expect(Signature.fromDER(Utils.toArray(HIGH, 'hex')).toDER('hex')).toBe(HIGH)
  })
})
