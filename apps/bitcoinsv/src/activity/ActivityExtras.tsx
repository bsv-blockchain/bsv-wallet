// Activity's extras (the prototype's activity page and components/activity-
// filter-sheet.tsx): more filters in a sheet (when, a preset or a custom range
// on a calendar; which currency; settled or not; src/activity/filters.ts), the
// header's menu, and what else a search finds (people in your contacts, your
// wallets on this phone, and settings).
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { Check, ChevronRight, Download, MessageCircleQuestion, Settings as SettingsIcon } from 'lucide-react-native'
import { font, radii, useIsDark, usePalette } from '../theme'
import { handleLabel, matchesSearch } from '../contacts/handles'
import { useOwnDomains } from '../ui/Handle'
import { BottomSheet, afterSheetCloses } from '../ui/BottomSheet'
import { GlassButton } from '../ui/GlassButton'
import { Face } from '../ui/Face'
import type { Contact } from '../contacts/useContacts'
import type { WalletEntry } from '../home/useWalletList'
import { Avatar, type AvatarBg, type Portrait } from '../ui/Avatar'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { RangeCalendar } from '../ui/RangeCalendar'
import { CoinMark } from '../ui/CoinMark'
import { enter, useReducedMotion } from '../ui/motion'
import { useAssets } from '../state/useAssets'
import { SideSheet } from './SideSheet'
import { NO_MORE_FILTERS, RANGES, STATES, moreCount, type MoreFilters } from './filters'
export { NO_MORE_FILTERS, moreCount, passes, type MoreFilters } from './filters'

/** The sheet's chips' and ticks' colour change (transition-colors: 150ms). */
const COLOURS = {
  transitionProperty: ['backgroundColor', 'boxShadow'] as ('backgroundColor' | 'boxShadow')[],
  transitionDuration: 150,
  transitionTimingFunction: cubicBezier(0.4, 0, 0.2, 1)
}
const TEXT_COLOUR = { transitionProperty: 'color' as const, transitionDuration: 150, transitionTimingFunction: cubicBezier(0.4, 0, 0.2, 1) }

/**
 * A row with the round tick on the right, as in the Pay contact list
 * (activity-filter-sheet.tsx's TickRow). Its Only button shows on hover in
 * the prototype, which a phone hasn't got: not here.
 */
function TickRow({ on, label, hint, art, onPress }: { on: boolean; label: string; hint?: string; art?: React.ReactNode; onPress: () => void }) {
  const palette = usePalette()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      style={({ pressed }) => [styles.tickRow, pressed && { backgroundColor: palette.secondary + '99' }]}
    >
      {art}
      <View style={styles.flex}>
        <Text style={[font(600), styles.small, { color: palette.foreground }]}>{label}</Text>
        {hint ? <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{hint}</Text> : null}
      </View>
      {/* size-6 rounded-full ring-1: ink when on, ring-border when off */}
      <Animated.View
        style={[
          styles.tick,
          { backgroundColor: on ? palette.ink : 'transparent', boxShadow: `0 0 0 1px ${on ? palette.ink : palette.border}` },
          COLOURS
        ]}
      >
        {on && <Check size={14} color={palette.inkForeground} strokeWidth={3} />}
      </Animated.View>
    </Pressable>
  )
}

/** The sheet's section headings: text-xs semibold uppercase tracking-widest, pb-1.5. */
function Heading({ children }: { children: string }) {
  const palette = usePalette()
  return <Text style={[font(600), styles.sheetHeading, { color: palette.mutedForeground }]}>{children.toUpperCase()}</Text>
}

/**
 * The finer filters, in a sheet from the side (activity-filter-sheet.tsx):
 * when (all time by default, or a custom range), which currencies, and
 * settled or not. Currencies and states are all ticked to start; untick what
 * you don't want. Changes apply as you go.
 */
