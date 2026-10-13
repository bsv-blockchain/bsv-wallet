// This wallet's activity, from the shared core: payments (listActions, a page
// of 30 at a time), the offline overlay (queued, posting, parked, refused),
// and stablecoin transfers (the Mandala runtime), merged the way the existing
// app's Home merges them (packages/expo-wallet-toolbox/ui/screens/
// WalletHomeScreen.tsx), and re-read whenever the ledger changes.
//
// Each row is kept in a small in-memory index too, so the detail route
// (app/activity/[id].tsx) opens on what the list showed without refetching.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { findOfflineActions } from '@bsv/expo-wallet-toolbox/core/storage/methods/offlineActions'
import { storageMatchesNetwork } from '@bsv/expo-wallet-toolbox/core/net/chainMatch'
import { tokenActivityByTxid, useTokenActivity } from '@bsv/expo-wallet-toolbox/ui/hooks/useMandala'
import type { ActivityAction } from '@bsv/expo-wallet-toolbox/ui/components/wallet/ActivityRow'
import { useContacts } from '../contacts/useContacts'
import { toActivityItems, type ActivityItem } from './items'

export type { ActivityItem }

const PAGE_SIZE = 30

/** The rows the list last showed, by id, for the detail route. */
const index = new Map<string, ActivityItem>()
export const activityItem = (id: string) => index.get(id)
/** Development builds only: sample rows for the dev-art route. */
export const seedActivityForDev = (items: ActivityItem[]) => {
  if (__DEV__) for (const it of items) index.set(it.id, it)
}

export function useActivity(opts: { limit?: number } = {}) {
  const { t } = useTranslation()
  const { managers, adminOriginator, storage, selectedNetwork, txStatusVersion, walletUserId, switchingProfile } = useWallet()
  const contacts = useContacts()
  const tokens = useTokenActivity()
  const [actions, setActions] = useState<ActivityAction[] | null>(null)
  // the wallet the first page was read from: a wallet just opened has none yet
  const [readFrom, setReadFrom] = useState<unknown>(null)
  const [offline, setOffline] = useState<Map<string, { status: string }>>(new Map())
  const [error, setError] = useState(false)
  const [more, setMore] = useState(false)
  // a next page on its way, for the list's placeholder rows
  const [loadingMore, setLoadingMore] = useState(false)
  // bumped to read the first page again outside a ledger change
  const [nonce, setNonce] = useState(0)
  const offset = useRef(0)
  const busy = useRef(false)
  const pm = managers.permissionsManager
  const onThisNetwork = storageMatchesNetwork(storage, selectedNetwork)
  const limit = opts.limit ?? PAGE_SIZE

  const page = useCallback(
    async (from: number, count: number = limit) =>
      pm ? pm.listActions({ labels: [], includeLabels: true, limit: count, offset: from }, adminOriginator) : null,
    [pm, adminOriginator, limit]
  )
  // the wallet the rows loaded so far came from: re-read, its list keeps as
  // many as were loaded, rather than falling back to the first page under a
  // list scrolled far down; another wallet starts again at one page
  const loadedFrom = useRef<unknown>(null)

  // the first page, again whenever the ledger changes
  useEffect(() => {
    let live = true
    // no reads while the core switches wallets: it closes this wallet's database under them
    if (switchingProfile) return
    if (!onThisNetwork || !pm) {
      if (!storage) setActions([])
      return
    }
    ;(async () => {
      try {
        const count = loadedFrom.current === pm ? Math.max(limit, offset.current) : limit
        const r = await page(0, count)
        if (!live || !r) return
        setActions(r.actions as ActivityAction[])
        setReadFrom(pm)
        loadedFrom.current = pm
        offset.current = r.actions.length
        setMore(r.actions.length >= count && r.actions.length < (r.totalActions ?? 0))
        setError(false)
      } catch {
        if (live) setError(true)
      }
      try {
        const db = storage?.sqliteDb
        if (!db) return
        const rows = await findOfflineActions(db, {
          status: ['queued', 'posting', 'rejected', 'parked', 'import_hold'],
          ...(walletUserId === null || walletUserId === undefined ? {} : { userId: walletUserId })
        })
        if (live) setOffline(new Map(rows.map(r => [r.txid, r])))
      } catch {
        // an advisory overlay: a read failure must not break the list
      }
    })()
    return () => {
      live = false
    }
  }, [page, txStatusVersion, storage, onThisNetwork, pm, walletUserId, limit, nonce, switchingProfile])

  const loadMore = useCallback(async () => {
    if (!more || busy.current) return
    busy.current = true
    setLoadingMore(true)
    try {
      const r = await page(offset.current)
      const next = (r?.actions ?? []) as ActivityAction[]
      if (next.length) setActions(prev => [...(prev ?? []), ...next])
      offset.current += next.length
      setMore(next.length >= limit && offset.current < (r?.totalActions ?? 0))
    } catch {
      // the next scroll tries again
    } finally {
      busy.current = false
      setLoadingMore(false)
    }
  }, [more, page, limit])

  const tokenByTxid = useMemo(() => tokenActivityByTxid(tokens.rows ?? []), [tokens.rows])

  // not read from this wallet yet: still loading, not empty
  const unread = !!pm && readFrom !== pm
  const items = useMemo<ActivityItem[] | null>(() => {
    if (!actions || unread) return null
    const list = toActivityItems(actions, { offline, tokenByTxid, contactsByKey: contacts.byKey, t })
    for (const it of list) index.set(it.id, it)
    return list
  }, [actions, unread, offline, tokenByTxid, contacts.byKey, t])

  const reload = useCallback(() => setNonce(n => n + 1), [])

  return { items, error, more, loadMore, loadingMore, reload }
}
