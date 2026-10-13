// "When would I use which?" (the prototype's components/backup-explainer.tsx):
// the ways to back up side by side, one tab each, with the good and the bad.
// You only need one of them.
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { cubicBezier } from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'
import { Check, CloudUpload, KeyRound, Puzzle, X, type LucideIcon } from 'lucide-react-native'
import { font, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { enter } from '../ui/motion'
import { SYNC_SERVICES, type SyncService } from './syncServices'

export type WayKey = 'sync' | 'seed' | 'slices'

/** The tabs' 300ms colour change, on Tailwind's default curve. */
const EASE = cubicBezier(0.4, 0, 0.2, 1)
const FADE = { transitionProperty: 'backgroundColor' as const, transitionDuration: 300, transitionTimingFunction: EASE }
const FADE_TEXT = { transitionProperty: 'color' as const, transitionDuration: 300, transitionTimingFunction: EASE }

const WAYS: Record<WayKey, { tab: string; icon: LucideIcon; what: string; pros: string[]; cons: string[]; best: React.ReactNode }> = {
  sync: {
    tab: 'Sync',
    icon: CloudUpload,
    what: 'Your wallet, locked on your phone with a password only you know, then saved to your password manager or cloud drive.',
    pros: ['Nothing to write down', 'Back on a new phone in a minute', 'The service only ever sees scrambled data'],
    cons: ['Forget the backup password and it can’t be opened', 'Lose access to that account and the backup goes with it'],
    best: (
      <>
        you already use <Brand id="onepassword" />, <Brand id="bitwarden" />, <Brand id="lastpass" />, <Brand id="icloud" />,{' '}
        <Brand id="googledrive" /> or <Brand id="dropbox" />, and don’t want paper.
      </>
    )
  },
  seed: {
    tab: 'Phrase',
    icon: KeyRound,
    what: '12 words in a set order. Type them into any Bitcoin SV Wallet and your wallet, money and all, is back.',
    pros: ['One thing to keep safe, nothing to hand out', 'Works on its own, anywhere, any time', 'The standard: other wallets understand it too'],
    cons: ['Whoever finds the paper can take everything', 'Lose it along with your phone and the money’s gone'],
    best: 'you have one safe place for a piece of paper, like a safe at home.'
  },
  slices: {
    tab: 'Slices',
    icon: Puzzle,
    what: 'Your key cut into three slices. Any two bring your wallet back; one on its own is useless.',
    pros: ['No single place holds everything', 'Losing one slice is fine', 'A thief who finds one slice gets nothing'],
    cons: ['Three things to store, in three places', 'Restoring needs two of them to hand'],
    best: 'you’d rather not trust one place, or want someone you trust to help you recover.'
  }
}

/** A service's logo in its brand colour on a white tile. */
export function ServiceLogo({ service, size = 40 }: { service: SyncService; size?: number }) {
  return (
    <View style={[styles.logo, { width: size, height: size, borderRadius: size / 2 }]}>
      <Svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55}>
        <Path d={service.path} fill={service.color} />
      </Svg>
    </View>
  )
}

/** A service's name with its logo just before it, inline in a sentence. */
function Brand({ id }: { id: string }) {
  const palette = usePalette()
  const s = SYNC_SERVICES.find(x => x.id === id)
  if (!s) return null
  return (
    <Text style={[font(600), { color: palette.foreground }]}>
      <View style={styles.brandLogo}>
        <ServiceLogo service={s} size={16} />
      </View>{' '}
      {s.name}
    </Text>
  )
}

export function BackupExplainer({ tab: opened, onClose }: { tab: WayKey | null; onClose: () => void }) {
  const palette = usePalette()
  // your tab while it's open; each opening starts on the one asked for
  const [picked, setPicked] = useState<{ from: WayKey | null; tab: WayKey } | null>(null)
  const tab = picked && picked.from === opened ? picked.tab : (opened ?? 'seed')
  const w = WAYS[tab]

  return (
    <BottomSheet
      open={opened !== null}
      onOpenChange={o => !o && onClose()}
      title="When would I use which?"
      description="You only need one. Each brings your wallet back."
    >
      <View style={styles.body}>
        <View accessibilityRole="tablist" style={[styles.tabs, { backgroundColor: palette.secondary }]}>
          {(Object.keys(WAYS) as WayKey[]).map(k => {
            const Icon = WAYS[k].icon
            const on = k === tab
            return (
              <Pressable
                key={k}
                onPress={() => setPicked({ from: opened, tab: k })}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={styles.tabCell}
              >
                {/* transition-colors duration-300 */}
                <Animated.View style={[styles.tab, { backgroundColor: on ? palette.ink : palette.ink + '00', ...FADE }]}>
                  <Icon size={16} color={on ? palette.inkForeground : palette.mutedForeground} />
                  <Animated.Text style={[font(600), styles.tabText, { color: on ? palette.inkForeground : palette.mutedForeground, ...FADE_TEXT }]}>
                    {WAYS[k].tab}
                  </Animated.Text>
                </Animated.View>
              </Pressable>
            )
          })}
        </View>

        <Animated.View key={tab} style={[styles.panel, enter({ opacity: 0, duration: 300 })]}>
          <Text style={[font(400), styles.text, { color: palette.mutedForeground }]}>{w.what}</Text>
          <List title="Good" items={w.pros} good />
          <List title="Watch out" items={w.cons} />
          <View style={[styles.best, { backgroundColor: palette.secondary }]}>
            <Text style={[font(400), styles.text, { color: palette.mutedForeground }]}>
              <Text style={[font(600), { color: palette.foreground }]}>Pick this if </Text>
              {w.best}
            </Text>
          </View>
        </Animated.View>
      </View>
    </BottomSheet>
  )
}

function List({ title, items, good = false }: { title: string; items: string[]; good?: boolean }) {
  const palette = usePalette()
  const tint = good ? palette.positive : palette.destructive
  return (
    <View>
      <Text style={[font(600), styles.text, { color: palette.foreground }]}>{title}</Text>
      <View style={styles.list}>
        {items.map(p => (
          <View key={p} style={styles.item}>
            <View style={[styles.mark, { backgroundColor: tint + (good ? '26' : '1a') }]}>
              {good ? <Check size={12} color={tint} strokeWidth={3} /> : <X size={12} color={tint} strokeWidth={3} />}
            </View>
            <Text style={[font(400), styles.text, styles.flex, { color: palette.foreground }]}>{p}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { gap: 20, paddingBottom: 8 },
  tabs: { flexDirection: 'row', gap: 4, borderRadius: 999, padding: 4 },
  tabCell: { flex: 1 },
  tab: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 8 },
  tabText: { fontSize: 13, lineHeight: 18 },
  panel: { gap: 20 },
  text: { fontSize: 14, lineHeight: 23 },
  list: { gap: 8, paddingTop: 8 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  mark: { marginTop: 2, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  best: { borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 },
  logo: { backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 1px rgba(0,0,0,0.1)' },
  brandLogo: { transform: [{ translateY: 3 }] }
})
