// The prototype's money toast (lib/notify.tsx `notifyMoney`): the face on the
// other side, who and how, and the signed amount, green coming in. A
// toast.custom in the same bottom stack as the other toasts (src/ui/Toast),
// for 4.5 seconds; a tap opens the payment, or just puts the toast away when
// there's no payment to open.
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react-native'
import type { Counterparty } from '@bsv/expo-wallet-toolbox'
import { font, radii, usePalette } from '../theme'
import { Face } from '../ui/Face'
import { showCustomToast } from '../ui/Toast'

export type MoneyToast = {
  title: string
  description?: string
  /** signed, with its unit: "+0.0015 BSV" */
  amount?: string
  incoming?: boolean
  counterparty?: Counterparty | null
  /** the Activity row to open on a tap */
  activityId?: string
  /** or the payment request to open (src/requests) */
  requestId?: string
  /** or Pay, with this link */
  payLink?: string
}

export function notifyMoney(t: MoneyToast) {
  showCustomToast(dismiss => <MoneyCard toast={t} dismiss={dismiss} />, { duration: 4500 })
}

function MoneyCard({ toast, dismiss }: { toast: MoneyToast; dismiss: () => void }) {
  const palette = usePalette()
  const router = useRouter()
  const face = toast.counterparty && toast.counterparty.kind !== 'txid' ? toast.counterparty : null
  return (
    <Pressable
      onPress={() => {
        dismiss()
        if (toast.activityId) router.push({ pathname: '/activity/[id]', params: { id: toast.activityId } })
        else if (toast.requestId) router.push({ pathname: '/requests/[id]', params: { id: toast.requestId } })
        else if (toast.payLink) router.push({ pathname: '/send', params: { link: toast.payLink } })
      }}
      accessibilityRole="button"
      accessibilityLabel={[toast.title, toast.description, toast.amount].filter(Boolean).join(', ')}
      // rounded-2xl border border-border bg-popover p-3 shadow-lg
      style={[
        styles.card,
        {
          backgroundColor: palette.popover,
          borderColor: palette.border,
          boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)'
        }
      ]}
    >
      {face ? (
        <Face counterparty={face} size={40} />
      ) : (
        <View style={[styles.glyph, { backgroundColor: (toast.incoming ? palette.positive : palette.foreground) + '1f' }]}>
          {toast.incoming ? <ArrowDownLeft size={18} color={palette.positive} /> : <ArrowUpRight size={18} color={palette.foreground} />}
        </View>
      )}
      <View style={styles.middle}>
        <Text numberOfLines={1} style={[font(600), styles.title, { color: palette.popoverForeground }]}>
          {toast.title}
        </Text>
        {toast.description && (
          <Text numberOfLines={1} style={[font(400), styles.description, { color: palette.mutedForeground }]}>
            {toast.description}
          </Text>
        )}
      </View>
      {toast.amount && (
        <Text style={[font(600), styles.title, { color: toast.incoming ? palette.positive : palette.popoverForeground, fontVariant: ['tabular-nums'] }]}>
          {toast.amount}
        </Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii['2xl'], borderWidth: 1, padding: 12 },
  glyph: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  middle: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, lineHeight: 20 },
  description: { fontSize: 12, lineHeight: 16 }
})
