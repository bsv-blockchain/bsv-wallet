// @ts-nocheck
import { Certificate, Hash, MasterCertificate, PrivateKey, ProtoWallet, Utils, VerifiableCertificate, type WalletCertificate, type WalletInterface } from '@bsv/sdk'
import type { SnippetRunner } from '../../lib/snippet-runner'
import { check, reliabilityWallet } from '../reliability/support'
import { certifier, certifierUrl } from '../conformance/support'
import { booleans, freshID, runCases, type BranchCase } from './support'

export const directCertificateType = Utils.toBase64(Hash.sha256('fast branch direct certificate', 'utf8'))

export async function makeDirectCertificate(wallet: WalletInterface, keyringRevealer: 'certifier' | 'subject', type = directCertificateType, privileged = false) {
  const privilege = { privileged, ...(privileged ? { privilegedReason: 'Test privileged certificate branches' } : {}) }
  const subject = (await wallet.getPublicKey({ identityKey: true, ...privilege })).publicKey
  const issuer = new ProtoWallet(PrivateKey.fromRandom())
  // WalletClient requires txid.vout. The signature covers the outpoint, so the placeholder is fixed before signing.
  const master = await MasterCertificate.issueCertificateForSubject(issuer, subject, { visible: 'branch fixture', hidden: 'withheld fixture' }, type, async () => `${'0'.repeat(64)}.0`)
  let keyring = master.masterKeyring
  let revealer = master.certifier
  if (keyringRevealer === 'subject') {
    const wrapped: Record<string, string> = {}
    for (const [field, encryptedKey] of Object.entries(keyring)) {
      const sharedScope = Certificate.getCertificateFieldEncryptionDetails(field)
      const plaintext = (await issuer.decrypt({ ...sharedScope, counterparty: subject, ciphertext: Utils.toArray(encryptedKey, 'base64') })).plaintext
      wrapped[field] = Utils.toBase64((await wallet.encrypt({ ...sharedScope, counterparty: 'self', plaintext, ...privilege })).ciphertext)
    }
    keyring = wrapped
    revealer = subject
  }
  return { master, args: { acquisitionProtocol: 'direct' as const, type: master.type, certifier: master.certifier, serialNumber: master.serialNumber, revocationOutpoint: master.revocationOutpoint, fields: master.fields, signature: master.signature, keyringRevealer: revealer, keyringForSubject: keyring, ...privilege } }
}

async function proveAndList(wallet: WalletInterface, certificate: WalletCertificate, runner: SnippetRunner, privileged: boolean) {
  const privilege = { privileged, ...(privileged ? { privilegedReason: 'Test privileged certificate branches' } : {}) }
  for (const limit of [1, 10000]) for (const offset of [0, 1]) {
    const listed = await wallet.listCertificates({ certifiers: [certificate.certifier], types: [certificate.type], limit, offset, ...privilege })
    check(listed.certificates.length <= limit && listed.totalCertificates >= listed.certificates.length, 'Certificate page exceeds limit or total')
    if (offset === 0) check(listed.certificates.some(item => item.serialNumber === certificate.serialNumber), 'Acquired certificate is not listed')
  }
  // Empty filters and multi-filter alternatives should include the new fixture.
  for (const filters of [{ certifiers: [], types: [certificate.type] }, { certifiers: [certificate.certifier], types: [] }, { certifiers: [], types: [] }]) {
    const listed = await wallet.listCertificates({ ...filters, limit: 10000, ...privilege })
    check(listed.certificates.some(item => item.serialNumber === certificate.serialNumber && item.certifier === certificate.certifier), 'Certificate filter branch omitted fixture')
  }
  const verifier = new ProtoWallet(PrivateKey.fromRandom())
  const verifierIdentity = (await verifier.getPublicKey({ identityKey: true })).publicKey
  for (const fieldsToReveal of [[], ['visible'], ['visible', 'hidden']]) {
    for (const full of booleans) {
      const proof = await wallet.proveCertificate({ certificate: full ? certificate : { type: certificate.type, serialNumber: certificate.serialNumber, certifier: certificate.certifier }, fieldsToReveal, verifier: verifierIdentity, ...privilege })
      check(JSON.stringify(Object.keys(proof.keyringForVerifier).sort()) === JSON.stringify([...fieldsToReveal].sort()), 'Proof disclosed the wrong set of fields')
      if (fieldsToReveal.length > 0) {
        const disclosed = await VerifiableCertificate.fromCertificate(certificate, proof.keyringForVerifier).decryptFields(verifier)
        check(Object.keys(disclosed).length === fieldsToReveal.length, 'Verifier field count changed')
        if (fieldsToReveal.includes('visible')) check(disclosed.visible === 'branch fixture', 'Visible field did not decrypt')
        if (fieldsToReveal.includes('hidden')) check(disclosed.hidden === 'withheld fixture', 'Hidden field did not decrypt')
      }
    }
  }
  runner.log({ acquisitionListed: true, selectiveDisclosure: true })
}

