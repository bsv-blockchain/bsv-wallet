/**
 * Real crypto only: a ProtoWallet over a random key signs, and the SDK's own
 * Certificate.verify decides. A mocked signature would make every case below
 * pass for the wrong reason.
 */
import { Certificate, PrivateKey, ProtoWallet, Utils, type WalletProtocol } from '@bsv/sdk'
import { PROFILE_CERT_TYPE, ZERO_OUTPOINT } from '../../../core/identity/handleRegistry/rules'
import {
  buildProfileCertificate,
  resetDroppedLog,
  verifyProfileCertificate,
  type ProfileCertJson,
  type ProfileSigner
} from '../../../core/identity/handleRegistry/profileCert'

const DOMAIN = 'deggen.com'

function signerFor(key: PrivateKey): ProfileSigner {
  return new ProtoWallet(key) as unknown as ProfileSigner
}

/** A certificate minted by hand, so a test can break exactly one rule. */
async function mint(
  key: PrivateKey,
  fields: Record<string, string>,
  overrides: { subject?: string; type?: string; revocationOutpoint?: string } = {}
): Promise<ProfileCertJson> {
  const pub = key.toPublicKey().toString()
  const certificate = new Certificate(
    overrides.type ?? PROFILE_CERT_TYPE,
    'c2VyaWFsc2VyaWFsc2VyaWFsc2VyaWFsc2VyaWFsc2U=', // 32 bytes; the SDK rejects any other serial length
    overrides.subject ?? pub,
    pub,
    overrides.revocationOutpoint ?? ZERO_OUTPOINT,
    fields
  )
  await certificate.sign(new ProtoWallet(key))
  return {
    type: certificate.type,
    serialNumber: certificate.serialNumber,
    subject: certificate.subject,
    certifier: certificate.certifier,
    revocationOutpoint: certificate.revocationOutpoint,
    fields: certificate.fields,
    signature: certificate.signature ?? ''
  }
}

beforeEach(() => {
  resetDroppedLog()
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  jest.restoreAllMocks()
})

