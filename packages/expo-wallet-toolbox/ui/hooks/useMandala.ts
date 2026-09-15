/**
 * `useMandala()` — the UI's only door to stablecoins.
 *
 * Everything token-shaped on a screen (a balance row, a picker option, an
 * activity status, a refusal sentence) comes from `MandalaRuntime` and nothing
 * else: the UI never talks to the overlay, the lib or the settlement tables
 * directly, so failure copy, journalling and state stay in one place
 * (core/mandala/runtime.ts's own design rule).
 *
 * The runtime is built by the wallet's own wiring and published on
 * `useWallet().mandala`. It is `undefined` until the wallet is built and on
 * every chain but mainnet — and that is the chain gate, not an error state:
 * when it is undefined every token surface renders `null`, so a wallet that
 * will never hold a token renders today's screens byte for byte (ux §2).
 *
 * `MandalaProvider` exists for tests and for a host that constructs its own
 * runtime; a provider value wins over the context field so a screen test can
 * inject a fake without standing up a wallet.
 *
 * Three rules this hook keeps for its callers:
 *
 *  · `null` is UNKNOWN and is never rendered as zero. A cold open, a failed
 *    read and a wallet switch all report `null`, because "0 USDX" and "we have
 *    not looked yet" are different sentences and only one of them is a balance.
 *  · A failed refresh keeps the last figure rather than blanking the screen.
 *  · Every async result is dropped if the runtime changed underneath it, so a
 *    wallet switch can never paint the previous wallet's money.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import type {
  MandalaRuntime,
  TokenActivityRow,
  TokenAssetInfo,
  TokenAssetStatus,
  TokenBalance
} from '../../core/mandala/runtime'
import type { TokenSettlementRow } from '../../core/mandala/types'

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source, which Jest cannot parse for any consumer of the barrel, even one
 * that never navigates. Same pattern as every other screen/component in this
 * package that needs `useFocusEffect`.
 */
type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

/** Injected runtime. `undefined` means "ask the wallet context"; `null` means "none". */
const MandalaRuntimeContext = createContext<MandalaRuntime | null | undefined>(undefined)

export function MandalaProvider({
  runtime,
  children
}: {
  runtime: MandalaRuntime | null
  children: React.ReactNode
}) {
  return React.createElement(MandalaRuntimeContext.Provider, { value: runtime }, children)
}

/**
 * The runtime, or `null` when stablecoins are unavailable on this wallet or
 * this chain. Callers that only fire actions (send, drain) want this; callers
 * that render money want `useMandala()`.
 */
export function useMandalaRuntime(): MandalaRuntime | null {
  const injected = useContext(MandalaRuntimeContext)
  // `undefined` on the context until the wallet is built, and on every chain
  // but mainnet — which IS the chain gate, not an error state.
  const fromWallet = useWallet()?.mandala ?? null
  const runtime = injected !== undefined ? injected : fromWallet
  // `available` is the runtime's own chain gate; a runtime that says it is not
  // available is the same as none at all for every surface below.
  return runtime && runtime.available ? runtime : null
}

export interface MandalaState {
  /** Stablecoins exist for this wallet on this chain. Everything is gated on it. */
  available: boolean
  runtime: MandalaRuntime | null
  /** Held assets with their figures. `null` = not known yet, never "zero". */
  balances: TokenBalance[] | null
  /** Just the assets, for a picker. `[]` when nothing is held. */
  assets: TokenAssetInfo[]
  /** Non-terminal settlement rows past the stuck bound (FIX M) — the home badge. */
  stuck: TokenSettlementRow[]
  /** True only while the FIRST read is outstanding; a refresh keeps the figures. */
  loading: boolean
  refresh: () => void
}

const EMPTY_ASSETS: TokenAssetInfo[] = []
const EMPTY_STUCK: TokenSettlementRow[] = []

