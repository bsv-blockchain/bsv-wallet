// Card list for the Conformance panel. LOCAL file (not vendored), generated from fast's src/snippets/_data.ts at 63bd8c4:
// titles and explanations are fast's text; the group and spending split is ours (see SOURCE.md).
import { branchMetadataSequence } from './snippets/branches/metadata'
import { branchCryptoMatrix, branchLinkageMatrix } from './snippets/branches/crypto'
import { branchActionLists, branchOutputLists } from './snippets/branches/lists'
import {
  branchCertificateDiscovery,
  branchDirectCertificates,
  branchIssuedCertificates
} from './snippets/branches/certificates'
import {
  branchNoSendActions,
  branchExplicitInputs,
  branchBroadcastActions,
  branchSendWithBatches
} from './snippets/branches/actions'
import { branchInternalizeProtocols } from './snippets/branches/internalize'
import { conformanceIsAuthenticated } from './snippets/conformance/is-authenticated'
import { conformanceWaitForAuthentication } from './snippets/conformance/wait-for-authentication'
import { conformanceGetVersion } from './snippets/conformance/get-version'
import { conformanceGetNetwork } from './snippets/conformance/get-network'
import { conformanceGetHeight } from './snippets/conformance/get-height'
import { conformanceGetHeaderForHeight } from './snippets/conformance/get-header-for-height'
import { conformanceGetPublicKey } from './snippets/conformance/get-public-key'
import { conformanceRevealCounterpartyKeyLinkage } from './snippets/conformance/reveal-counterparty-key-linkage'
import { conformanceRevealSpecificKeyLinkage } from './snippets/conformance/reveal-specific-key-linkage'
import { conformanceEncrypt } from './snippets/conformance/encrypt'
import { conformanceDecrypt } from './snippets/conformance/decrypt'
import { conformanceCreateHmac } from './snippets/conformance/create-hmac'
import { conformanceVerifyHmac } from './snippets/conformance/verify-hmac'
import { conformanceCreateSignature } from './snippets/conformance/create-signature'
import { conformanceVerifySignature } from './snippets/conformance/verify-signature'
import { conformanceListActions } from './snippets/conformance/list-actions'
import { conformanceListOutputs } from './snippets/conformance/list-outputs'
import { conformanceCreateAction } from './snippets/conformance/create-action'
import { conformanceSignAction } from './snippets/conformance/sign-action'
import { conformanceAbortAction } from './snippets/conformance/abort-action'
import { conformanceInternalizeAction } from './snippets/conformance/internalize-action'
import { conformanceRelinquishOutput } from './snippets/conformance/relinquish-output'
import { conformanceListCertificates } from './snippets/conformance/list-certificates'
import { conformanceAcquireCertificate } from './snippets/conformance/acquire-certificate'
import { conformanceProveCertificate } from './snippets/conformance/prove-certificate'
import { conformanceRelinquishCertificate } from './snippets/conformance/relinquish-certificate'
import { conformanceDiscoverByIdentityKey } from './snippets/conformance/discover-by-identity-key'
import { conformanceDiscoverByAttributes } from './snippets/conformance/discover-by-attributes'
import type { SnippetRunner } from './lib/snippet-runner'

export type CardGroup = 'conformance' | 'branch' | 'funded' | 'certificate'

export interface Card {
  id: string
  title: string
  group: CardGroup
  /** What the card does (fast's explanation). */
  explanation: string
  /** Set for cards that spend or may spend real funds or fees: never part of Run all safe, and shown beside their own Run button. */
  spending?: string
  run: (runner: SnippetRunner) => Promise<void>
}