describe('buildProfileCertificate', () => {
  it('builds a self-signed certificate that verifies back into a profile', async () => {
    const key = PrivateKey.fromRandom()
    const issuedAt = new Date('2026-09-18T10:00:00.000Z')
    const cert = await buildProfileCertificate({
      signer: signerFor(key),
      paymail: `dee@${DOMAIN}`,
      issuedAt,
      displayName: 'Dee K'
    })
    expect(cert.type).toBe(PROFILE_CERT_TYPE)
    expect(cert.subject).toBe(cert.certifier)
    expect(cert.subject).toBe(key.toPublicKey().toString())
    expect(cert.revocationOutpoint).toBe(ZERO_OUTPOINT)
    expect(cert.fields).toEqual({
      paymail: `dee@${DOMAIN}`,
      issuedAt: '2026-09-18T10:00:00.000Z',
      displayName: 'Dee K'
    })
    expect(cert.signature).not.toBe('')

    const profile = await verifyProfileCertificate(cert, { domain: DOMAIN })
    expect(profile).toEqual({
      identityKey: key.toPublicKey().toString(),
      paymail: `dee@${DOMAIN}`,
      handle: 'dee',
      domain: DOMAIN,
      displayName: 'Dee K',
      issuedAt,
      certificate: cert
    })
  })

  it('gives every certificate a fresh 32-byte serial', async () => {
    const signer = signerFor(PrivateKey.fromRandom())
    const args = { signer, paymail: `dee@${DOMAIN}`, issuedAt: new Date() }
    const a = await buildProfileCertificate(args)
    const b = await buildProfileCertificate(args)
    expect(a.serialNumber).not.toBe(b.serialNumber)
    expect(Utils.toArray(a.serialNumber, 'base64')).toHaveLength(32)
  })

  it('sends no display-name field at all for a blank one', async () => {
    const cert = await buildProfileCertificate({
      signer: signerFor(PrivateKey.fromRandom()),
      paymail: `dee@${DOMAIN}`,
      issuedAt: new Date(),
      displayName: '   '
    })
    expect(Object.keys(cert.fields).sort()).toEqual(['issuedAt', 'paymail'])
  })

  it('marks a tombstone with released=true', async () => {
    const cert = await buildProfileCertificate({
      signer: signerFor(PrivateKey.fromRandom()),
      paymail: `dee@${DOMAIN}`,
      issuedAt: new Date(),
      released: true
    })
    expect(cert.fields.released).toBe('true')
  })

  it('refuses a paymail that is not handle@domain', async () => {
    await expect(
      buildProfileCertificate({ signer: signerFor(PrivateKey.fromRandom()), paymail: 'dee', issuedAt: new Date() })
    ).rejects.toThrow(/not a valid paymail/)
  })

  it('refuses a display name past the 1 KB field limit rather than letting the server refuse it', async () => {
    await expect(
      buildProfileCertificate({
        signer: signerFor(PrivateKey.fromRandom()),
        paymail: `dee@${DOMAIN}`,
        issuedAt: new Date(),
        displayName: 'a'.repeat(1025)
      })
    ).rejects.toThrow(/field value too long/)
  })

  /**
   * The SDK asks for no counterparty, and anyone-verifiability depends on the
   * wallet defaulting the omission to 'anyone' — `Certificate.verify()` is an
   * 'anyone' ProtoWallet checking against `certifier`. The app's own signer is
   * the originator-bound PermissionsManager, not a ProtoWallet, so pin both
   * halves of that contract here rather than discovering it on a device.
   */
  it('asks for no counterparty, and the wallet default is what makes it verify', async () => {
    const key = PrivateKey.fromRandom()
    const inner = new ProtoWallet(key)
    const asked: (string | undefined)[] = []
    const signer: ProfileSigner = {
      getPublicKey: async () => ({ publicKey: key.toPublicKey().toString() }),
      createSignature: async args => {
        asked.push(args.counterparty)
        return await inner.createSignature({
          ...args,
          protocolID: args.protocolID as WalletProtocol,
          counterparty: args.counterparty ?? 'anyone'
        })
      }
    }
    const cert = await buildProfileCertificate({ signer, paymail: `dee@${DOMAIN}`, issuedAt: new Date() })
    expect(asked).toEqual([undefined])
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).not.toBeNull()
  })
})

