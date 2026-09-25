/**
 * chainRecovery.ts unit tests — the scan/classification logic
 * (recoverVaultFromChain) against an in-memory FakeChain, independent of any
 * indexer's HTTP shape. The full clean-device I1 proof (deposit -> wipe ->
 * recover -> withdraw, with a real MockYubiKey) lives in
 * proofBar.cleanDeviceRecovery.test.ts; this file targets chainRecovery.ts's
 * own scanning contract: gap counting, found-but-unusable classification,
 * the zero-conf boundary, and spent-output handling.
 */
import { LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'

// Own AsyncStorage/SecureStore mocks, matching __tests__/vault/transfers.test.ts:
// vaultStore.ts imports both directly, and neither transforms under jest by
// default (expo-secure-store ships ESM `import` syntax).
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  ...(() => {
    const store: Record<string, string> = {}
    return {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wutdo',
      getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => { store[k] = v }),
      deleteItemAsync: jest.fn(async (k: string) => { delete store[k] }),
      __clear: () => { for (const k of Object.keys(store)) delete store[k] }
    }
  })()
}))
import {
  buildLock,
  commitment,
  encodeVaultInstructionsV7,
  type VaultInstructionKey,
  type VaultInstructionsV7
} from '../../core/services/vault/r1comb'
import {
  buildVaultDescriptorScript,
  deriveVaultMarkerScript,
  deriveVaultSalt,
  encryptVaultDescriptorPlaintext,
  vaultChainKeyId
} from '../../core/services/vault/transfers'
import {
  recoverVaultFromChain,
  VAULT_RECOVERY_GAP_DEFAULT,
  VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS,
  type VaultChainLookup
} from '../../core/services/vault/chainRecovery'
import type { VaultWallet } from '../../core/services/vault/transfers'
import { vaultStore } from '../../core/services/vault/vaultStore'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'

jest.setTimeout(60_000)

const ADMIN = 'admin.com'
const CHAIN = 'test' as const
const VAULT_ID = 'ab'.repeat(32)
const SCOPE_IDENTITY = `02${'33'.repeat(32)}`

function newMember(nickname: string, enrolledAt: number): VaultInstructionKey {
  const priv = p256.utils.randomSecretKey()
  return {
    serial: `YK-${nickname}`,
    slot: 0x82,
    pubkey: Utils.toHex(Array.from(p256.getPublicKey(priv, true))),
    nickname,
    enrolledAt
  }
}

const KEYS = [newMember('Primary', 1), newMember('Backup', 2)]

/** Build and publish (or withhold) one v7 [vault, marker, descriptor]
 * triple at index k, replicating newVaultOutput's construction directly
 * against the exported building blocks — this file's whole point is testing
 * chainRecovery.ts's SCAN logic, not re-testing output creation (transfers.test.ts
 * already does that). */
async function publishVaultTx(
  wallet: FakeVaultWallet,
  chain: FakeChain,
  k: number,
  keys: VaultInstructionKey[],
  satoshis: number,
  opts: { confirmed?: boolean } = {}
): Promise<{ txid: string; vaultOutputIndex: number }> {
  const saltKeyId = String(k)
  const salt = await deriveVaultSalt(wallet, ADMIN, saltKeyId, keys.map(key => key.serial))
  const lockingScript = buildLock({ commitments: keys.map(key => commitment(key.pubkey, salt)), saltHex64: salt })
  const v7: VaultInstructionsV7 = {
    v: 7, type: 'R1C', saltKeyId, chain: CHAIN, vaultId: VAULT_ID, revision: 1, createdAt: 1, keys
  }
  const customInstructions = encodeVaultInstructionsV7(v7)
  const markerScript = await deriveVaultMarkerScript(wallet, ADMIN, CHAIN, saltKeyId)
  const ciphertext = await encryptVaultDescriptorPlaintext(wallet, ADMIN, CHAIN, saltKeyId, customInstructions)
  const descriptorScript = buildVaultDescriptorScript(ciphertext)

  const fund = new Transaction()
  fund.addOutput({ satoshis: satoshis + 10_000, lockingScript: new P2PKH().lock(Utils.toArray('e2'.repeat(20), 'hex')) })
  const tx = new Transaction(1)
  tx.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
  tx.addOutput({ satoshis, lockingScript })
  tx.addOutput({ satoshis: 1, lockingScript: markerScript })
  tx.addOutput({ satoshis: 0, lockingScript: descriptorScript })
  tx.addOutput({ satoshis: 9_500, lockingScript: new P2PKH().lock(Utils.toArray('e3'.repeat(20), 'hex')) })

  const txid = chain.publish(tx, opts)
  return { txid, vaultOutputIndex: 0 }
}

