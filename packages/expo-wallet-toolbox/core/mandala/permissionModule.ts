/**
 * MandalaTokenModule — the `WalletPermissionsManager` P-module for the
 * `'p mandala'` basket (schemeID `'mandala'`).
 *
 * Mirrors `@bsv/btms-permission-module`'s `BasicTokenModule` shape and file
 * organization exactly (admin pass-through, a 60s session-authorization
 * cache keyed by originator, a JSON-encoded prompt message, a generic
 * fallback that never throws on a decode failure) — but decodes Mandala's
 * own script layout, `<36B assetId><scriptnum amount> OP_2DROP <P2PKH tail>`,
 * via `MandalaToken.decode` from `@bsv/templates`, NOT BTMS's `PushDrop.decode`:
 * the two token formats are unrelated.
 *
 * There is no Mandala equivalent of BTMS's `createSignature`/preimage-binding
 * layer: Mandala's FT protocol (`[2, 'mandala token']`) is not `'p '`-prefixed
 * (renaming it would touch every derivation in the blinding scheme — far too
 * invasive, see offline-settlement-final.md §8.2), so `createSignature` is
 * never routed through this module. Basket-gating alone is the whole gate.
 *
 * Source of truth: offline-settlement-final.md §8.3, plus a set of
 * adversarial-review findings closed here (see the inline notes tagged
 * "adversarial-review finding" throughout this file):
 *  1. [critical] listOutputs no longer lets a paired app read back
 *     `customInstructions` (keyID/counterparty/blinding derivation data).
 *  2. [medium/high] createAction that only SPENDS `'p mandala'` INPUTS (no
 *     basketed change output) is now gated too — see `anyInputIsTokenCoin`
 *     and the `wrapCreateActionForTokenInputs` wrapper below.
 *  3. [medium] listActions is now routed the same as listOutputs.
 *  4. [medium] Prompt amounts are grouped by assetId and decimal-formatted.
 *  5. [low] relinquishOutput is its own authorization class.
 */
import { LockingScript, Transaction } from '@bsv/sdk'
import type { PermissionsModule } from '@bsv/wallet-toolbox-mobile'
import { MandalaToken } from '@bsv/templates'
import { MANDALA_BASKET } from './types'

const SESSION_TIMEOUT_MS = 60_000
const SESSION_CLEANUP_INTERVAL_MS = 30_000

export interface MandalaAssetMetadata {
  label?: string
  ticker?: string
  /** Base-10 display decimals (e.g. 2 for cents-style tokens). Absent/non-numeric
   * means "unknown" — every amount display falls back to raw base units. */
  decimals?: number
}

export interface MandalaTokenModuleDeps {
  /** Our own app's originator — calls carrying it pass through with zero prompts. */
  adminOriginator: string
  /** Same shape as BTMS's requestTokenAccess: app id + JSON message -> approved? */
  requestTokenAccess: (app: string, message: string) => Promise<boolean>
  /** Optional friendly name/ticker/decimals for the prompt copy. Never gates anything —
   * a throwing or null-returning resolver just means the raw assetId (in base units) is shown. */
  resolveAssetMetadata: (assetId: string) => Promise<MandalaAssetMetadata | null>
  /**
   * Adversarial-review finding (2): every outpoint (`'txid.vout'`) this
   * wallet currently holds in `MANDALA_BASKET`, via the admin-originator
   * wallet's own `listOutputs({basket: MANDALA_BASKET, ...})` — i.e. a call
   * that itself passes through this module with zero prompts (see the
   * admin pass-through branch in `onRequest`). Used to detect a
   * `createAction` that spends token coins purely through `inputs`, which
   * `WalletPermissionsManager`'s basket-routing (keyed on OUTPUTS only,
   * `collectNonPBaskets`) would otherwise miss entirely. A throwing
   * implementation is treated as "no token inputs found" — this dep can
   * only ever ADD a prompt, never remove one that would otherwise fire from
   * the output-side checks, so a fault here fails toward "no extra info",
   * not toward "silently allow".
   */
  listTokenOutpoints: () => Promise<Set<string>>
}