export function FilterSheet({
  open,
  onOpenChange,
  value,
  onChange,
  coins,
  results
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  value: MoreFilters
  onChange: (m: MoreFilters) => void
  /** the currencies with payments */
  coins: string[]
  /** how many payments these filters show */
  results: number
}) {
  const palette = usePalette()
  const still = useReducedMotion()
  const { assets } = useAssets()
  // BitcoinSV first
  const ordered = [...coins].sort((a, b) => (a === 'BSV' ? -1 : b === 'BSV' ? 1 : 0))
  const flip = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter(y => y !== x) : [...list, x])
  const nothingSet = moreCount(value) === 0
  return (
    <SideSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Filters"
      description="Narrow down your activity."
      footer={
        <>
          <GlassButton
            label={results === 0 ? 'No payments match' : `Show ${results} payment${results === 1 ? '' : 's'}`}
            onPress={() => onOpenChange(false)}
          />
          {/* always there; faint while there's nothing to reset */}
          <Pressable
            onPress={() => onChange(NO_MORE_FILTERS)}
            disabled={nothingSet}
            accessibilityRole="button"
            accessibilityState={{ disabled: nothingSet }}
            style={[styles.reset, nothingSet && styles.faint]}
          >
            <Text style={[font(600), styles.small, { color: palette.mutedForeground }]}>Reset filters</Text>
          </Pressable>
        </>
      }
    >
      <View style={styles.when}>
        <Heading>When</Heading>
        <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Time range">
          {RANGES.map(r => {
            const on = value.range === r.id
            return (
              <Pressable
                key={r.id}
                onPress={() => onChange({ ...value, range: r.id })}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
              >
                <Animated.View style={[styles.chip, { backgroundColor: on ? palette.ink : palette.secondary }, COLOURS]}>
                  <Animated.Text style={[font(600), styles.chipText, { color: on ? palette.inkForeground : palette.secondaryForeground }, TEXT_COLOUR]}>
                    {r.label}
                  </Animated.Text>
                </Animated.View>
              </Pressable>
            )
          })}
        </View>
        {value.range === 'custom' && (
          // animate-in fade-in slide-in-from-top-1 duration-200
          <Animated.View style={[styles.calendar, still ? null : enter({ translateY: -4, duration: 200 })]}>
            <RangeCalendar from={value.from} to={value.to} onChange={range => onChange({ ...value, ...range })} />
          </Animated.View>
        )}
      </View>
      {ordered.length > 1 && (
        <View>
          <Heading>Currency</Heading>
          {ordered.map(c => (
            <TickRow
              key={c}
              on={!value.hiddenCoins.includes(c)}
              onPress={() => onChange({ ...value, hiddenCoins: flip(value.hiddenCoins, c) })}
              art={<CoinMark coin={c === 'BSV' ? { kind: 'bsv' } : { kind: 'token', ticker: c }} size={32} />}
              label={c}
              hint={c === 'BSV' ? 'BitcoinSV' : (assets.find(a => a.ticker === c)?.name ?? c)}
            />
          ))}
        </View>
      )}
      <View>
        <Heading>Show</Heading>
        {STATES.map(st => {
          const on = value.states.includes(st.id)
          return (
            <TickRow
              key={st.id}
              on={on}
              label={st.label}
              hint={st.hint}
              onPress={() => onChange({ ...value, states: flip(value.states, st.id) })}
            />
          )
        })}
      </View>
    </SideSheet>
  )
}

/** The header's menu: this wallet's activity out, or help. */
export function ActivityMenu({
  open,
  onOpenChange,
  onExport,
  onHelp
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onExport: () => void
  onHelp: () => void
}) {
  const palette = usePalette()
  const row = (Icon: typeof Download, label: string, run: () => void) => (
    <Pressable
      onPress={() => {
        onOpenChange(false)
        afterSheetCloses(run)
      }}
      accessibilityRole="button"
      style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: palette.secondary + '99' }]}
    >
      <Icon size={18} color={palette.foreground} />
      <Text style={[font(500), styles.small, { color: palette.foreground }]}>{label}</Text>
    </Pressable>
  )
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Activity">
      <View style={styles.list}>
        {row(Download, 'Export for accounting', onExport)}
        {row(MessageCircleQuestion, 'Help & support', onHelp)}
      </View>
    </BottomSheet>
  )
}

/**
 * The settings a search can find, and the words that find them; a result
 * opens Settings on that row, lit up (`row` is its label there), or its own
 * screen (`to`).
 */
const SETTINGS: { label: string; words: string; to?: string; dev?: boolean }[] = [
  { label: 'Your profile', words: 'profile name picture avatar photo me', to: '/profile' },
  { label: 'Handle', words: 'handle username paymail at' },
  { label: 'Handles', words: 'handles wallets free bought' },
  { label: 'Sign-ins', words: 'sign in login websites connected apps sites web3' },
  { label: 'Backups', words: 'backup recovery phrase seed slices sync' },
  { label: 'Dark mode', words: 'dark theme night appearance light' },
  { label: 'App icon', words: 'icon logo home screen dragon satoshi original' },
  { label: 'Display currency', words: 'currency dollar pound euro fiat' },
  { label: 'Hide balances', words: 'hide privacy balances amounts' },
  { label: 'Vault button', words: 'vault yubikey savings' },
  { label: 'Payment alerts', words: 'alerts notifications toast' },
  { label: 'Sounds', words: 'sound sounds tone' },
  { label: 'Phone notifications', words: 'notifications push permission' },
  { label: 'Export for accounting', words: 'export csv pdf accounting tax statement' },
  { label: 'Network', words: 'network testnet mainnet', dev: true },
  { label: 'Developer tools', words: 'developer arc message box trust logs debug', dev: true },
  { label: 'Help & support', words: 'help support question' },
  { label: 'Why Bitcoin SV Wallet', words: 'about why version' },
  { label: 'Take the tour', words: 'tour guide intro' },
  { label: 'Forget wallet', words: 'forget delete remove wallet', to: '/profile' }
].filter(s => !s.dev || __DEV__)