describe('verifyProfileCertificate', () => {
  const key = PrivateKey.fromRandom()
  const good = () => ({ paymail: `dee@${DOMAIN}`, issuedAt: '2026-09-18T10:00:00.000Z' })

  it('drops a certificate of the wrong type', async () => {
    const cert = await mint(key, good(), { type: 'd2hhdGV2ZXJ3aGF0ZXZlcndoYXRldmVyd2hhdGV2ZXI=' })
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a certificate whose subject is not its certifier, however well it is signed', async () => {
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    const cert = await mint(key, good(), { subject: other })
    expect(
      await new Certificate(
        cert.type,
        cert.serialNumber,
        cert.subject,
        cert.certifier,
        cert.revocationOutpoint,
        cert.fields,
        cert.signature
      ).verify()
    ).toBe(true)
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a certificate whose fields were edited after signing', async () => {
    const cert = await mint(key, { ...good(), displayName: 'Dee K' })
    cert.fields.displayName = 'Someone Else'
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a certificate for another domain', async () => {
    const cert = await mint(key, good())
    expect(await verifyProfileCertificate(cert, { domain: 'other.example' })).toBeNull()
  })

  it('drops a paymail that is not exactly lowercase', async () => {
    const cert = await mint(key, { paymail: `Dee@${DOMAIN}`, issuedAt: '2026-09-18T10:00:00.000Z' })
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a tombstone — released is not a profile', async () => {
    const cert = await mint(key, { ...good(), released: 'true' })
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a non-zero revocation outpoint', async () => {
    const cert = await mint(key, good(), { revocationOutpoint: `${'a'.repeat(64)}.0` })
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops an oversize field value', async () => {
    const cert = await mint(key, { ...good(), bio: 'a'.repeat(1025) })
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a missing or unparseable issuedAt', async () => {
    expect(await verifyProfileCertificate(await mint(key, { paymail: `dee@${DOMAIN}` }), { domain: DOMAIN })).toBeNull()
    expect(
      await verifyProfileCertificate(await mint(key, { paymail: `dee@${DOMAIN}`, issuedAt: 'soon' }), {
        domain: DOMAIN
      })
    ).toBeNull()
  })

  it('drops a reverse-lookup answer about a different key', async () => {
    const cert = await mint(key, good())
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN, identityKey: other })).toBeNull()
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN, identityKey: cert.subject })).not.toBeNull()
  })

  it('drops a row that is not the exact paymail the user typed', async () => {
    const cert = await mint(key, good())
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN, paymail: `dee2@${DOMAIN}` })).toBeNull()
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN, paymail: `DEE@${DOMAIN}` })).not.toBeNull()
  })

  it('never throws on junk', async () => {
    for (const junk of [null, undefined, 42, 'cert', {}, { fields: null }, { fields: { paymail: 7 } }]) {
      expect(await verifyProfileCertificate(junk, { domain: DOMAIN })).toBeNull()
    }
  })

  // A hostile or broken registry answers up to ten rows per debounced
  // keystroke. One line per reason, then silence — the spec's "logged once".
  it('logs a reason once, however many rows arrive carrying it', async () => {
    const junk = await mint(key, good(), { type: 'd2hhdGV2ZXJ3aGF0ZXZlcndoYXRldmVyd2hhdGV2ZXI=' })
    for (let i = 0; i < 10; i++) expect(await verifyProfileCertificate(junk, { domain: DOMAIN })).toBeNull()
    expect(console.log).toHaveBeenCalledTimes(1)
    // A different reason is a different fact and gets its own line.
    expect(
      await verifyProfileCertificate(await mint(key, { ...good(), released: 'true' }), { domain: DOMAIN })
    ).toBeNull()
    expect(console.log).toHaveBeenCalledTimes(2)
  })

  /**
   * The reasons a throw carries are the SDK's, and some of them are shaped by
   * the certificate: one bad character in `serialNumber` reaches the base64
   * decoder, which names the index it failed at — a different sentence per
   * position. A registry answering with those would otherwise buy a log line
   * each and, once enough of them had been spent, silence every real reason
   * for the life of the process.
   */
  it('cannot be made to spend the log budget by throwing differently every time', async () => {
    const cert = await mint(key, good())
    for (let i = 0; i < 40; i++) {
      const serial = cert.serialNumber.split('')
      serial[i % serial.length] = '!'
      expect(await verifyProfileCertificate({ ...cert, serialNumber: serial.join('') }, { domain: DOMAIN })).toBeNull()
    }
    expect(console.log).toHaveBeenCalledTimes(1)

    // The line that matters: a real reason, after the attempt, is still said.
    expect(
      await verifyProfileCertificate(await mint(key, { ...good(), released: 'true' }), { domain: DOMAIN })
    ).toBeNull()
    expect(console.log).toHaveBeenCalledTimes(2)
  })

  // The SDK answers false for a forged certificate (it threw before 2.8), so
  // a forgery is named as one rather than lumped in with verification throws.
  it('reports a forged certificate as a signature that does not verify', async () => {
    const cert = await mint(key, { ...good(), displayName: 'Dee K' })
    cert.fields.displayName = 'Someone Else'
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
    expect(console.log).toHaveBeenCalledTimes(1)
    expect((console.log as jest.Mock).mock.calls[0].join(' ')).toContain('signature does not verify')
  })
})