/** The slice of `CreateActionOutput` this module reads. Structural, not the
 * full SDK type, so a test can pass a plain object. */
interface MandalaCreateActionOutputLike {
  lockingScript?: string
  basket?: string
}
/** The slice of `CreateActionInput` this module reads. */
interface MandalaCreateActionInputLike {
  outpoint?: string
}
interface MandalaCreateActionArgsLike {
  outputs?: MandalaCreateActionOutputLike[]
  inputs?: MandalaCreateActionInputLike[]
}

interface MandalaInternalizeOutputLike {
  outputIndex: number
  protocol?: string
  insertionRemittance?: { basket?: string }
}
interface MandalaInternalizeActionArgsLike {
  /** AtomicBEEF — the SDK type allows either representation; both feed
   * `Transaction.fromAtomicBEEF` directly. */
  tx?: number[] | Uint8Array
  outputs?: MandalaInternalizeOutputLike[]
}

/** The slice of `ListOutputsArgs` this module reads/rewrites. */
interface MandalaListOutputsArgsLike {
  basket?: string
  includeCustomInstructions?: boolean
  [key: string]: unknown
}

interface DecodedMandalaOutput {
  assetId: string
  amount: number
}

/** One asset's send/change totals for a createAction spend prompt. */
export interface MandalaSpendLine {
  assetId: string
  sendAmount: number
  changeAmount: number
  tokenName?: string
  decimals?: number
  /** Decimal-formatted, e.g. "25.00 USDX"; base units + a short assetId when
   * decimals could not be resolved. */
  display: string
}

/** One asset's credited total for an internalizeAction credit prompt. */
export interface MandalaCreditLine {
  assetId: string
  creditAmount: number
  tokenName?: string
  decimals?: number
  display: string
}

/**
 * Decodes one output's locking script as a Mandala token. Never throws:
 * `MandalaToken.decode` throws on anything that isn't its exact 8-chunk
 * shape, and every caller here treats "not a Mandala output" the same way
 * whether the script is empty, foreign, or simply malformed.
 */
function tryDecodeMandalaOutput(lockingScriptHex: string | undefined): DecodedMandalaOutput | null {
  if (!lockingScriptHex) return null
  try {
    const script = LockingScript.fromHex(lockingScriptHex)
    const decoded = MandalaToken.decode(script)
    return { assetId: decoded.assetId, amount: decoded.amount }
  } catch {
    return null
  }
}

/** A short, human-scannable form of a long `'<64-hex>.<vout>'` assetId. */
function shortAssetId(assetId: string): string {
  if (!assetId || assetId.length <= 16) return assetId
  return `${assetId.slice(0, 8)}…${assetId.slice(-6)}`
}

/**
 * "25.00 USDX" when decimals are known (clamped to a sane 0-18 range,
 * mirroring common token-decimals conventions); "2500000 a1b2c3d4…ef01.0"
 * (raw base units + a short assetId form) when they are not — adversarial-
 * review finding (4): never show raw base units next to a resolved ticker,
 * and never guess a decimals value we were not actually given.
 */
function formatTokenAmount(
  baseUnits: number,
  decimals: number | undefined,
  tokenName: string | undefined,
  assetId: string
): string {
  if (typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18) {
    const scaled = baseUnits / 10 ** decimals
    const unit = tokenName || shortAssetId(assetId)
    return `${scaled.toFixed(decimals)} ${unit}`
  }
  return `${baseUnits} ${shortAssetId(assetId)}`
}

