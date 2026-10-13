// Settings, as the prototype's app/(wallet)/settings/page.tsx in its Now
// state, each row on something real:
//   the profile, its @handle (copied on a tap), every wallet's handle
//   (app/handles.tsx) and the websites it's signed in to (app/sign-ins.tsx)
//   Backups: the phrase, slices and Sync (src/backup, src/sync)
//   Appearance: dark mode, the app icon, the display currency (the core's wallet setting),
//     hidden balances, and the Vault button where Vault exists
//   Notifications & sounds: payment alerts, the core's tones, and the phone's
//     own notification permission when this build has push
//   Data: the core's CSV export
//   Support: help (quick answers), why Bitcoin SV Wallet, the tour
//   Forget wallet
// Not here: the demo's payment methods and subscriptions (no Now meaning), its own Face ID, passcode and auto-lock (the phone's lock guards
// the keys), product news and the scripted support chat (Later).
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { cubicBezier } from 'react-native-reanimated'
import * as Clipboard from 'expo-clipboard'
import { AtSign, Banknote, Bell, BellRing, ChevronRight, CircleHelp, Code, Globe, Smartphone, Tags, Wrench, Compass, EyeOff, FileDown, History, Info, Moon, Trash2, Vault, Volume2 } from 'lucide-react-native'
import { observer } from 'mobx-react-lite'
import { connectionStore, isVaultEnabled, useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../src/ui/Toast'
import { DISPLAY_NAME_KV_KEY, HANDLE_KV_KEY } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileKeys'
import { font, radii, useIsDark, usePalette } from '../src/theme'
import { PageHeader } from '../src/ui/PageHeader'
import { ViewInfo } from '../src/ui/ViewInfo'
import { BottomSheet, afterSheetCloses } from '../src/ui/BottomSheet'
import { Flag } from '../src/ui/Flag'
import { BsvMark } from '../src/ui/BsvMark'
import { Avatar, type AvatarBg, type Portrait } from '../src/ui/Avatar'
import { PressRow, Section, SettingsRow, SettingsSearch, SwitchRow } from '../src/settings/Rows'
import { AboutSheet, APP_VERSION } from '../src/settings/AboutSheet'
import { ForgetWalletSheet } from '../src/settings/ForgetWalletSheet'
import { HelpSheet } from '../src/settings/HelpSheet'
import { ExportSheet } from '../src/settings/ExportSheet'
import { APP_ICONS, useAppIcon } from '../src/settings/appIcons'
import { useWalletList } from '../src/home/useWalletList'
import { BackupSheet } from '../src/backup/BackupSheet'
import { useSyncEnabled } from '../src/sync/SyncSheet'
import { setPref, usePrefs } from '../src/state/prefs'
import { useHomeData } from '../src/state/useHomeData'
import { DISPLAY_CURRENCIES, useDisplayCurrency } from '../src/state/displayCurrency'
import { usePushPermission } from '../src/notify/NotifyPrompt'
import { setShowAgain, useShowAgain } from '../src/tour/showAgain'
import { showTap } from '../src/ui/TapHint'

/** transition: 150ms… 500ms, cubic-bezier(0.4, 0, 0.2, 1) */
const EASE = cubicBezier(0.4, 0, 0.2, 1)

export default function Settings() {
  const palette = usePalette()
  const dark = useIsDark()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const prefs = usePrefs()
  const data = useHomeData()
  const syncOn = useSyncEnabled()
  const display = useDisplayCurrency()
  const push = usePushPermission()
  const { storage, switchingProfile, selectedNetwork, switchNetwork } = useWallet()
  const [handle, setHandle] = useState<string | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [currencyOpen, setCurrencyOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  // /settings?backup=1 (from the core's screens): the backup, open
  // ?row=<label>: a search's landing, that row lit up
  const { backup, row } = useLocalSearchParams<{ backup?: string; row?: string }>()
  useEffect(() => {
    if (backup) setBackupOpen(true)
  }, [backup])
  const [aboutOpen, setAboutOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [forgetOpen, setForgetOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const appIcon = useAppIcon()
  // every wallet's handle (app/handles.tsx)
  const walletCount = useWalletList().filter(w => w.handle).length
  const [networkOpen, setNetworkOpen] = useState(false)
  // after the tour video: here's "Take the tour", lit up; then back to the
  // top, a tap on Back, and Home shows the Settings button it's under
  const again = useShowAgain()
  const scroller = useRef<ScrollView>(null)
  const backButton = useRef<View>(null)
  const [tourRowY, setTourRowY] = useState<number | null>(null)
  const [lit, setLit] = useState(false)
  // where each section sits, and the row a search landed on
  const sectionYs = useRef(new Map<string, number>())
  const [searchLit, setSearchLit] = useState<string | undefined>(undefined)
  const [measured, setMeasured] = useState(0)
  const search = useMemo(
    () => ({
      lit: searchLit,
      onSection: (title: string, y: number) => {
        sectionYs.current.set(title, y)
        setMeasured(n => n + 1)
      }
    }),
    [searchLit]
  )
  const landed = useRef<string | null>(null)
  useEffect(() => {
    if (!row || landed.current === row) return
    const y = sectionYs.current.get(ROW_SECTION[row] ?? '')
    if (y === undefined) return
    landed.current = row
    scroller.current?.scrollTo({ y: Math.max(0, y - 80), animated: true })
    setSearchLit(row)
    const t = setTimeout(() => setSearchLit(undefined), 2600)
    return () => clearTimeout(t)
  }, [row, measured])
  useEffect(() => {
    if (!again.tourRow || tourRowY === null) return
    let gone = false
    scroller.current?.scrollTo({ y: Math.max(0, tourRowY - 240), animated: true })
    setLit(true)
    const up = setTimeout(() => {
      setLit(false)
      scroller.current?.scrollTo({ y: 0, animated: true })
    }, 2600)
    const tap = setTimeout(async () => {
      await showTap(backButton.current)
      if (gone) return
      setShowAgain({ tourRow: false, settingsButton: true })
      router.back()
    }, 3400)
    return () => {
      gone = true
      clearTimeout(up)
      clearTimeout(tap)
    }
  }, [again.tourRow, tourRowY, router])

  useEffect(() => {
    let alive = true
    if (switchingProfile) return
    storage
      ?.getKeyValue(HANDLE_KV_KEY)
      .then(v => alive && setHandle(v ?? null))
      .catch(() => {})
    storage
      ?.getKeyValue(DISPLAY_NAME_KV_KEY)
      .then(v => alive && setName(v ?? null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [storage, switchingProfile])

  // the registry keeps "name@domain"; it's shown as @name, as the prototype does
  const fullHandle = handle ?? prefs.pendingHandle
  const shownHandle = fullHandle ? fullHandle.split('@')[0] : null
  const backupsSummary = `${syncOn === false ? 'Sync off' : 'Sync on'} · ${data.backedUp ? 'Backed up' : 'Not backed up'}`

  const notifyValue =
    push.permission === 'granted' ? 'On' : push.permission === 'denied' ? 'Off' : push.permission === 'undetermined' ? 'Not set' : undefined

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <PageHeader
        title="Settings"
        onBack={() => router.back()}
        backRef={backButton}
        action={<ViewInfo about="Settings" text="Mission control. Theme, alerts and security all live here. Poke around, nothing bites." />}
      />
      <SettingsSearch.Provider value={search}>
      <ScrollView ref={scroller} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} showsVerticalScrollIndicator={false}>
        {/* the profile: name, then the handle under it */}
        <PressRow
          onPress={() => router.push('/profile')}
          accessibilityRole="button"
          accessibilityLabel={[name ?? 'Your wallet', shownHandle && `@${shownHandle}`, 'Your profile'].filter(Boolean).join(', ')}
          outerStyle={styles.bleed}
          style={styles.profile}
        >
          <Avatar
            bg={(prefs.avatarBg as AvatarBg) ?? 'mint'}
            portrait={(prefs.avatarPortrait as Portrait) ?? 'dragon'}
            uri={prefs.avatarUri}
            size={56}
          />
          <View style={styles.flex}>
            <Text numberOfLines={1} style={[font(600), styles.name, { color: palette.foreground }]}>
              {name ?? prefs.pendingDisplayName ?? 'Your wallet'}
            </Text>
            {shownHandle ? (
              <Text numberOfLines={1} style={[font(400), styles.small, { color: palette.mutedForeground }]}>
                @{shownHandle}
              </Text>
            ) : null}
          </View>
          <ChevronRight size={16} color={palette.mutedForeground} />
        </PressRow>

        <Section title="Account">
          {shownHandle ? (
            <SettingsRow
              icon={AtSign}
              label="Handle"
              value={`@${shownHandle}`}
              onPress={async () => {
                await Clipboard.setStringAsync(fullHandle!)
                showToast(`${fullHandle} copied`, { type: 'success' })
              }}
            />
          ) : null}
          <SettingsRow
            icon={Tags}
            label="Handles"
            value={`${walletCount} in use`}
            onPress={() => router.push('/handles')}
          />
          <SignInsRow onPress={() => router.push('/sign-ins')} />
        </Section>

        <Section title="Backups">
          <SettingsRow icon={History} label="Backups" value={backupsSummary} tone={data.backedUp ? undefined : 'warning'} onPress={() => setBackupOpen(true)} />
        </Section>

        <Section title="Appearance">
          <SwitchRow icon={Moon} label="Dark mode" value={dark} onValueChange={on => setPref('theme', on ? 'dark' : 'light')} />
          <SettingsRow icon={Smartphone} label="App icon" value={APP_ICONS.find(i => i.id === appIcon)?.name} onPress={() => router.push('/app-icon')} />
          <SettingsRow
            icon={Banknote}
            label="Display currency"
            // testnet coins have no price: totals stay in BSV there
            value={selectedNetwork === 'test' ? 'BSV (testnet)' : display.currency.code}
            onPress={() =>
              selectedNetwork === 'test'
                ? showToast('Testnet coins have no price, so totals stay in BSV', { type: 'info' })
                : setCurrencyOpen(true)
            }
          />
          <SwitchRow
            icon={EyeOff}
            label="Hide balances"
            description="Show •••• instead of amounts"
            value={prefs.privacy}
            onValueChange={v => {
              setPref('privacy', v)
              showToast(v ? 'Balances hidden' : 'Balances visible', {
                type: 'info',
                description: v ? 'Amounts show as •••• until you look again.' : 'Amounts are shown across the app.'
              })
            }}
          />
          {isVaultEnabled() && (
            <SwitchRow
              icon={Vault}
              label="Vault button"
              description="Show Vault in your quick actions"
              value={prefs.showVault}
              onValueChange={v => setPref('showVault', v)}
            />
          )}
        </Section>

        <Section title="Notifications & sounds">
          <SwitchRow
            icon={Bell}
            label="Payment alerts"
            description="When money arrives or leaves"
            value={prefs.paymentAlerts}
            onValueChange={v => {
              setPref('paymentAlerts', v)
              // the alerts are for money arriving (src/notify/PaymentAlerts.tsx)
              showToast(v ? 'Payment alerts on' : 'Payment alerts off', {
                type: 'info',
                description: v ? 'You’ll know the moment money arrives.' : 'You won’t be told when payments arrive.'
              })
            }}
          />
          <SwitchRow
            icon={Volume2}
            label="Sounds"
            description="Play a sound when money comes in or goes out"
            value={prefs.sounds}
            onValueChange={v => setPref('sounds', v)}
          />
          {push.available && (
            <SettingsRow
              icon={BellRing}
              label="Phone notifications"
              value={notifyValue}
              onPress={() => (push.permission === 'undetermined' ? void push.request() : push.openSettings())}
            />
          )}
        </Section>

        <Section title="Data">
          <SettingsRow icon={FileDown} label="Export for accounting" value="CSV or PDF" onPress={() => setExportOpen(true)} />
        </Section>

        <View onLayout={e => setTourRowY(e.nativeEvent.layout.y)}>
        {/* development builds: the prototype's Developer tools (the network here; the rest is the core's configuration screen) */}
        {__DEV__ && (
          <Section title="Advanced">
            <SettingsRow
              icon={Code}
              label="Network"
              value={selectedNetwork === 'test' ? 'Testnet' : 'Mainnet'}
              onPress={() => setNetworkOpen(true)}
            />
            <SettingsRow icon={Wrench} label="Developer tools" value="ARC, message box, trust, logs" onPress={() => router.push('/developer')} />
            {process.env.EXPO_PUBLIC_PUSH_SIMULATE === 'true' && (
              <SettingsRow icon={BellRing} label="Push simulator" onPress={() => router.push('/dev-push')} />
            )}
          </Section>
        )}

        <Section title="Support">
          <SettingsRow icon={CircleHelp} label="Help & support" onPress={() => setHelpOpen(true)} />
          <SettingsRow icon={Info} label="Why Bitcoin SV Wallet" onPress={() => setAboutOpen(true)} />
          {/* transition-shadow duration-500: the ring fades in and out */}
          <Animated.View
            style={[
              styles.tourRow,
              lit && { backgroundColor: palette.gold + '1a' },
              { boxShadow: `0 0 0 2px ${palette.gold}${lit ? '' : '00'}`, transitionProperty: 'boxShadow', transitionDuration: 500, transitionTimingFunction: EASE }
            ]}
          >
            <SettingsRow icon={Compass} label="Take the tour" onPress={() => router.dismissTo({ pathname: '/', params: { tour: '1' } })} />
          </Animated.View>
        </Section>
        </View>

        {/* this phone's wallet */}
        <Pressable
          onPress={() => setForgetOpen(true)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.forget, { backgroundColor: palette.destructive + (pressed ? '26' : '1a') }]}
        >
          <Trash2 size={16} color={palette.destructive} />
          <Text style={[font(600), styles.small, { color: palette.destructive }]}>Forget wallet</Text>
        </Pressable>

        <Text style={[font(400), styles.version, { color: palette.mutedForeground }]}>Bitcoin SV Wallet {APP_VERSION}</Text>
      </ScrollView>
      </SettingsSearch.Provider>

      {/* display currency picker */}
      <BottomSheet
        open={currencyOpen}
        onOpenChange={setCurrencyOpen}
        title="Display currency"
        description="Your total balance and conversions are shown in this currency."
        fullScreen
      >
        <View style={styles.list}>
          {DISPLAY_CURRENCIES.map(c => {
            const on = c.code === display.currency.code
            return (
              <Pressable
                key={c.code}
                onPress={() => {
                  setCurrencyOpen(false)
                  void display.set(c.code).then(() => showToast(`Totals now shown in ${c.code}`, { type: 'success' }))
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${c.name}, ${c.code}`}
                style={({ pressed }) => [
                  styles.currency,
                  on ? { boxShadow: `0 0 0 2px ${palette.ink}` } : pressed && { backgroundColor: palette.secondary + '99' }
                ]}
              >
                {c.flag ? (
                  <Flag country={c.flag} size={34} />
                ) : (
                  <BsvMark size={34} />
                )}
                <Text style={[font(500), styles.small, styles.flex, { color: palette.foreground }]}>{c.name}</Text>
                <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{c.code}</Text>
              </Pressable>
            )
          })}
        </View>
      </BottomSheet>

      <BackupSheet open={backupOpen} onOpenChange={setBackupOpen} />
      <AboutSheet open={aboutOpen} onOpenChange={setAboutOpen} />
      <HelpSheet open={helpOpen} onOpenChange={setHelpOpen} />
      <ExportSheet open={exportOpen} onOpenChange={setExportOpen} />
      {__DEV__ && (
        <BottomSheet open={networkOpen} onOpenChange={setNetworkOpen} title="Network" description="Testnet coins have no value: for trying payments out.">
          <View style={styles.list}>
            {(
              [
                { id: 'main', label: 'Mainnet' },
                { id: 'test', label: 'Testnet' }
              ] as const
            ).map(n => {
              const on = selectedNetwork === n.id
              return (
                <Pressable
                  key={n.id}
                  onPress={() => {
                    setNetworkOpen(false)
                    if (!on) void switchNetwork(n.id).then(() => showToast(`On ${n.label.toLowerCase()} now`, { type: 'success' }))
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={({ pressed }) => [styles.currency, on ? { boxShadow: `0 0 0 2px ${palette.ink}` } : pressed && { backgroundColor: palette.secondary + '99' }]}
                >
                  <Text style={[font(500), styles.small, styles.flex, { color: palette.foreground }]}>{n.label}</Text>
                </Pressable>
              )
            })}
          </View>
        </BottomSheet>
      )}
      <ForgetWalletSheet
        open={forgetOpen}
        onOpenChange={setForgetOpen}
        backedUp={data.backedUp}
        onBackUp={() => {
          setForgetOpen(false)
          afterSheetCloses(() => setBackupOpen(true))
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 16, gap: 16, paddingTop: 8 },
  bleed: { marginHorizontal: -8 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 12, paddingVertical: 12, borderRadius: radii.xl },
  flex: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, lineHeight: 24 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  forget: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 999 },
  tourRow: { borderRadius: radii.xl },
  version: { fontSize: 12, lineHeight: 16, textAlign: 'center', paddingBottom: 8 },
  list: { gap: 6 },
  currency: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii['2xl'], paddingHorizontal: 12, paddingVertical: 10 },
})

/** Websites signed in to with this wallet (app/sign-in.tsx), counted live. */
const SignInsRow = observer(function SignInsRow({ onPress }: { onPress: () => void }) {
  const n = connectionStore.connections.length
  return <SettingsRow icon={Globe} label="Sign-ins" value={n ? `${n} website${n === 1 ? '' : 's'}` : 'None'} onPress={onPress} />
})

/** Which section each searchable row is in (Activity's search lands on it). */
const ROW_SECTION: Record<string, string> = {
  Handle: 'Account',
  Handles: 'Account',
  'Sign-ins': 'Account',
  Backups: 'Backups',
  'Dark mode': 'Appearance',
  'App icon': 'Appearance',
  'Display currency': 'Appearance',
  'Hide balances': 'Appearance',
  'Vault button': 'Appearance',
  'Payment alerts': 'Notifications & sounds',
  Sounds: 'Notifications & sounds',
  'Phone notifications': 'Notifications & sounds',
  'Export for accounting': 'Data',
  Network: 'Advanced',
  'Developer tools': 'Advanced',
  'Help & support': 'Support',
  'Why Bitcoin SV Wallet': 'Support',
  'Take the tour': 'Support'
}
