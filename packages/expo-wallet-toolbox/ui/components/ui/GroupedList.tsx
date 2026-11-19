import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme, spacing, radii, typography } from '@bsv/expo-wallet-toolbox'

interface GroupedListSection {
  header?: string
  footer?: string
  /**
   * Draw the rows on a lifted card. Default. `card={false}` puts them straight
   * on the canvas, which is how this app's own settings page is laid out
   * (src/settings/Rows.tsx) — used by the wallet configuration screen so the
   * two read as one design.
   */
  card?: boolean
  children: React.ReactNode
}

interface GroupedListProps {
  sections: GroupedListSection[]
}

/**
 * iOS-style grouped inset list with section headers and footers.
 * Wraps children in rounded, elevated containers on the
 * secondary background.
 */
export const GroupedList: React.FC<GroupedListProps> = ({ sections }) => {
  const { colors } = useTheme()

  return (
    <View style={styles.container}>
      {sections.map((section, idx) => (
        <View key={idx} style={styles.section}>
          {section.header && (
            <Text style={[styles.header, { color: colors.textSecondary }]}>{section.header.toUpperCase()}</Text>
          )}
          <View style={[styles.group]}>{section.children}</View>
          {section.footer && <Text style={[styles.footer, { color: colors.textSecondary }]}>{section.footer}</Text>}
        </View>
      ))}
    </View>
  )
}

/**
 * Standalone section for inline use without the GroupedList wrapper.
 */
export const GroupedSection: React.FC<GroupedListSection> = ({ header, footer, card = true, children }) => {
  const { colors } = useTheme()

  return (
    <View style={styles.section}>
      {header && <Text style={[styles.header, { color: colors.textSecondary }]}>{header.toUpperCase()}</Text>}
      <View
        style={[
          styles.group,
          card && {
            ...styles.card,
            backgroundColor: colors.backgroundElevated,
            borderColor: colors.separator
          }
        ]}
      >
        {children}
      </View>
      {footer && <Text style={[styles.footer, { color: colors.textSecondary }]}>{footer}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  section: {
    marginBottom: spacing.lg
  },
  // Tracked small caps, matching the day headings in the activity list — a
  // section header is a label for the block under it, not a line of prose.
  header: {
    fontFamily: 'Nunito',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600',
    letterSpacing: 1.1,
    paddingHorizontal: spacing.xl,
    paddingBottom: 6
  },
  // A card lifted off the canvas: the border does the work in dark, the shadow
  // in light, and the radius says "object" in both.
  group: {
    marginHorizontal: spacing.sm
  },
  // A card lifted off the canvas: the border does the work in dark, the shadow
  // in light, and the radius says "object" in both.
  card: {
    borderRadius: radii.lg,
    marginHorizontal: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1
  },
  footer: {
    ...typography.footnote,
    fontFamily: 'Nunito',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm
  }
})