/**
 * Adversarial-review finding (2): the P-label `WalletPermissionsManager`'s
 * `listActions`/`createAction` label-routing keys on. Two independent uses:
 *  - `wrapCreateActionForTokenInputs` (below) injects it onto a createAction
 *    call whose INPUTS spend `'p mandala'` coins but whose outputs carry no
 *    `'p mandala'`-basket output — the manager's own basket-only routing
 *    would otherwise never call `onRequest` for such a call at all.
 *  - It also then persists as a real label on the resulting action, so it
 *    doubles as the "Mandala action" label finding (3) calls for: apps that
 *    build Mandala createAction calls directly (rather than through the
 *    wrapper) should add this same label so `listActions({labels:[...]})`
 *    P-routes to this module too — label-routing is `listActions`' ONLY
 *    signal, `MANDALA_BASKET` alone does not make a listActions call route
 *    here. This module cannot enforce that from inside `onRequest` (it never
 *    sees the call before the manager decides whether to route it at all);
 *    it is a wiring requirement on every Mandala action-creation call site.
 */
export const MANDALA_ACTION_LABEL = 'p mandala token-spend'

export class MandalaTokenModule implements PermissionsModule {
  private readonly deps: MandalaTokenModuleDeps

  /**
   * Session-authorization cache — same shape as BasicTokenModule's: a
   * time-limited (60s) grant per originator, refreshed by every prompt this
   * module shows (spend/credit/access alike), consulted only by the
   * once-per-session access checks (`listOutputs`/`listActions`).
   * `relinquishOutput` deliberately does NOT read or write this cache —
   * adversarial-review finding (5): it is its own authorization class.
   */
  private readonly sessionAuthorizations: Map<string, number> = new Map()
  private readonly cleanupTimer: ReturnType<typeof setInterval>

