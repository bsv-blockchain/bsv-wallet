// Activity (the prototype's app/(wallet)/activity/page.tsx): every payment
// in and out, newest first, grouped by day, searchable (a name, a note, an
// amount, part of a key, address or transaction id) and filtered by
// direction, and in a sheet by when, currency and whether it's settled. A
// search also finds people and settings. The header's menu exports this
// wallet's activity or opens help. Rows open their detail. The rows come from
// the shared core (src/activity/useActivity.ts).
//
// Payment requests (src/requests) are in the timeline too, on the day they
// were made, as the prototype has them: found by a search, and in the filter
// sheet's Show list as unpaid and paid. With nothing narrowing the list, those
// still waiting sit above the payments instead; the Requested chip lists every
// request alone.
//
// Not here, unlike the prototype: Deposited, Withdrawn and Swapped (Later),
// and the support agent (Later).
import React, { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { TextInput } from '../../src/ui/TextInput'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Search, Settings as SettingsIcon, SlidersHorizontal } from 'lucide-react-native'
import { font, radii, usePalette } from '../../src/theme'
import { Coin } from '../../src/ui/Coin'
import { GlassButton } from '../../src/ui/GlassButton'
import { PageHeader } from '../../src/ui/PageHeader'
import { ViewInfo } from '../../src/ui/ViewInfo'
import { SoftEllipse } from '../../src/ui/Soft'
import { coinBob, enter, useReducedMotion } from '../../src/ui/motion'
import { useFocusRing } from '../../src/ui/focusRing'
import { BalancedText } from '../../src/ui/BalancedText'
import { TxRow, TxRowSkeleton, txAmount } from '../../src/activity/TxRow'
import { groupByDay } from '../../src/activity/format'
import { useActivity, type ActivityItem } from '../../src/activity/useActivity'
import { ActivityMenu, FilterSheet, MoreResults, NO_MORE_FILTERS, moreCount, moreResults, passes, type MoreFilters } from '../../src/activity/ActivityExtras'
import { requestPasses } from '../../src/activity/filters'
import { useContacts } from '../../src/contacts/useContacts'
import { useWalletList } from '../../src/home/useWalletList'
import { ExportSheet } from '../../src/settings/ExportSheet'
import { HelpSheet } from '../../src/settings/HelpSheet'
import { RequestRow, requestSubtitle, requestTitle } from '../../src/requests/RequestRow'
import { amountText, useRequests } from '../../src/requests/useRequests'
import type { PaymentRequest } from '../../src/requests/requests'

/** transition-colors' / transition-all's curve */
const EASE = cubicBezier(0.4, 0, 0.2, 1)

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'received', label: 'Received' },
  { id: 'sent', label: 'Sent' },
  { id: 'pending', label: 'Pending' },
  { id: 'requested', label: 'Requested' }
] as const
type Filter = (typeof FILTERS)[number]['id']

/** Everything a search can hit. */
function searchText(tx: ActivityItem) {
  return [tx.title, tx.note, txAmount(tx), tx.txid, tx.counterparty?.value, tx.statusText].filter(Boolean).join(' ').toLowerCase()
}

type Row = ActivityItem | PaymentRequest
const isRequest = (row: Row): row is PaymentRequest => 'direction' in row
/** Newest first, payments and requests together (groupByDay keeps the order it's given) */
const byNewest = <T extends { createdAt?: string }>(rows: T[]) => [...rows].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

function requestText(r: PaymentRequest, name?: string) {
  return [requestTitle(r, name), r.note, amountText(r), r.counterparty, requestSubtitle(r)].filter(Boolean).join(' ').toLowerCase()
}

function matches(tx: ActivityItem, f: Filter) {
  if (f === 'received') return tx.incoming
  if (f === 'sent') return !tx.incoming
  if (f === 'pending') return tx.pending
  return true
}