export async function branchDirectCertificates(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  const cases: BranchCase[] = []
  for (const keyringRevealer of ['certifier', 'subject'] as const) for (const privileged of booleans) {
    cases.push({ id: `acquireCertificate/direct/revealer-${keyringRevealer}/privileged-${privileged}`, run: async () => {
      let acquired: WalletCertificate | undefined
      try {
        const { master, args } = await makeDirectCertificate(wallet, keyringRevealer, directCertificateType, privileged)
        acquired = await wallet.acquireCertificate({ ...args, privileged, ...(privileged ? { privilegedReason: 'Test direct certificate branches' } : {}) })
        check(acquired.serialNumber === master.serialNumber && acquired.certifier === master.certifier, 'Direct acquisition changed fixture identity')
        await proveAndList(wallet, acquired, runner, privileged)
      } finally {
        if (acquired) {
          check((await wallet.relinquishCertificate({ type: acquired.type, certifier: acquired.certifier, serialNumber: acquired.serialNumber })).relinquished === true, 'Certificate cleanup failed')
          const remaining = await wallet.listCertificates({ certifiers: [acquired.certifier], types: [acquired.type], limit: 10000, privileged, ...(privileged ? { privilegedReason: 'Test direct certificate cleanup' } : {}) })
          check(!remaining.certificates.some(item => item.serialNumber === acquired.serialNumber), 'Relinquished certificate is still listed')
        }
      }
    } })
  }
  await runCases(runner, cases)
}

export async function branchIssuedCertificates(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet('deggen')) {
  await runCases(runner, booleans.map(privileged => ({ id: `acquireCertificate/issuance/privileged-${privileged}`, run: async () => {
    let acquired: WalletCertificate | undefined
    try {
      acquired = await wallet.acquireCertificate({ acquisitionProtocol: 'issuance', certifier, certifierUrl, type: Utils.toBase64(Hash.sha256(`fast branch issuance ${freshID()}`, 'utf8')), fields: { visible: 'branch fixture', hidden: 'withheld fixture' }, privileged, ...(privileged ? { privilegedReason: 'Test issuance certificate branches' } : {}) })
      check(acquired.certifier === certifier, 'Issuance returned another certifier')
      await proveAndList(wallet, acquired, runner, privileged)
    } finally {
      if (acquired) check((await wallet.relinquishCertificate({ type: acquired.type, certifier: acquired.certifier, serialNumber: acquired.serialNumber })).relinquished === true, 'Issued certificate cleanup failed')
    }
  } })))
}

export async function branchCertificateDiscovery(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  const identityKey = (await wallet.getPublicKey({ identityKey: true })).publicKey
  const cases: BranchCase[] = []
  for (const limit of [1, 10000]) for (const offset of [0, 1]) for (const seekPermission of booleans) {
    for (const byIdentity of booleans) {
      cases.push({ id: `discover/${byIdentity ? 'identity' : 'attributes'}/limit-${limit}/offset-${offset}/permission-${seekPermission}`, run: async () => {
        const result = byIdentity
          ? await wallet.discoverByIdentityKey({ identityKey, limit, offset, seekPermission })
          : await wallet.discoverByAttributes({ attributes: { visible: 'branch fixture' }, limit, offset, seekPermission })
        check(result.certificates.length <= limit && result.totalCertificates >= result.certificates.length, 'Discovery page exceeds limit or total')
      } })
    }
  }
  await runCases(runner, cases)
}