  constructor(deps: MandalaTokenModuleDeps) {
    if (!deps || typeof deps.requestTokenAccess !== 'function') {
      throw new Error('requestTokenAccess callback is required')
    }
    if (!deps.adminOriginator || typeof deps.adminOriginator !== 'string') {
      throw new Error('adminOriginator is required')
    }
    this.deps = deps
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), SESSION_CLEANUP_INTERVAL_MS)
    // Never keep a test runner or RN's timer host alive just for this sweep.
    ;(this.cleanupTimer as unknown as { unref?: () => void }).unref?.()
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now()
    for (const [originator, timestamp] of this.sessionAuthorizations.entries()) {
      if (now - timestamp > SESSION_TIMEOUT_MS) {
        this.sessionAuthorizations.delete(originator)
      }
    }
  }

  private hasSessionAuthorization(originator: string): boolean {
    const timestamp = this.sessionAuthorizations.get(originator)
    if (!timestamp) return false
    if (Date.now() - timestamp > SESSION_TIMEOUT_MS) {
      this.sessionAuthorizations.delete(originator)
      return false
    }
    return true
  }

  private grantSessionAuthorization(originator: string): void {
    this.sessionAuthorizations.set(originator, Date.now())
  }

  /**
   * THE ONLY MANDALA-SPECIFIC LINE (per spec §8.3): our own app's lib calls
   * always carry `adminOriginator` (the wallet's `withAdminOriginator`
   * wrapper) — auto-approve them with no prompt, preserving "no review
   * screen, the CTA is the confirmation". Everyone else is a paired external
   * caller and is prompted, exactly like BTMS.
   */
  async onRequest(req: { method: string; args: object; originator: string }): Promise<{ args: object }> {
    const { method, args, originator } = req

    if (!method || typeof method !== 'string') throw new Error('Invalid method')
    if (!originator || typeof originator !== 'string') throw new Error('Invalid originator')
    if (!args || typeof args !== 'object') throw new Error('Invalid args')

    if (originator === this.deps.adminOriginator) {
      return { args }
    }

    switch (method) {
      case 'listOutputs': {
        await this.promptOnceForAccess(originator, 'listOutputs')
        // Adversarial-review finding (1): WalletPermissionsManager forwards
        // the ARGS THIS METHOD RETURNS to the underlying listOutputs call
        // (delegateToPModuleIfNeeded), so redacting here genuinely prevents
        // the underlying wallet from ever including customInstructions in
        // its response — this is not merely filtering our own mirror of it
        // afterward, which would be too late for a caller that reads the
        // result directly.
        return { args: this.redactListOutputsArgs(args as MandalaListOutputsArgsLike) }
      }
      case 'listActions':
        // Adversarial-review finding (3): same once-per-session gate as
        // listOutputs. Reaching this handler at all depends on the calling
        // action carrying a 'p mandala ...' label — see MANDALA_ACTION_LABEL's
        // doc above.
        await this.promptOnceForAccess(originator, 'listActions')
        break
      case 'relinquishOutput':
        await this.promptForRelinquish(originator)
        break
      case 'createAction':
        await this.promptForSpend(args as MandalaCreateActionArgsLike, originator)
        break
      case 'internalizeAction':
        await this.promptForCredit(args as MandalaInternalizeActionArgsLike, originator)
        break
      default:
        // No other method is ever routed here (basket-gating only covers
        // these five) — pass through defensively rather than throw on a
        // future manager version that adds one.
        break
    }

    return { args }
  }

  /**
   * Mandala tokens carry no post-hoc metadata to redact and there is no
   * preimage-binding layer here (createSignature is not P-routed for this
   * protocol, see the class doc) — the response passes through unchanged.
   */
  async onResponse(res: unknown, _context: { method: string; originator: string }): Promise<unknown> {
    return res
  }

  /** listOutputs / listActions — once per 60s session, like BTMS's promptForBTMSAccess. */
  private async promptOnceForAccess(originator: string, action: 'listOutputs' | 'listActions'): Promise<void> {
    if (this.hasSessionAuthorization(originator)) return

    const message = JSON.stringify({ type: 'mandala_access', action })
    const approved = await this.deps.requestTokenAccess(originator, message)
    if (!approved) {
      throw new Error('User denied permission to access Mandala tokens')
    }
    this.grantSessionAuthorization(originator)
  }

  /**
   * Adversarial-review finding (5): relinquishOutput is its own
   * authorization class. It is never satisfied by an existing
   * spend/credit/access session (no `hasSessionAuthorization` check), and it
   * never grants one either (no `grantSessionAuthorization` call) — removing
   * a holding from the wallet is consequential enough that every call must
   * show its own prompt, and approving it must not silently unlock
   * listOutputs/listActions for the rest of the session window.
   */
  private async promptForRelinquish(originator: string): Promise<void> {
    const message = JSON.stringify({ type: 'mandala_access', action: 'relinquishOutput' })
    const approved = await this.deps.requestTokenAccess(originator, message)
    if (!approved) {
      throw new Error('User denied permission to access Mandala tokens')
    }
  }

  /**
   * Forces `includeCustomInstructions` off regardless of what the caller
   * asked for. `customInstructions` is where a Mandala coin's `keyID`/
   * `counterparty`/blinding derivation lives (see the module doc) — a paired
   * app has no legitimate use for it, and no other `ListOutputsArgs` field
   * exposes anything equivalent.
   */
  private redactListOutputsArgs(args: MandalaListOutputsArgsLike): MandalaListOutputsArgsLike {
    return { ...args, includeCustomInstructions: false }
  }

  /**
   * createAction with an output in `'p mandala'` — always prompts (mirrors
   * BTMS's `handleCreateAction`, which never skips on an existing session;
   * only the access checks above do that), then refreshes the session so a
   * following listOutputs/listActions within the window does not re-prompt.
   *
   * Adversarial-review finding (2): also gates on INPUTS. Basket-routing
   * only ever reaches this method via a `'p mandala'`-basketed/decodable
   * OUTPUT (see `extractOutputAmountsByAsset`) or the `MANDALA_ACTION_LABEL`
   * the `wrapCreateActionForTokenInputs` wrapper injects — a spend with no
   * such output (e.g. a full-balance spend with no change) could otherwise
   * decode to zero here even once routed. `anyInputIsTokenCoin` is a second,
   * independent signal so this method still emits a `'mandala_spend'`
   * prompt (never the fully-generic fallback) whenever any input is a known
   * token coin, even if no output tells us how much.
   */
  private async promptForSpend(args: MandalaCreateActionArgsLike, originator: string): Promise<void> {
    const totals = this.extractOutputAmountsByAsset(args?.outputs)

    if (totals.size === 0 && !(await this.anyInputIsTokenCoin(args?.inputs))) {
      // Nothing decodable (every output failed to decode, or none present)
      // and no input is a known token coin either — fall back to a generic
      // prompt rather than guessing. Mirrors BasicTokenModule's
      // promptForGenericAuthorization fallback.
      await this.promptGeneric(originator, 'spend')
      return
    }

    const lines = await this.buildSpendLines(totals)
    // Back-compat top-level fields mirror the FIRST/primary asset (today's
    // single-asset behavior, unchanged); `lines` carries the full,
    // decimal-formatted, one-entry-per-asset breakdown (finding 4).
    // `JSON.stringify` drops `undefined` values, so an empty `lines` array
    // (token-input-only, nothing decodable) naturally omits them.
    const primary = lines[0]
    const message = JSON.stringify({
      type: 'mandala_spend',
      sendAmount: primary?.sendAmount,
      changeAmount: primary?.changeAmount,
      assetId: primary?.assetId,
      tokenName: primary?.tokenName,
      lines
    })
    const approved = await this.deps.requestTokenAccess(originator, message)
    if (!approved) {
      // Exact BTMS wording (spec §8.6): denial "throws the same shape as
      // BTMS ('User denied permission to spend tokens')".
      throw new Error('User denied permission to spend tokens')
    }
    this.grantSessionAuthorization(originator)
  }

  /** internalizeAction inserting into `'p mandala'` — an app crediting ITSELF. */
  private async promptForCredit(args: MandalaInternalizeActionArgsLike, originator: string): Promise<void> {
    const insertions = (args?.outputs ?? []).filter(
      o => o?.protocol === 'basket insertion' && o?.insertionRemittance?.basket === MANDALA_BASKET
    )

    const totals = new Map<string, number>()
    if (insertions.length > 0 && args?.tx) {
      try {
        const tx = Transaction.fromAtomicBEEF(args.tx)
        for (const insertion of insertions) {
          const output = tx.outputs[insertion.outputIndex]
          const decoded = output?.lockingScript ? tryDecodeMandalaOutput(output.lockingScript.toHex()) : null
          if (decoded) {
            totals.set(decoded.assetId, (totals.get(decoded.assetId) ?? 0) + decoded.amount)
          }
        }
      } catch {
        // Unparseable AtomicBEEF -- fall through to the zero-amount branch
        // below rather than throw; a decode failure is never fatal here.
      }
    }

    if (totals.size === 0) {
      await this.promptGeneric(originator, 'credit')
      return
    }

    const lines = await this.buildCreditLines(totals)
    const primary = lines[0]
    const message = JSON.stringify({
      type: 'mandala_credit',
      creditAmount: primary?.creditAmount,
      assetId: primary?.assetId,
      tokenName: primary?.tokenName,
      lines
    })
    const approved = await this.deps.requestTokenAccess(originator, message)
    if (!approved) {
      throw new Error('User denied permission to credit Mandala tokens')
    }
    this.grantSessionAuthorization(originator)
  }

  private async promptGeneric(originator: string, context: 'spend' | 'credit'): Promise<void> {
    const message = JSON.stringify({ type: 'mandala_generic', context })
    const approved = await this.deps.requestTokenAccess(originator, message)
    if (!approved) {
      throw new Error('User denied permission to spend Mandala tokens')
    }
    this.grantSessionAuthorization(originator)
  }

  /**
   * Sums send vs. change over every Mandala-decodable output, GROUPED BY
   * assetId (adversarial-review finding 4 — a createAction touching more
   * than one asset previously collapsed every asset's amounts into one
   * running total under whichever assetId was seen first). An output that
   * carries the `'p mandala'` basket is change (stays with us); one that
   * does not is the recipient's (Mandala payer outputs are never basketed).
   * A script that fails to decode is silently skipped, not fatal —
   * `tryDecodeMandalaOutput` never throws.
   */
  private extractOutputAmountsByAsset(
    outputs: MandalaCreateActionOutputLike[] | undefined
  ): Map<string, { sendAmount: number; changeAmount: number }> {
    const totals = new Map<string, { sendAmount: number; changeAmount: number }>()

    for (const output of outputs ?? []) {
      const decoded = tryDecodeMandalaOutput(output?.lockingScript)
      if (!decoded) continue
      const entry = totals.get(decoded.assetId) ?? { sendAmount: 0, changeAmount: 0 }
      if (output.basket === MANDALA_BASKET) {
        entry.changeAmount += decoded.amount
      } else {
        entry.sendAmount += decoded.amount
      }
      totals.set(decoded.assetId, entry)
    }

    return totals
  }

  /**
   * Adversarial-review finding (2): resolves each input outpoint against
   * `deps.listTokenOutpoints()` (the admin-originator wallet's own
   * `'p mandala'`-basket listing) and reports whether any of them is a
   * token coin this wallet holds. A throwing/failing `listTokenOutpoints`
   * is treated as "no token inputs found" — this is a pure ADD-a-prompt
   * signal on top of the output-side checks, so failing open here never
   * removes a prompt the output side would otherwise have shown.
   */
  private async anyInputIsTokenCoin(inputs: MandalaCreateActionInputLike[] | undefined): Promise<boolean> {
    if (!inputs || inputs.length === 0) return false
    let tokenOutpoints: Set<string>
    try {
      tokenOutpoints = await this.deps.listTokenOutpoints()
    } catch {
      return false
    }
    return inputs.some(input => !!input?.outpoint && tokenOutpoints.has(input.outpoint))
  }

  private async buildSpendLines(
    totals: Map<string, { sendAmount: number; changeAmount: number }>
  ): Promise<MandalaSpendLine[]> {
    const lines: MandalaSpendLine[] = []
    for (const [assetId, { sendAmount, changeAmount }] of totals) {
      const { tokenName, decimals } = await this.resolveAssetDisplay(assetId)
      lines.push({
        assetId,
        sendAmount,
        changeAmount,
        tokenName,
        decimals,
        display: formatTokenAmount(sendAmount, decimals, tokenName, assetId)
      })
    }
    return lines
  }

  private async buildCreditLines(totals: Map<string, number>): Promise<MandalaCreditLine[]> {
    const lines: MandalaCreditLine[] = []
    for (const [assetId, creditAmount] of totals) {
      const { tokenName, decimals } = await this.resolveAssetDisplay(assetId)
      lines.push({
        assetId,
        creditAmount,
        tokenName,
        decimals,
        display: formatTokenAmount(creditAmount, decimals, tokenName, assetId)
      })
    }
    return lines
  }

  private async resolveAssetDisplay(assetId: string | undefined): Promise<{ tokenName?: string; decimals?: number }> {
    if (!assetId) return {}
    try {
      const meta = await this.deps.resolveAssetMetadata(assetId)
      return {
        tokenName: meta?.ticker || meta?.label || undefined,
        decimals: typeof meta?.decimals === 'number' ? meta.decimals : undefined
      }
    } catch {
      // resolveAssetMetadata is caller-injected and may be a stub or may
      // fail (network, missing registry entry) — never let that block or
      // fail a permission prompt; the assetId alone is still shown.
      return {}
    }
  }
}