export default function ActivityScreen() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const { items, more: hasMore, loadMore, loadingMore, error } = useActivity()
  const ring = useFocusRing(palette)
  const still = useReducedMotion()
  // arriving from Home's search bar: straight into the field
  // ?filter=requested: a tapped request notification (app/transactions.tsx)
  const { search, filter: initialFilter } = useLocalSearchParams<{ search?: string; filter?: string }>()
  const [filter, setFilter] = useState<Filter>(FILTERS.some(f => f.id === initialFilter) ? (initialFilter as Filter) : 'all')
  const [query, setQuery] = useState('')
  const [more, setMore] = useState<MoreFilters>(NO_MORE_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const contacts = useContacts()
  const { requests } = useRequests()
  const nameOf = (r: PaymentRequest) => contacts.byKey.get(r.counterparty.toLowerCase())?.name
  const wallets = useWalletList()
  const found = useMemo(() => moreResults(query, contacts.list ?? [], wallets), [query, contacts.list, wallets])
  // the currencies with payments, for the sheet
  const coins = useMemo(() => [...new Set((items ?? []).map(tx => (tx.token ? tx.token.unit : 'BSV')))], [items])
  const extra = moreCount(more)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (items ?? []).filter(tx => matches(tx, filter) && passes(tx, more) && (!q || searchText(tx).includes(q)))
  }, [items, filter, more, query])
  const sections = useMemo((): { title: string; data: Row[] }[] => {
    const q = query.trim().toLowerCase()
    // the requests a search and the sheet's filters let through
    const asked = requests.filter(
      r => requestPasses(r, more) && (!q || requestText(r, contacts.byKey.get(r.counterparty.toLowerCase())?.name).includes(q))
    )
    if (filter === 'requested') return groupByDay(byNewest(asked)).map(g => ({ title: g.label, data: g.items }))
    if (filter !== 'all') return groupByDay(shown).map(g => ({ title: g.label, data: g.items as Row[] }))
    // nothing narrowing the list: those still waiting above everything, the rest on their day
    const calm = !q && !extra
    const waiting = calm ? asked.filter(r => r.status === 'pending') : []
    // payments come a page at a time: a request older than the oldest loaded waits for its day
    const oldest = hasMore && shown.length ? shown[shown.length - 1].createdAt : undefined
    const dated = asked.filter(r => !(calm && r.status === 'pending') && (!oldest || r.createdAt >= oldest))
    const days = groupByDay(byNewest<Row>([...shown, ...dated])).map(g => ({ title: g.label, data: g.items }))
    return waiting.length ? [{ title: 'Open requests', data: waiting }, ...days] : days
  }, [shown, filter, query, extra, more, hasMore, requests, contacts.byKey])
  // what the filters let through, requests too, for the sheet's "Show N payments"
  const rowCount = sections.reduce((n, s) => n + s.data.length, 0)
  const reason: 'none' | 'search' | 'filter' =
    (items ?? []).length === 0 && !requests.length ? 'none' : query.trim() ? 'search' : 'filter'

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      {/* the header, search and chips scroll away with the list, as in the prototype */}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}
        onScroll={e => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
          if (hasMore && layoutMeasurement.height + contentOffset.y > contentSize.height - 400) void loadMore()
        }}
        scrollEventThrottle={64}
      >
        <PageHeader
          title="Activity"
          align="left"
          action={
            <View style={styles.headerActions}>
              {/* ghost icon button: this wallet's activity out, or help */}
              <Pressable
                onPress={() => setMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Activity settings"
                style={({ pressed }) => [styles.ghost, pressed && { backgroundColor: palette.accent }]}
              >
                <SettingsIcon size={20} color={palette.foreground} />
              </Pressable>
              <ViewInfo
                about="Activity"
                text="Every payment in and out, in one tidy timeline. Search anything you half remember: a name, a note, even “coffee”. Tap any payment for the full story."
              />
            </View>
          }
        />
        <Animated.View style={[styles.search, { backgroundColor: palette.card }, ring.style]}>
          <Search size={16} color={palette.mutedForeground} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            {...ring.handlers}
            placeholder="Search payments, people, settings"
            placeholderTextColor={palette.mutedForeground}
            returnKeyType="search"
            autoFocus={search === '1'}
            accessibilityLabel="Search payments"
            style={[font(400), styles.searchInput, { color: palette.foreground }]}
          />
        </Animated.View>
        {/* scrolls sideways, edge to edge: the finer filters first, then the chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.chipStrip}
          contentContainerStyle={styles.chips}
        >
          <Pressable onPress={() => setFiltersOpen(true)} accessibilityRole="button" accessibilityLabel={extra ? `Filters, ${extra} on` : 'Filters'}>
            <Animated.View
              style={[
                styles.filterChip,
                { backgroundColor: extra ? palette.ink : palette.secondary },
                { transitionProperty: 'backgroundColor', transitionDuration: 150, transitionTimingFunction: EASE }
              ]}
            >
              <SlidersHorizontal size={16} color={extra ? palette.inkForeground : palette.secondaryForeground} />
              {extra > 0 && (
                <View style={[styles.badge, { backgroundColor: palette.gold }]}>
                  <Text style={[font(700), styles.badgeText, { color: palette.goldForeground }]}>{extra}</Text>
                </View>
              )}
            </Animated.View>
          </Pressable>
          {FILTERS.map(f => {
            const on = filter === f.id
            return (
              <Pressable key={f.id} onPress={() => setFilter(f.id)} accessibilityRole="button" accessibilityState={{ selected: on }}>
                {/* transition-all duration-300 */}
                <Animated.View
                  style={[
                    styles.chip,
                    { backgroundColor: on ? palette.ink : palette.secondary },
                    { transitionProperty: 'backgroundColor', transitionDuration: 300, transitionTimingFunction: EASE }
                  ]}
                >
                  <Animated.Text
                    style={[
                      font(600),
                      styles.chipText,
                      { color: on ? palette.inkForeground : palette.secondaryForeground },
                      { transitionProperty: 'color', transitionDuration: 300, transitionTimingFunction: EASE }
                    ]}
                  >
                    {f.label}
                  </Animated.Text>
                </Animated.View>
              </Pressable>
            )
          })}
        </ScrollView>

        {/* everything under the chips rises in afresh as the view changes
            (animate-in fade-in slide-in-from-bottom-1 duration-300) */}
        <Animated.View
          key={`${filter}-${query.trim()}-${JSON.stringify(more)}`}
          style={[styles.list, still ? null : enter({ translateY: 4, duration: 300 })]}
        >
          {/* search finds more than payments: people, your wallets, settings */}
          <MoreResults found={found} />
          {items === null ? (
            // the first page on its way
            <View style={styles.bleed}>
              <TxRowSkeleton />
            </View>
          ) : sections.length === 0 ? (
            found.any ? (
              <Text style={[font(400), styles.noPayments, { color: palette.mutedForeground }]}>No payments match “{query.trim()}”.</Text>
            ) : (
              <EmptyActivity
                reason={reason}
                query={query.trim()}
                filterLabel={extra ? 'these filters' : (FILTERS.find(f => f.id === filter)?.label ?? '')}
                error={error}
                onClear={() => {
                  setQuery('')
                  setFilter('all')
                  setMore(NO_MORE_FILTERS)
                }}
              />
            )
          ) : (
            sections.map(section => (
              <View key={section.title}>
                <Text style={[font(600), styles.day, { color: palette.mutedForeground }]}>{section.title.toUpperCase()}</Text>
                {/* no card: rows sit on the page, pulled out so their content
                    lines up with the day label while the press wash bleeds past it */}
                <View style={styles.bleed}>
                  {section.data.map(row =>
                    isRequest(row) ? <RequestRow key={`request:${row.id}`} r={row} contactName={nameOf(row)} /> : <TxRow key={row.id} tx={row} />
                  )}
                </View>
              </View>
            ))
          )}
          {loadingMore && filter !== 'requested' && (
            <View style={styles.bleed}>
              <TxRowSkeleton />
            </View>
          )}
        </Animated.View>
      </ScrollView>
      <FilterSheet open={filtersOpen} onOpenChange={setFiltersOpen} value={more} onChange={setMore} coins={coins} results={rowCount} />
      <ActivityMenu open={menuOpen} onOpenChange={setMenuOpen} onExport={() => setExportOpen(true)} onHelp={() => setHelpOpen(true)} />
      <HelpSheet open={helpOpen} onOpenChange={setHelpOpen} />
      <ExportSheet open={exportOpen} onOpenChange={setExportOpen} />
    </View>
  )
}

