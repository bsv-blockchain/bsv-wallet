/**
 * Notices at the top of the wallet while a page is trying to use it (spec 6.10, 7.2). Each shows only while its
 * condition holds, has a `testID` equal to its translation key, and names no site.
 *
 * - `bridge_notifications_off`: notifications are not granted and something is pending (the page's later requests
 *   would otherwise be invisible);
 * - `bridge_ports_exhausted`: the loopback range was full when a launch tried to open the server;
 * - `bridge_not_ready_android`: a connect found the app up with no wallet (503).
 */
import React, { useEffect, useState } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { radii, spacing, typography } from '@bsv/expo-wallet-toolbox/core/theme/tokens'
import { useTheme } from '@bsv/expo-wallet-toolbox/core/theme/ThemeContext'
import { getAndroidBridge, type AndroidBridge } from './setup'

type NoticeKey = 'bridge_notifications_off' | 'bridge_ports_exhausted' | 'bridge_not_ready_android'

export interface AndroidBridgeNoticesProps {
  /** Defaults to the bridge `setupAndroidBridge` created; tests inject one. */
  bridge?: AndroidBridge
}

function compute(bridge: AndroidBridge): NoticeKey[] {
  const out: NoticeKey[] = []
  const pending = bridge.attention.waitingCount() > 0 || bridge.session.parkedCount() > 0
  let permission: string = 'granted'
  try {
    permission = bridge.native.notificationPermission()
  } catch {
    /* unknown: show nothing */
  }
  if (pending && permission !== 'granted') out.push('bridge_notifications_off')
  if (bridge.notices.active('ports-exhausted')) out.push('bridge_ports_exhausted')
  if (bridge.notices.active('not-ready')) out.push('bridge_not_ready_android')
  return out
}

export function AndroidBridgeNotices({ bridge: given }: AndroidBridgeNoticesProps): React.ReactElement | null {
  const bridge = given ?? getAndroidBridge()
  const { t } = useTranslation()
  const { colors } = useTheme()
  const [keys, setKeys] = useState<NoticeKey[]>(() => (bridge ? compute(bridge) : []))

  useEffect(() => {
    if (!bridge) return
    const refresh = () =>
      setKeys(prev => {
        const next = compute(bridge)
        return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next
      })
    refresh()
    const offNotices = bridge.notices.subscribe(refresh)
    const offWaiting = bridge.attention.onWaitingChange(refresh)
    // The user may grant the permission in system settings and come back.
    const sub = AppState.addEventListener('change', refresh)
    return () => {
      offNotices()
      offWaiting()
      sub?.remove?.()
    }
  }, [bridge])

  if (keys.length === 0) return null
  return (
    <View pointerEvents="none" style={styles.wrap}>
      {keys.map(key => (
        <View
          key={key}
          style={[styles.banner, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}
        >
          <Text testID={key} style={[styles.text, { color: colors.textPrimary }]}>
            {t(key)}
          </Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1100,
    paddingTop: 48,
    paddingHorizontal: spacing.lg
  },
  banner: {
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth
  },
  text: { ...typography.subhead }
})