export function useMandala(): MandalaState {
  const runtime = useMandalaRuntime()
  const [balances, setBalances] = useState<TokenBalance[] | null>(null)
  const [stuck, setStuck] = useState<TokenSettlementRow[]>(EMPTY_STUCK)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const runtimeRef = useRef<MandalaRuntime | null>(runtime)
  /** Which runtime we have already read once, so a refresh keeps the figures. */
  const loadedForRef = useRef<MandalaRuntime | null>(null)

  const refresh = useCallback(() => setNonce(n => n + 1), [])

  // A wallet switch must read as UNKNOWN immediately, not as the previous
  // wallet's balance held over until the next read lands.
  useEffect(() => {
    if (runtimeRef.current === runtime) return
    runtimeRef.current = runtime
    setBalances(null)
    setStuck(EMPTY_STUCK)
  }, [runtime])

  useEffect(() => {
    if (!runtime) {
      setBalances(null)
      setStuck(EMPTY_STUCK)
      setLoading(false)
      return
    }
    let live = true
    if (loadedForRef.current !== runtime) setLoading(true)
    void (async () => {
      try {
        const rows = await runtime.balances()
        if (live && runtimeRef.current === runtime) setBalances(rows)
      } catch {
        // A failed read keeps the last figure: a balance that blinks to "—" on
        // every transient overlay hiccup teaches the holder to distrust it.
      }
      try {
        const rows = await runtime.stuck()
        if (live && runtimeRef.current === runtime) setStuck(rows)
      } catch {
        // Same: the badge is advisory, and a missing one is better than a wrong one.
      }
      if (live) {
        loadedForRef.current = runtime
        setLoading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [runtime, nonce])

  // The runtime tells us when money moved; nothing here polls.
  useEffect(() => {
    if (!runtime) return
    return runtime.subscribe(refresh)
  }, [runtime, refresh])

  const assets = useMemo(() => (balances ? balances.map(b => b.asset) : EMPTY_ASSETS), [balances])

  return { available: runtime != null, runtime, balances, assets, stuck, loading, refresh }
}

export interface MandalaActivityState {
  /** `null` until the first read lands — an empty list is a claim, not a wait. */
  rows: TokenActivityRow[] | null
  loading: boolean
  refresh: () => void
}

/**
 * Token rows for the activity list (ux §6.2). Kept out of `useMandala()` so a
 * screen that only needs balances does not pay for an activity query.
 */
export function useTokenActivity(limit?: number): MandalaActivityState {
  const runtime = useMandalaRuntime()
  const [rows, setRows] = useState<TokenActivityRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    if (!runtime) {
      setRows(null)
      return
    }
    let live = true
    setLoading(true)
    void (async () => {
      try {
        const next = await runtime.activity(limit)
        if (live) setRows(next)
      } catch {
        // Advisory: the BSV rows still render, and a token row with no status
        // is better than an activity list that failed to draw.
      }
      if (live) setLoading(false)
    })()
    return () => {
      live = false
    }
  }, [runtime, limit, nonce])

  useEffect(() => {
    if (!runtime) return
    return runtime.subscribe(refresh)
  }, [runtime, refresh])

  return { rows, loading, refresh }
}

/** Index of token rows by txid, for interleaving into the wallet's own list. */
export function tokenActivityByTxid(rows: TokenActivityRow[] | null): Map<string, TokenActivityRow> {
  const map = new Map<string, TokenActivityRow>()
  for (const row of rows ?? []) map.set(row.txid.toLowerCase(), row)
  return map
}

export interface AssetStatusState {
  /** `null` until the first read lands, or when there is no runtime/assetId. Never a stand-in for "fine". */
  status: TokenAssetStatus | null
  /** True only while the FIRST read for this (runtime, assetId) pair is outstanding. */
  loading: boolean
  /** Forces a fresh read past the runtime's own ~10s cache. */
  refresh: () => void
}

/**
 * Regulatory/registry facts for one asset (paused, frozen, self/recipient
 * admission, metadata resolution, the MessageBox host) — the one door a pay
 * or receive screen has to the pre-flight copy in ux design §4.2/§5.4.
 *
 * Cached: reads go through `runtime.assetStatus`, which already holds a
 * ~10s cache in the implementation (runtime.ts), so calling this from more
 * than one screen for the same asset costs no extra round trip. Refreshed
 * three ways: the assetId/runtime changing, the runtime announcing a
 * mutation (`subscribe` — a send, a receive, a drain tick), and this screen
 * regaining focus (a paused/frozen fact can go stale while the holder was
 * looking at a different screen). A failed read is silently dropped and
 * keeps the last-known status — this is advisory copy, not a gate anything
 * transacts against (ux §4.2 rule 3: pre-flight may only ever say "no").
 */
export function useAssetStatus(assetId: string | null | undefined): AssetStatusState {
  const runtime = useMandalaRuntime()
  const [status, setStatus] = useState<TokenAssetStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce(n => n + 1), [])
  const key = runtime && assetId ? assetId : null

  useEffect(() => {
    if (!runtime || !key) {
      setStatus(null)
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    void (async () => {
      try {
        const next = await runtime.assetStatus(key)
        if (live) setStatus(next)
      } catch {
        // Fails open, like the runtime's own cache: a stale or unreachable
        // overlay must read as "unknown", never as a thrown error, and the
        // last-known status (possibly still null) is kept on screen.
      }
      if (live) setLoading(false)
    })()
    return () => {
      live = false
    }
  }, [runtime, key, nonce])

  // After mutations: the runtime's own change signal (a send, a receive, a
  // drain tick advancing a settlement) — the same subscription useMandala()
  // uses for balances/activity.
  useEffect(() => {
    if (!runtime) return
    return runtime.subscribe(refresh)
  }, [runtime, refresh])

  // On focus: a paused/frozen/admission fact can go stale while this screen
  // was backgrounded. `loadExpoRouter().useFocusEffect` is a hook, but the
  // module is cached after the first call, so it is the exact same function
  // reference on every render — a stable, unconditional call per render,
  // which is what the rules of hooks actually require.
  loadExpoRouter().useFocusEffect(
    useCallback(() => {
      refresh()
      // Only re-fetch on (re)focus, not on every render while focused.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runtime, key])
  )

  return { status, loading, refresh }
}