export function moreResults(query: string, contacts: Contact[], wallets: WalletEntry[] = []) {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return { people: [], wallets: [], settings: [], any: false }
  // three people, two wallets, three settings (activity/page.tsx's useMoreResults)
  // by name, or handle in any form, with or without its @ (src/contacts/handles.ts)
  const people = contacts.filter(c => matchesSearch({ name: c.name, handle: c.cachedHandle }, q)).slice(0, 3)
  const mine = wallets.filter(w => matchesSearch({ name: w.name, handle: w.handle }, q)).slice(0, 2)
  const settings = SETTINGS.filter(s => s.label.toLowerCase().includes(q) || s.words.includes(q)).slice(0, 3)
  return { people, wallets: mine, settings, any: people.length + mine.length + settings.length > 0 }
}

/** Those results, above the payments (activity/page.tsx's MoreResults). */
export function MoreResults({ found }: { found: ReturnType<typeof moreResults> }) {
  const palette = usePalette()
  const router = useRouter()
  const { switchProfile } = useWallet()
  const dark = useIsDark()
  const own = useOwnDomains()
  if (!found.any) return null
  const heading = (t: string, top = false) => <Text style={[font(600), styles.heading, top && styles.headingTop, { color: palette.mutedForeground }]}>{t}</Text>
  const row = (key: string | number, onPress: () => void, art: (pressed: boolean) => React.ReactNode, title: string, sub?: string) => (
    <Pressable
      key={key}
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.moreRow, pressed && { backgroundColor: palette.secondary + '99' }]}
    >
      {({ pressed }) => (
        <>
          {art(pressed)}
          <View style={styles.flex}>
            <Text numberOfLines={1} style={[font(500), styles.small, { color: palette.foreground }]}>
              {title}
            </Text>
            {sub ? (
              <Text numberOfLines={1} style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
                {sub}
              </Text>
            ) : null}
          </View>
          <ChevronRight size={16} color={palette.mutedForeground} />
        </>
      )}
    </Pressable>
  )
  return (
    <View style={styles.more}>
      {found.people.length > 0 && (
        <View>
          {heading('PEOPLE')}
          <View style={styles.bleed}>
            {found.people.map(c =>
              row(
                c.identityKey,
                () => router.push({ pathname: '/contacts/[key]', params: { key: c.identityKey } }),
                () => <Face counterparty={{ kind: 'identityKey', value: c.identityKey }} avatarUrl={c.cachedAvatarUrl} size={36} />,
                c.name,
                c.cachedHandle ? handleLabel(c.cachedHandle, own) : undefined
              )
            )}
          </View>
        </View>
      )}
      {found.wallets.length > 0 && (
        <View>
          {heading('YOUR WALLETS')}
          <View style={styles.bleed}>
            {found.wallets.map(w =>
              row(
                w.index,
                async () => {
                  // its profile, opening the wallet first if it isn't this one
                  if (!w.active) await switchProfile(w.index)
                  router.push('/profile')
                },
                () => (
                  <Avatar
                    bg={(w.look?.avatarBg as AvatarBg) ?? 'mint'}
                    portrait={(w.look?.avatarPortrait as Portrait) ?? 'dragon'}
                    uri={w.look?.avatarUri ?? undefined}
                    size={36}
                  />
                ),
                w.name,
                [w.handle, w.active ? 'this wallet' : null].filter(Boolean).join(' · ')
              )
            )}
          </View>
        </View>
      )}
      {found.settings.length > 0 && (
        <View>
          {heading('SETTINGS')}
          <View style={styles.bleed}>
            {found.settings.map(s =>
              row(
                s.label,
                () => router.push(s.to ?? { pathname: '/settings', params: { row: s.label } }),
                // size-9 rounded-xl bg-secondary; white (black in dark) while the row greys
                pressed => (
                  <Animated.View
                    style={[
                      styles.settingTile,
                      { backgroundColor: pressed ? (dark ? '#000000' : '#ffffff') : palette.secondary },
                      { transitionProperty: 'backgroundColor', transitionDuration: 150 }
                    ]}
                  >
                    <SettingsIcon size={16} color={palette.foreground} />
                  </Animated.View>
                ),
                s.label
              )
            )}
          </View>
        </View>
      )}
      {heading('PAYMENTS', true)}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  heading: { fontSize: 11, lineHeight: 16, letterSpacing: 1.6, paddingBottom: 6, paddingLeft: 4 },
  headingTop: { paddingTop: 4 },
  sheetHeading: { fontSize: 12, lineHeight: 16, letterSpacing: 1.2, paddingBottom: 6 },
  when: { gap: 10 },
  calendar: { paddingTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  chipText: { fontSize: 13, lineHeight: 18 },
  list: { marginHorizontal: -8 },
  // -mx-2 rounded-xl; the button px-2 py-2.5, the tick's own pl-1 pr-2
  tickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: -8, borderRadius: radii.xl, paddingLeft: 8, paddingRight: 8, paddingVertical: 10 },
  tick: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  reset: { paddingVertical: 6, alignItems: 'center', justifyContent: 'center' },
  faint: { opacity: 0.4 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 12 },
  more: { gap: 12 },
  bleed: { marginHorizontal: -8 },
  // rounded-xl px-3 py-2.5
  moreRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 12, paddingVertical: 10 },
  settingTile: { width: 36, height: 36, borderRadius: radii.xl, alignItems: 'center', justifyContent: 'center' }
})
