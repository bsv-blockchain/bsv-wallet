// @ts-nocheck
import { Hash, PrivateKey, ProtoWallet, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import type { SnippetRunner } from '../../lib/snippet-runner'
import { check, checkBytes, checkPublicKey, expectWalletError, reliabilityWallet, sameBytes } from '../reliability/support'
import { booleans, runCases, type BranchCase } from './support'

export async function branchCryptoMatrix(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  const peer = new ProtoWallet(PrivateKey.fromRandom())
  const peerIdentity = (await peer.getPublicKey({ identityKey: true })).publicKey
  const publicPeer = new ProtoWallet(new PrivateKey(1))
  const cases: BranchCase[] = []
  for (const level of [0, 1, 2] as const) for (const privileged of booleans) {
    for (const counterparty of [undefined, 'self', 'anyone', peerIdentity]) {
      const protocolID: WalletProtocol = [level, 'fast branch crypto']
      const args = { protocolID, keyID: 'branch probe', counterparty, privileged, ...(privileged ? { privilegedReason: 'Test privileged crypto branches' } : {}) }
      const id = `crypto/level-${level}/${counterparty === undefined ? 'default' : counterparty === peerIdentity ? 'peer' : counterparty}/privileged-${privileged}`
      cases.push({ id, run: async () => {
        for (const forSelf of [undefined, false, true]) {
          const first = await wallet.getPublicKey({ ...args, forSelf })
          checkPublicKey(first.publicKey)
          check(first.publicKey === (await wallet.getPublicKey({ ...args, forSelf })).publicKey, 'Derived key changed')
        }
        const data = [0, 1, 128, 255]
        const encrypted = await wallet.encrypt({ ...args, plaintext: data })
        checkBytes(encrypted.ciphertext, 'ciphertext')
        check(sameBytes((await wallet.decrypt({ ...args, ciphertext: encrypted.ciphertext })).plaintext, data), 'Local decryption changed bytes')
        const hmac = (await wallet.createHmac({ ...args, data })).hmac
        check((await wallet.verifyHmac({ ...args, data, hmac })).valid === true, 'HMAC verification failed')
        await expectWalletError(() => wallet.verifyHmac({ ...args, data: [1, ...data.slice(1)], hmac }), ['ERR_INVALID_HMAC', 3], ['HMAC is not valid'])
        const hash = Hash.sha256(data)
        for (const direct of booleans) {
          const signed = await wallet.createSignature({ ...args, ...(direct ? { hashToDirectlySign: hash } : { data }) })
          for (const directVerify of booleans) {
            check((await wallet.verifySignature({ ...args, signature: signed.signature, counterparty: counterparty ?? 'anyone', forSelf: true, ...(directVerify ? { hashToDirectlyVerify: hash } : { data }) })).valid === true, 'Signature verification branch failed')
          }
        }
        // Reciprocal peer operations independently check forSelf=false and
        // counterparty key orientation rather than trusting a local round trip.
        const other = counterparty === peerIdentity ? peer : counterparty === 'anyone' ? publicPeer : undefined
        if (other) {
          const identity = (await wallet.getPublicKey({ identityKey: true, privileged, ...(privileged ? { privilegedReason: 'Test privileged crypto branches' } : {}) })).publicKey
          const reciprocal = { protocolID, keyID: args.keyID, counterparty: identity }
          check(sameBytes((await other.decrypt({ ...reciprocal, ciphertext: encrypted.ciphertext })).plaintext, data), 'Peer could not decrypt')
          check((await other.verifyHmac({ ...reciprocal, data, hmac })).valid === true, 'Peer could not verify HMAC')
          const signed = await other.createSignature({ ...reciprocal, data })
          for (const forSelf of [undefined, false]) {
            check((await wallet.verifySignature({ ...args, data, signature: signed.signature, forSelf })).valid === true, 'Counterparty signature orientation failed')
          }
        }
      } })
    }
  }
  await runCases(runner, cases)
}

export async function branchLinkageMatrix(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  // All counterparties/verifiers are throwaway keys created by this page.
  const counterparty = PrivateKey.fromRandom().toPublicKey().toString()
  const verifier = PrivateKey.fromRandom().toPublicKey().toString()
  const cases: BranchCase[] = []
  for (const privileged of booleans) {
    const privilege = { privileged, ...(privileged ? { privilegedReason: 'Test privileged linkage branches' } : {}) }
    cases.push({ id: `linkage/counterparty/privileged-${privileged}`, run: async () => {
      const identity = (await wallet.getPublicKey({ identityKey: true, ...privilege })).publicKey
      const result = await wallet.revealCounterpartyKeyLinkage({ counterparty, verifier, ...privilege })
      check(result.prover === identity && result.verifier === verifier && result.counterparty === counterparty, 'Counterparty linkage identities changed')
      checkBytes(result.encryptedLinkage, 'linkage')
      checkBytes(result.encryptedLinkageProof, 'linkage proof')
      check(Number.isFinite(Date.parse(result.revelationTime)), 'Invalid revelation time')
    } })
    for (const level of [0, 1, 2] as const) for (const party of ['self', 'anyone', counterparty]) {
      cases.push({ id: `linkage/specific/level-${level}/${party === counterparty ? 'peer' : party}/privileged-${privileged}`, run: async () => {
        const identity = (await wallet.getPublicKey({ identityKey: true, ...privilege })).publicKey
        const protocolID: WalletProtocol = [level, 'fast branch linkage']
        const result = await wallet.revealSpecificKeyLinkage({ counterparty: party, verifier, protocolID, keyID: 'branch probe', ...privilege })
        const expected = party === 'self' ? identity : party === 'anyone' ? new PrivateKey(1).toPublicKey().toString() : counterparty
        check(result.prover === identity && result.verifier === verifier && result.counterparty === expected, 'Specific linkage identities changed')
        check(JSON.stringify(result.protocolID) === JSON.stringify(protocolID) && result.keyID === 'branch probe', 'Specific linkage scope changed')
        checkBytes(result.encryptedLinkage, 'linkage')
        checkBytes(result.encryptedLinkageProof, 'linkage proof')
      } })
    }
  }
  await runCases(runner, cases)
}