/**
 * When the list is empty: the floating BSV coin on a soft gold glow, and what
 * to do next. A brand-new wallet gets a start; a search or filter with no
 * hits gets a way back.
 */
function EmptyActivity({
  reason,
  query,
  filterLabel,
  error,
  onClear
}: {
  reason: 'none' | 'search' | 'filter'
  query: string
  filterLabel: string
  error: boolean
  onClear: () => void
}) {
  const palette = usePalette()
  const router = useRouter()
  const still = useReducedMotion()
  const copy = error
    ? { title: 'Your activity couldn’t be read', body: 'Check your connection and try again in a moment.' }
    : {
        none: { title: 'No activity yet', body: 'Payments will show up here, newest first.' },
        search: { title: `No matches for “${query}”`, body: 'Try a name, a note, an amount or part of an address.' },
        filter: { title: `Nothing under ${filterLabel} yet`, body: 'Try another filter, or see everything.' }
      }[reason]
  return (
    <View style={styles.empty}>
      <View style={styles.emptyArt}>
        <SoftEllipse frame={{ left: -32, top: -32, width: 176, height: 176 }} color={palette.gold} opacity={0.25} blur={64} />
        <Animated.View
          style={still ? null : { animationName: coinBob, animationDuration: 5000, animationIterationCount: 'infinite', animationTimingFunction: 'ease-in-out' }}
        >
          <Coin />
        </Animated.View>
      </View>
      <View style={styles.emptyCopy}>
        <BalancedText style={[font(700), styles.emptyTitle, { color: palette.foreground }]}>{copy.title}</BalancedText>
        <BalancedText style={[font(400), styles.emptyBody, { color: palette.mutedForeground }]}>{copy.body}</BalancedText>
      </View>
      {reason === 'none' ? (
        <View style={styles.emptyCta}>
          <GlassButton label="Get paid" onPress={() => router.push('/receive')} />
        </View>
      ) : (
        <GlassButton variant="outline" label={reason === 'search' ? 'Clear search' : 'Show all'} onPress={onClear} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // flex flex-col gap-4
  page: { paddingHorizontal: 16, gap: 16 },
  // h-11 rounded-2xl, the icon at left-3.5
  search: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radii['2xl'], paddingHorizontal: 14 },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ghost: { width: 32, height: 32, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center' },
  // -mx-4 px-4 pb-1: the first day label sits 20 under the chips
  chipStrip: { marginHorizontal: -16, flexGrow: 0 },
  chips: { flexDirection: 'row', gap: 8, paddingBottom: 4, paddingHorizontal: 16 },
  filterChip: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  badge: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 10, lineHeight: 12, fontVariant: ['tabular-nums'] },
  chip: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 6 },
  chipText: { fontSize: 13, lineHeight: 18 },
  list: { gap: 16 },
  bleed: { marginHorizontal: -8 },
  noPayments: { paddingHorizontal: 4, paddingBottom: 16, fontSize: 14, lineHeight: 20 },
  day: { paddingBottom: 6, paddingLeft: 4, fontSize: 11, lineHeight: 16, letterSpacing: 1.6 },
  empty: { alignItems: 'center', gap: 20, paddingVertical: 48, paddingHorizontal: 16 },
  emptyArt: { width: 112, height: 112, alignItems: 'center', justifyContent: 'center' },
  emptyCopy: { maxWidth: 320, alignItems: 'center', gap: 6, paddingTop: 8 },
  emptyTitle: { alignSelf: 'stretch', textAlign: 'center', fontSize: 20, lineHeight: 28, letterSpacing: -0.5 },
  emptyBody: { alignSelf: 'stretch', textAlign: 'center', fontSize: 14, lineHeight: 23 },
  emptyCta: { width: '100%', maxWidth: 320 }
})
