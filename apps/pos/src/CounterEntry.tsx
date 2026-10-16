import React from 'react'
import { Pressable, Text, View } from 'react-native'
import { Button, Chip, Field, colors, styles } from './ui'
import { checkoutTotal, enterDigit, formatSats, type TipChoice } from './checkout'
export function CounterEntry({
  amount,
  onAmount,
  tipChoice,
  onTipChoice,
  customTip,
  onCustomTip,
  busy,
  onCharge,
  showActions = true
}: {
  amount: string
  onAmount(v: string): void
  tipChoice: TipChoice
  onTipChoice(v: TipChoice): void
  customTip: string
  onCustomTip(v: string): void
  busy: boolean
  onCharge(): void
  showActions?: boolean
}) {
  let breakdown = { subtotal: 0, tip: 0, total: 0 },
    error = ''
  try {
    breakdown = checkoutTotal(amount, tipChoice, customTip)
  } catch (e) {
    error = e instanceof Error ? e.message : 'Invalid amount'
  }
  return (
    <View style={{ gap: 20 }}>
      <View style={[styles.card, { paddingVertical: 32, alignItems: 'center' }]}>
        <Text style={styles.label}>Total to collect · SATS</Text>
        <Text
          accessibilityLabel={`Total ${breakdown.total} satoshis`}
          adjustsFontSizeToFit
          numberOfLines={1}
          style={[styles.amountHero, { width: '100%' }]}
        >
          {formatSats(breakdown.total)}
        </Text>
        <Text style={styles.caption}>
          {formatSats(breakdown.subtotal)} sale{breakdown.tip ? ` + ${formatSats(breakdown.tip)} tip` : ' · no tip'}
        </Text>
      </View>
      <View accessibilityLabel="Sale amount keypad" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'delete'].map(digit => (
          <Pressable
            key={digit}
            accessibilityRole="button"
            accessibilityLabel={digit === 'delete' ? 'Delete last digit' : `Enter ${digit}`}
            disabled={busy}
            onPress={() => onAmount(enterDigit(amount, digit))}
            style={({ pressed }) => ({
              width: '30%',
              flexGrow: 1,
              minHeight: 72,
              borderRadius: 18,
              backgroundColor: pressed ? colors.line : colors.raised,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: busy ? 0.4 : 1
            })}
          >
            <Text style={{ color: colors.text, fontSize: digit === 'delete' ? 25 : 30, fontWeight: '500' }}>
              {digit === 'delete' ? '⌫' : digit}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={{ gap: 12 }}>
        <Text style={styles.label}>Add a tip</Text>
        <View style={styles.chips}>
          {(['none', 10, 20, 'custom'] as TipChoice[]).map(choice => (
            <Chip
              key={choice}
              title={choice === 'none' ? 'No tip' : choice === 'custom' ? 'Custom' : `${choice}%`}
              selected={choice === tipChoice}
              onPress={() => {
                if (!busy) onTipChoice(choice)
              }}
            />
          ))}
        </View>
        {tipChoice === 'custom' && (
          <Field label="Custom tip in satoshis" value={customTip} onChange={onCustomTip} numeric />
        )}
        <Text style={styles.caption}>
          Tips go to the merchant wallet with the sale. Confirm the tip with the customer before requesting payment.
        </Text>
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {showActions && (
        <>
          <Button
            title={busy ? 'Preparing payment…' : `Charge ${formatSats(breakdown.total)} sats`}
            disabled={busy || !!error || breakdown.subtotal < 1}
            onPress={onCharge}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear sale"
            disabled={busy}
            onPress={() => {
              onAmount('')
              onTipChoice('none')
              onCustomTip('')
            }}
            style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
          >
            <Text style={styles.caption}>Clear sale</Text>
          </Pressable>
        </>
      )}
    </View>
  )
}
