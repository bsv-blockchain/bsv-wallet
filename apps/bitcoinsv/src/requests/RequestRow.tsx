// A payment request in Activity (the prototype's request rows): the face on
// the other side, who asked whom, its state, and the amount, always faint.
// A tap opens the request (app/requests/[id].tsx).
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { font, radii, usePalette } from '../theme'
import { Face } from '../ui/Face'
import { timeLabel } from '../activity/format'
import { amountText } from './useRequests'
import { whoLabel, type PaymentRequest } from './requests'

const STATUS: Record<PaymentRequest['status'], string> = {
  pending: 'Waiting',
  paid: 'Paid',
  declined: 'Declined',
  cancelled: 'Cancelled'
}

export function requestTitle(r: PaymentRequest, contactName?: string) {
  const who = whoLabel(r, contactName)
  return r.direction === 'out' ? `You requested from ${who}` : `${who} requests`
}

export function requestSubtitle(r: PaymentRequest) {
  return [timeLabel(r.createdAt), STATUS[r.status], r.note].filter(Boolean).join(' · ')
}

export function RequestRow({ r, contactName }: { r: PaymentRequest; contactName?: string }) {
  const palette = usePalette()
  const router = useRouter()
  const title = requestTitle(r, contactName)
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/requests/[id]', params: { id: r.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${amountText(r)}, ${requestSubtitle(r)}`}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.secondary + '99' }]}
    >
      <Face counterparty={{ kind: 'identityKey', value: r.counterparty }} size={40} />
      <View style={styles.middle}>
        <Text numberOfLines={1} style={[font(500), styles.title, { color: palette.foreground }]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={[font(400), styles.sub, { color: palette.mutedForeground }]}>
          {requestSubtitle(r)}
        </Text>
      </View>
      <Text
        style={[
          font(600),
          styles.amount,
          // muted whatever its state (tx-row.tsx: a request's amount is text-muted-foreground)
          { color: palette.mutedForeground },
          (r.status === 'declined' || r.status === 'cancelled') && styles.struck
        ]}
      >
        {amountText(r)}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 12, paddingVertical: 12 },
  middle: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, lineHeight: 20 },
  sub: { fontSize: 12, lineHeight: 16 },
  amount: { fontSize: 14, lineHeight: 20, textAlign: 'right', fontVariant: ['tabular-nums'] },
  struck: { textDecorationLine: 'line-through' }
})