describe('recoverVaultFromChain', () => {
  let chain: FakeChain
  let wallet: FakeVaultWallet
  const primaryKey = new PrivateKey(1234).toArray()

  beforeEach(() => {
    chain = new FakeChain()
    wallet = new FakeVaultWallet(primaryKey, chain)
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey: SCOPE_IDENTITY, chain: CHAIN })
  })

  it('finds every confirmed, unspent v7 output and stops after the gap of consecutive no-history misses', async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    await publishVaultTx(wallet, chain, 2, KEYS, 400_000)

    const result = await recoverVaultFromChain(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(2)
    expect(result.pendingConfirmation).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.scanned).toBe(2 + VAULT_RECOVERY_GAP_DEFAULT)
    expect(wallet.hasLocalVaultOutputs()).toBe(true)
  })

  it('reports zero found and scans exactly the default gap when nothing was ever deposited', async () => {
    const result = await recoverVaultFromChain(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(0)
    expect(result.pendingConfirmation).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.scanned).toBe(VAULT_RECOVERY_GAP_DEFAULT)
  })

  it('accepts a caller-raised gap to reach a deposit sitting beyond the default', async () => {
    // 25 burned indices (aborted-before-broadcast attempts never publish a
    // marker), then a real deposit at k=26 — beyond the default gap of 20.
    await publishVaultTx(wallet, chain, 26, KEYS, 250_000)

    const short = await recoverVaultFromChain(wallet, ADMIN, fakeChainLookup(chain), CHAIN, 20)
    expect(short.found).toBe(0)

    wallet.wipeLocalState() // the short scan's internalizeAction calls, if any, must not linger
    const long = await recoverVaultFromChain(wallet, ADMIN, fakeChainLookup(chain), CHAIN, 30)
    expect(long.found).toBe(1)
  })

  it('a found-but-unusable record (garbage descriptor) at one index is reported distinctly and does not stop the scan', async () => {
    // k=1: a marker with a descriptor that decrypts to garbage (wrong tag/plaintext).
    const saltKeyId = '1'
    const markerScript = await deriveVaultMarkerScript(wallet, ADMIN, CHAIN, saltKeyId)
    const garbageCiphertext = await encryptVaultDescriptorPlaintext(wallet, ADMIN, CHAIN, saltKeyId, 'not a v7 json record at all')
    const descriptorScript = buildVaultDescriptorScript(garbageCiphertext)
    const salt = await deriveVaultSalt(wallet, ADMIN, saltKeyId, KEYS.map(k => k.serial))
    const lockingScript = buildLock({ commitments: KEYS.map(k => commitment(k.pubkey, salt)), saltHex64: salt })
    const fund = new Transaction()
    fund.addOutput({ satoshis: 310_000, lockingScript: new P2PKH().lock(Utils.toArray('e4'.repeat(20), 'hex')) })
    const badTx = new Transaction(1)
    badTx.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
    badTx.addOutput({ satoshis: 300_000, lockingScript })
    badTx.addOutput({ satoshis: 1, lockingScript: markerScript })
    badTx.addOutput({ satoshis: 0, lockingScript: descriptorScript })
    chain.publish(badTx)

    // k=2: a real, usable deposit — must still be found despite k=1's garbage.
    await publishVaultTx(wallet, chain, 2, KEYS, 400_000)

    const result = await recoverVaultFromChain(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(1)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0].index).toBe(1)
    expect(result.problems[0].reason).toMatch(/invalid or non-v7/)
  })

  it('a descriptor claiming the wrong index/chain is rejected and does not stop the scan (hard-required saltKeyId/chain match)', async () => {
    // Encrypt a descriptor under index 1's key, but whose PLAINTEXT record
    // claims saltKeyId '2' — simulates a replayed/mismatched record.
    const saltKeyId = '1'
    const markerScript = await deriveVaultMarkerScript(wallet, ADMIN, CHAIN, saltKeyId)
    const salt = await deriveVaultSalt(wallet, ADMIN, saltKeyId, KEYS.map(k => k.serial))
    const lockingScript = buildLock({ commitments: KEYS.map(k => commitment(k.pubkey, salt)), saltHex64: salt })
    const mismatched: VaultInstructionsV7 = {
      v: 7, type: 'R1C', saltKeyId: '2', chain: CHAIN, vaultId: VAULT_ID, revision: 1, createdAt: 1, keys: KEYS
    }
    const ciphertext = await encryptVaultDescriptorPlaintext(wallet, ADMIN, CHAIN, saltKeyId, encodeVaultInstructionsV7(mismatched))
    const descriptorScript = buildVaultDescriptorScript(ciphertext)
    const fund = new Transaction()
    fund.addOutput({ satoshis: 310_000, lockingScript: new P2PKH().lock(Utils.toArray('e5'.repeat(20), 'hex')) })
    const tx = new Transaction(1)
    tx.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
    tx.addOutput({ satoshis: 300_000, lockingScript })
    tx.addOutput({ satoshis: 1, lockingScript: markerScript })
    tx.addOutput({ satoshis: 0, lockingScript: descriptorScript })
    chain.publish(tx)

    const result = await recoverVaultFromChain(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(0)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0].index).toBe(1)
    expect(result.problems[0].reason).toMatch(/index\/chain/)
  })

  it('an unconfirmed marker is reported as pendingConfirmation, never thrown, and does not consume a gap-scan slot', async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000, { confirmed: false })

    const result = await recoverVaultFromChain(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(0)
    expect(result.pendingConfirmation).toBe(1)
    expect(result.problems).toEqual([])
    // Not a miss: the scan still reaches the full gap window PAST index 1.
    expect(result.scanned).toBe(1 + VAULT_RECOVERY_GAP_DEFAULT)
    expect(wallet.hasLocalVaultOutputs()).toBe(false)
  })

  it('a spent vault output is silently skipped — not found, not a problem, not a miss', async () => {
    const { txid } = await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    // Simulate a later spend of the vault output (e.g. already withdrawn):
    // a spending transaction consuming outpoint txid.0.
    const spendFundingStub = chain.tx(txid)!
    const spend = new Transaction(1)
    spend.addInput({ sourceTransaction: spendFundingStub, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
    spend.addOutput({ satoshis: 1_000, lockingScript: new P2PKH().lock(Utils.toArray('e6'.repeat(20), 'hex')) })
    chain.publish(spend)

    const result = await recoverVaultFromChain(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.pendingConfirmation).toBe(0)
  })

  it('rejects a non-positive-integer gap', async () => {
    await expect(recoverVaultFromChain(wallet, ADMIN, fakeChainLookup(chain), CHAIN, 0)).rejects.toMatchObject({
      code: 'template-invalid'
    })
  })

  // Availability review (INT-01/INT-06/XQ-012): confirmed by LIVE reproduction
  // (a scratch worktree run against the pre-fix code hung indefinitely, one
  // CPU core pinned near 100%, until manually killed). Neither catch branch
  // in the scan loop touched `consecutiveMisses`, so a lookup or a wallet
  // that keeps throwing spun the `while` loop forever. These tests prove the
  // bound: both failure sources now fail LOUDLY, within a handful of
  // iterations, instead of looping.
  describe('bounded scan (INT-01/INT-06/XQ-012 — a persistently failing lookup/wallet must fail loudly, not loop forever)', () => {
    it('throws a clear error instead of looping forever when the chain lookup keeps throwing', async () => {
      const alwaysThrows: VaultChainLookup = {
        async transactionsForLockingScript(): Promise<string[]> {
          throw new Error('simulated persistent network outage')
        },
        async transactionForTxid() {
          return null
        },
        async outputStatus() {
          return 'unknown'
        }
      }

      await expect(recoverVaultFromChain(wallet, ADMIN, alwaysThrows, CHAIN)).rejects.toThrow(
        /recovery scan could not complete/i
      )
    })

    it('throws a clear error instead of looping forever when the wallet cannot derive its own marker key', async () => {
      const brokenWallet = {
        async getPublicKey(): Promise<{ publicKey: string }> {
          throw new Error('simulated wallet-layer derivation failure')
        }
      } as unknown as VaultWallet

      await expect(recoverVaultFromChain(brokenWallet, ADMIN, fakeChainLookup(chain), CHAIN)).rejects.toThrow(
        /recovery scan could not complete/i
      )
    })

    it('tolerates an occasional transient failure without aborting — only a PERSISTENT run does', async () => {
      // One glitch every VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS - 1 calls
      // never accumulates to the abort threshold, because a successful call
      // (even a miss) resets the streak.
      let calls = 0
      const occasionallyThrows: VaultChainLookup = {
        async transactionsForLockingScript(): Promise<string[]> {
          calls++
          if (calls % (VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS - 1) === 0) {
            throw new Error('simulated transient hiccup')
          }
          return []
        },
        async transactionForTxid() {
          return null
        },
        async outputStatus() {
          return 'unknown'
        }
      }

      const result = await recoverVaultFromChain(wallet, ADMIN, occasionallyThrows, CHAIN)
      expect(result.found).toBe(0)
      expect(result.problems.length).toBeGreaterThan(0)
    })
  })

  // Regression lens (griefing): once a marker address is on-chain, a stranger
  // can pay it dust indefinitely. Without a cap, a single scan index could be
  // forced to inspect an unbounded number of candidates.
  it('caps how many candidates one scan index inspects', async () => {
    let markerCalls = 0
    let candidateCalls = 0
    const manyCandidates: VaultChainLookup = {
      async transactionsForLockingScript(): Promise<string[]> {
        markerCalls++
        // Only the FIRST index (the "real" one an attacker could target) has
        // any history; every later index is a genuine, ordinary miss — a
        // stranger cannot invent marker addresses for indices whose keys
        // they never derived.
        if (markerCalls > 1) return []
        return Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(64, '0'))
      },
      async transactionForTxid() {
        candidateCalls++
        return null // "no transaction bytes available" -> a reported problem
      },
      async outputStatus() {
        return 'unknown'
      }
    }

    const result = await recoverVaultFromChain(wallet, ADMIN, manyCandidates, CHAIN)
    expect(candidateCalls).toBeGreaterThan(0)
    expect(candidateCalls).toBeLessThan(500)
    expect(result.found).toBe(0)
  })
})