const DECLARED: Card[] = [
  {
    id: 'branchMetadataSequence',
    title: 'Authentication and chain metadata sequences',
    group: 'branch',
    explanation:
      'Check authentication before and after waiting, repeat version and network calls, and compare headers at height 1 and the current tip. Run while the wallet is locked to exercise the authentication prompt path.',
    run: branchMetadataSequence
  },
  {
    id: 'branchCryptoMatrix',
    title: 'Crypto option matrix',
    group: 'branch',
    explanation:
      '24 combinations of security level 0/1/2, omitted/self/anyone/peer counterparty, and privileged false/true. Exercise forSelf omitted/false/true, encryption reciprocity, HMAC rejection, both data and direct-hash signing/verification, and counterparty signatures verified independently with a page-owned peer.',
    run: branchCryptoMatrix
  },
  {
    id: 'branchLinkageMatrix',
    title: 'Key-linkage option matrix',
    group: 'branch',
    explanation:
      '20 cases cover counterparty linkage and specific linkage at each security level, symbolic versus explicit counterparties, and privileged access. Validate the returned identities, scope, encrypted bytes, and timestamp. Linkage is revealed only to a throwaway verifier created by this page.',
    run: branchLinkageMatrix
  },
  {
    id: 'branchActionLists',
    title: 'listActions return and query options',
    group: 'branch',
    explanation:
      '67 requests cover all valid combinations of input/output detail flags, script inclusion, label inclusion, any/all query modes, empty labels, limit 1/10000, and offset 1, permission seeking on/off, and any/all queries with one absent label. Run a funded workflow first for nonempty action fixtures.',
    run: branchActionLists
  },
  {
    id: 'branchOutputLists',
    title: 'listOutputs return and query options',
    group: 'branch',
    explanation:
      '55 requests cover omitted/locking scripts/entire transactions, all combinations of tags/labels/custom instructions, any/all tag queries, aggregate BEEF membership, positive and negative offsets, and limit 1/10000, permission seeking on/off, and any/all queries with one absent tag. Run the broadcast option matrix first to populate the dedicated fixture basket.',
    run: branchOutputLists
  },
  {
    id: 'branchCertificateDiscovery',
    title: 'Certificate discovery options',
    group: 'branch',
    explanation:
      "16 identity/attribute queries combine limit 1/10000, offset 0/1, and seekPermission true/false. These call the wallet's discovery services; unavailable services and denied permission are recorded as failures.",
    run: branchCertificateDiscovery
  },
  {
    id: 'branchNoSendActions',
    title: 'create → sign → abort option matrix',
    group: 'funded',
    explanation:
      '16 noSend cases combine signAndProcess, returnTXIDOnly, randomizeOutputs, and acceptDelayedBroadcast. Parse AtomicBEEF and check returned TXIDs. Abort each fixture in finally, including after an assertion failure.',
    spending:
      '16 noSend cases combine signAndProcess, returnTXIDOnly, randomizeOutputs, and acceptDelayedBroadcast. Parse AtomicBEEF and check returned TXIDs. Abort each fixture in finally, including after an assertion failure.',
    run: branchNoSendActions
  },
  {
    id: 'branchExplicitInputs',
    title: 'Explicit input and deferred signing sequences',
    group: 'funded',
    explanation:
      '16 noSend parent/child sequences cover a supplied unlocking script versus unlockingScriptLength/signAction, input sequence 0/max, transaction version 1/2, and lockTime 0/1. Supply inputBEEF, knownTxids, trustSelf, and noSendChange; check final script/sequence/version/lockTime and abort both actions.',
    spending:
      '16 noSend parent/child sequences cover a supplied unlocking script versus unlockingScriptLength/signAction, input sequence 0/max, transaction version 1/2, and lockTime 0/1. Supply inputBEEF, knownTxids, trustSelf, and noSendChange; check final script/sequence/version/lockTime and abort both actions.',
    run: branchExplicitInputs
  },
  {
    id: 'branchBroadcastActions',
    title: 'Broadcast option matrix — spends funds',
    group: 'funded',
    explanation:
      'Creates 16 one-satoshi fixture outputs plus transaction fees. Cover immediate/delayed broadcast, automatic/deferred signing, transaction bytes/TXID-only, and randomized/fixed output order. Keep these tagged outputs for the listOutputs matrix.',
    spending:
      'Creates 16 one-satoshi fixture outputs plus transaction fees. Cover immediate/delayed broadcast, automatic/deferred signing, transaction bytes/TXID-only, and randomized/fixed output order. Keep these tagged outputs for the listOutputs matrix.',
    run: branchBroadcastActions
  },
  {
    id: 'branchSendWithBatches',
    title: 'noSend → noSendChange → sendWith — spends funds',
    group: 'funded',
    explanation:
      "Four chained batches use prior noSendChange and knownTxids/trustSelf, then flush through createAction or signAction in immediate/delayed mode. Creates 10 one-satoshi outputs plus fees. Check every batch member's result; cleanup runs only before a broadcast attempt.",
    spending:
      "Four chained batches use prior noSendChange and knownTxids/trustSelf, then flush through createAction or signAction in immediate/delayed mode. Creates 10 one-satoshi outputs plus fees. Check every batch member's result; cleanup runs only before a broadcast attempt.",
    run: branchSendWithBatches
  },
  {
    id: 'branchInternalizeProtocols',
    title: 'Internalize payment / insertion / mixed — spends funds',
    group: 'funded',
    explanation:
      'Broadcasts three two-output fixture transactions: 6 satoshis plus fees. Exercise wallet payment and basket insertion separately and together, repeat internalization with seekPermission=false, verify no duplicate output, then relinquish only the newly inserted fixture. Payment outputs are recoverable only when their payment branch is internalized.',
    spending:
      'Broadcasts three two-output fixture transactions: 6 satoshis plus fees. Exercise wallet payment and basket insertion separately and together, repeat internalization with seekPermission=false, verify no duplicate output, then relinquish only the newly inserted fixture. Payment outputs are recoverable only when their payment branch is internalized.',
    run: branchInternalizeProtocols
  },
  {
    id: 'branchDirectCertificates',
    title: 'Direct acquisition → list → prove → relinquish',
    group: 'certificate',
    explanation:
      'Four cases combine keyringRevealer=certifier/subject with privileged false/true. Independently sign and encrypt direct certificates. Check certificate filters and pagination, full versus partial certificate descriptors, zero/one/all disclosed fields, verifier decryption, and exact-serial cleanup.',
    spending:
      'Four cases combine keyringRevealer=certifier/subject with privileged false/true. Independently sign and encrypt direct certificates. Check certificate filters and pagination, full versus partial certificate descriptors, zero/one/all disclosed fields, verifier decryption, and exact-serial cleanup.',
    run: branchDirectCertificates
  },
  {
    id: 'branchIssuedCertificates',
    title: 'Certifier issuance → list → prove → relinquish',
    group: 'certificate',
    explanation:
      'Two cases request synthetic certificates from the configured certifier with privileged false/true, exercise the same listing/disclosure branches, and relinquish only the certificate acquired in that case. Server or wallet errors are recorded without assuming they are conformance defects.',
    spending:
      'Two cases request synthetic certificates from the configured certifier with privileged false/true, exercise the same listing/disclosure branches, and relinquish only the certificate acquired in that case. Server or wallet errors are recorded without assuming they are conformance defects.',
    run: branchIssuedCertificates
  },
  {
    id: 'conformanceIsAuthenticated',
    title: 'isAuthenticated',
    group: 'conformance',
    explanation: 'Checks that the wallet reports an authenticated session.',
    run: conformanceIsAuthenticated
  },
  {
    id: 'conformanceWaitForAuthentication',
    title: 'waitForAuthentication',
    group: 'conformance',
    explanation: 'Waits until the wallet reports an authenticated session.',
    run: conformanceWaitForAuthentication
  },
  {
    id: 'conformanceGetVersion',
    title: 'getVersion',
    group: 'conformance',
    explanation: 'Checks that the version looks like vendor-major.minor.patch and is 7 to 30 bytes.',
    run: conformanceGetVersion
  },
  {
    id: 'conformanceGetNetwork',
    title: 'getNetwork',
    group: 'conformance',
    explanation: 'Checks that the wallet reports mainnet or testnet.',
    run: conformanceGetNetwork
  },
  {
    id: 'conformanceGetHeight',
    title: 'getHeight',
    group: 'conformance',
    explanation: 'Checks that the chain height is a positive integer.',
    run: conformanceGetHeight
  },
  {
    id: 'conformanceGetHeaderForHeight',
    title: 'getHeaderForHeight',
    group: 'conformance',
    explanation: "Requests the header at the wallet's current height. The header must be 80 bytes.",
    run: conformanceGetHeaderForHeight
  },
  {
    id: 'conformanceGetPublicKey',
    title: 'getPublicKey',
    group: 'conformance',
    explanation: 'Checks that the identity key is a compressed public key.',
    run: conformanceGetPublicKey
  },
  {
    id: 'conformanceRevealCounterpartyKeyLinkage',
    title: 'revealCounterpartyKeyLinkage',
    group: 'conformance',
    explanation: 'Reveals linkage for an unrelated counterparty and verifier.',
    run: conformanceRevealCounterpartyKeyLinkage
  },
  {
    id: 'conformanceRevealSpecificKeyLinkage',
    title: 'revealSpecificKeyLinkage',
    group: 'conformance',
    explanation: "Reveals linkage for this wallet's own conformance key to an unrelated verifier.",
    run: conformanceRevealSpecificKeyLinkage
  },
  {
    id: 'conformanceEncrypt',
    title: 'encrypt',
    group: 'conformance',
    explanation: 'Encrypts a short message to this wallet and checks that ciphertext comes back.',
    run: conformanceEncrypt
  },
  {
    id: 'conformanceDecrypt',
    title: 'decrypt',
    group: 'conformance',
    explanation: 'Encrypts a short message and checks that decrypt returns the same plaintext.',
    run: conformanceDecrypt
  },
  {
    id: 'conformanceCreateHmac',
    title: 'createHmac',
    group: 'conformance',
    explanation: 'Creates an HMAC over a short message. The result must be 32 bytes.',
    run: conformanceCreateHmac
  },
  {
    id: 'conformanceVerifyHmac',
    title: 'verifyHmac',
    group: 'conformance',
    explanation: 'Creates an HMAC and checks that verifyHmac accepts it.',
    run: conformanceVerifyHmac
  },
  {
    id: 'conformanceCreateSignature',
    title: 'createSignature',
    group: 'conformance',
    explanation: 'Signs a short message and checks that a signature comes back.',
    run: conformanceCreateSignature
  },
  {
    id: 'conformanceVerifySignature',
    title: 'verifySignature',
    group: 'conformance',
    explanation: 'Signs a short message and checks that verifySignature accepts it.',
    run: conformanceVerifySignature
  },
  {
    id: 'conformanceListActions',
    title: 'listActions',
    group: 'conformance',
    explanation: 'Lists actions labeled conformance. An empty list is a valid response.',
    run: conformanceListActions
  },
  {
    id: 'conformanceListOutputs',
    title: 'listOutputs',
    group: 'conformance',
    explanation: 'Lists the random basket. An empty basket is a valid response.',
    run: conformanceListOutputs
  },
  {
    id: 'conformanceCreateAction',
    title: 'createAction',
    group: 'conformance',
    explanation:
      'Creates a 1-satoshi noSend output, checks that a transaction or reference comes back, then aborts it. The wallet needs a spendable output. Nothing is broadcast.',
    run: conformanceCreateAction
  },
  {
    id: 'conformanceSignAction',
    title: 'signAction',
    group: 'conformance',
    explanation:
      'Creates a signable noSend action, signs it without spending inputs, then aborts it. Nothing is broadcast.',
    run: conformanceSignAction
  },
  {
    id: 'conformanceAbortAction',
    title: 'abortAction',
    group: 'conformance',
    explanation: 'Creates a noSend action and checks that abortAction releases it. Nothing is broadcast.',
    run: conformanceAbortAction
  },
  {
    id: 'conformanceInternalizeAction',
    title: 'internalizeAction',
    group: 'conformance',
    explanation:
      'A throwaway key on this page pays the wallet 1 satoshi. The wallet internalizes that payment. The network fee is spent, and the satoshi returns to the balance when internalization succeeds.',
    spending:
      'A throwaway key on this page pays the wallet 1 satoshi. The wallet internalizes that payment. The network fee is spent, and the satoshi returns to the balance when internalization succeeds.',
    run: conformanceInternalizeAction
  },
  {
    id: 'conformanceRelinquishOutput',
    title: 'relinquishOutput',
    group: 'conformance',
    explanation:
      'Broadcasts 1 satoshi into the conformance basket, then stops tracking that output. The satoshi is no longer spendable by the wallet.',
    spending:
      'Broadcasts 1 satoshi into the conformance basket, then stops tracking that output. The satoshi is no longer spendable by the wallet.',
    run: conformanceRelinquishOutput
  },
  {
    id: 'conformanceListCertificates',
    title: 'listCertificates',
    group: 'conformance',
    explanation: 'Lists conformance-probe certificates. An empty list is a valid response.',
    run: conformanceListCertificates
  },
  {
    id: 'conformanceAcquireCertificate',
    title: 'acquireCertificate',
    group: 'conformance',
    explanation:
      'Asks the certifier for a conformance-probe certificate. The type is the SHA-256 of that name, because a certificate type must be exactly 32 bytes.',
    spending:
      'Asks the certifier for a conformance-probe certificate. The type is the SHA-256 of that name, because a certificate type must be exactly 32 bytes.',
    run: conformanceAcquireCertificate
  },
  {
    id: 'conformanceProveCertificate',
    title: 'proveCertificate',
    group: 'conformance',
    explanation:
      'Reveals one field of a conformance-probe certificate to an unrelated verifier. Run acquireCertificate first when this card is started on its own.',
    run: conformanceProveCertificate
  },
  {
    id: 'conformanceRelinquishCertificate',
    title: 'relinquishCertificate',
    group: 'conformance',
    explanation:
      'Removes one conformance-probe certificate. Other certificates stay in the wallet. When none exists yet, this card acquires one and then removes it.',
    spending:
      'Removes one conformance-probe certificate. Other certificates stay in the wallet. When none exists yet, this card acquires one and then removes it.',
    run: conformanceRelinquishCertificate
  },
  {
    id: 'conformanceDiscoverByIdentityKey',
    title: 'discoverByIdentityKey',
    group: 'conformance',
    explanation: "Discovers certificates for this wallet's identity key. An empty list is a valid response.",
    run: conformanceDiscoverByIdentityKey
  },
  {
    id: 'conformanceDiscoverByAttributes',
    title: 'discoverByAttributes',
    group: 'conformance',
    explanation: 'Discovers certificates with the username deggen. An empty list is a valid response.',
    run: conformanceDiscoverByAttributes
  }
]

const RANK: Record<CardGroup, number> = { conformance: 0, branch: 1, funded: 2, certificate: 3 }

/** The 28 conformance cards first, then the branch matrices, funded workflows and certificate workflows. */
export const CARDS: Card[] = DECLARED.map((card, i) => ({ card, i }))
  .sort((a, b) => RANK[a.card.group] - RANK[b.card.group] || a.i - b.i)
  .map(x => x.card)

/** Cards Run all safe runs, in order: the conformance cards that do not spend, then the non-funded branch matrices. */
export const SAFE_CARDS: Card[] = CARDS.filter(c => !c.spending)
export const SPENDING_CARDS: Card[] = CARDS.filter(c => c.spending)
