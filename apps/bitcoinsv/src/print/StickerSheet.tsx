// From Get paid: a "BitcoinSV Accepted Here" sticker for a label printer, for
// a shop's counter or window. Its QR code opens this wallet's pay link with
// any phone camera; it holds nothing secret, so there's no device check and
// the preview is the real sticker.
import React, { useState } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { usePalette } from '../theme'
import { radii } from '../theme/tokens'
import { LabelView } from './LabelView'
import { BottomSheet } from '../ui/BottomSheet'
import { LabelField } from './DesignSheet'
import { LabelPrinterPanel, SiteLink } from './LabelPrinterPanel'
import { acceptedLabel } from './labelPlan'
import { useAcceptedSticker } from './useAcceptedSticker'

export function StickerSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const palette = usePalette()
  const { width: screen } = useWindowDimensions()
  const accepted = useAcceptedSticker()
  // the sticker at the sheet's width, less its padding and the mat around it
  const previewWidth = Math.min(screen - 32 - 32, 360)
  const [shop, setShop] = useState('')
  const sticker = accepted ? acceptedLabel(accepted.sticker(shop)) : null
  return (
    <BottomSheet
      open={open}
      onOpenChange={o => {
        if (!o) setShop('')
        onOpenChange(o)
      }}
      title="Accepted here sticker"
      description="A 50 × 30 mm sticker for a label printer. Anyone can scan it to pay you, so it’s safe to put up."
    >
      <View style={styles.body}>
        {/* the sticker itself, live: what you type is on it */}
        {sticker && (
          <View style={[styles.mat, { backgroundColor: palette.secondary }]}>
            <View style={styles.sticker}>
              <LabelView spec={sticker.spec} width={previewWidth} />
            </View>
          </View>
        )}
        <LabelField n={null} value={shop} onChange={setShop} placeholder="Shop name (optional)" />
        {sticker && (
          <LabelPrinterPanel
            // a new name: a new sticker to make
            key={shop}
            previews={[sticker]}
            showPreviews={false}
            secret={false}
            heading="Your sticker"
            action="Make sticker"
            intro={
              <>
                An image to print at <SiteLink /> or from your label printer’s app.
              </>
            }
            makeLabels={async () => [sticker]}
          />
        )}
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  body: { gap: 12 },
  mat: { borderRadius: radii.xl, paddingVertical: 18, alignItems: 'center' },
  sticker: { borderRadius: 6, overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.18)' }
})