/**
 * Adversarial-review finding (2), second half: `WalletPermissionsManager`
 * only ever routes a `createAction` call through a P-module when the call's
 * OUTPUTS or LABELS name a `'p '`-scheme (`collectNonPBaskets`/
 * `splitLabelsByPermissionModule`, confirmed against
 * `@bsv/wallet-toolbox-mobile`'s `WalletPermissionsManager.js`) — INPUTS are
 * never scanned. A createAction that spends `'p mandala'` inputs with no
 * basketed/decodable Mandala output (e.g. a full-balance spend with no
 * change) therefore never reaches `MandalaTokenModule.onRequest` at all, no
 * matter what that method does internally.
 *
 * This wraps the PUBLISHED `WalletPermissionsManager` (or anything
 * shaped like it) so that a `createAction` call whose inputs reference a
 * known `'p mandala'` outpoint gets `MANDALA_ACTION_LABEL` injected into its
 * `labels` BEFORE the manager's own routing decision runs — which makes the
 * manager's label-routing pick up the module exactly as if the caller had
 * labeled the action itself (see `MANDALA_ACTION_LABEL`'s doc). Every other
 * method/property passes through untouched. `adminOriginator` calls are
 * short-circuited with zero work: the module already grants those a
 * zero-prompt pass-through unconditionally (see the class doc), so injecting
 * the label there would only add a `listTokenOutpoints()` round-trip to
 * EVERY admin createAction call — including the app's own everyday,
 * non-Mandala spends — for no gating benefit at all.
 *
 * WIRING: wrap the RAW `permissionsManager` with this FIRST, THEN apply
 * `guardVaultAccess` around the result — never the other way around.
 * `guardVaultAccess` has its own idempotent-re-wrap dedup
 * (`GUARD_TARGETS`/`GUARDED_PROXIES` in `services/vault/guard.ts`), which
 * several screens rely on (`guardVaultAccess(managers.permissionsManager,
 * ADMIN_ORIGINATOR)` again in e.g. `PairScreen.tsx`/`ConnectionsScreen.tsx`)
 * to avoid creating a second, unsynchronized guard runtime around the same
 * wallet. That dedup only recognizes an object IT previously wrapped —
 * putting this wrapper's Proxy on the OUTSIDE (wrapping an already-guarded
 * manager) would make every such re-application invisible to the dedup and
 * silently double-guard the wallet, splitting its single-flight queue in
 * two. Wrapping the raw manager first, then guarding the result, keeps the
 * publicly published value exactly what `guardVaultAccess` itself produced
 * and expects to see again — in this app that is `WalletContext.tsx`'s
 * `newManagers.permissionsManager = guardVaultAccess(
 * wrapCreateActionForTokenInputs(permissionsManager, listMandalaTokenOutpoints,
 * adminOriginator), adminOriginator)`. A manager constructed anywhere else
 * (a test double, a future second entry point) that skips this wrapper
 * reopens exactly the gap described above.
 */
export function wrapCreateActionForTokenInputs<T extends { createAction: (args: any, originator: string) => Promise<unknown> }>(
  manager: T,
  listTokenOutpoints: () => Promise<Set<string>>,
  adminOriginator?: string
): T {
  return new Proxy(manager, {
    get(target, prop, receiver) {
      if (prop === 'createAction') {
        return async (args: MandalaCreateActionArgsLike & { labels?: string[] }, originator: string) => {
          const routedArgs =
            originator === adminOriginator ? args : await injectMandalaLabelIfTokenInputsPresent(args, listTokenOutpoints)
          return target.createAction(routedArgs, originator)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as T
}

async function injectMandalaLabelIfTokenInputsPresent(
  args: MandalaCreateActionArgsLike & { labels?: string[] },
  listTokenOutpoints: () => Promise<Set<string>>
): Promise<MandalaCreateActionArgsLike & { labels?: string[] }> {
  const inputs = args?.inputs
  if (!Array.isArray(inputs) || inputs.length === 0) return args

  let tokenOutpoints: Set<string>
  try {
    tokenOutpoints = await listTokenOutpoints()
  } catch {
    // Never block a createAction call on a listing fault — the module's own
    // input check (if routing happens to fire some other way) and the
    // output-side gate remain the backstop.
    return args
  }

  const spendsTokenInput = inputs.some(input => !!input?.outpoint && tokenOutpoints.has(input.outpoint))
  if (!spendsTokenInput) return args

  const labels = Array.isArray(args.labels) ? args.labels : []
  if (labels.includes(MANDALA_ACTION_LABEL)) return args
  return { ...args, labels: [...labels, MANDALA_ACTION_LABEL] }
}
