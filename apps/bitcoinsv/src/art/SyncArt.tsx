// The prototype's SyncArt (components/sync-setup.tsx): a history clock in a
// disc, ringed by a dashed gold circle turning once every 14s.
import React from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'
import { Check, History } from 'lucide-react-native'
import { usePalette } from '../theme'
import { spin, useReducedMotion } from '../ui/motion'

export function SyncArt({ size = 96, done = false, onDark = false }: { size?: number; done?: boolean; onDark?: boolean }) {
  const palette = usePalette()
  const still = useReducedMotion()
  const Icon = done ? Check : History
  const disc = size * 0.74
  const ring = 3
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={[
          { position: 'absolute', width: size, height: size },
          still ? null : { animationName: spin, animationDuration: 14000, animationIterationCount: 'infinite', animationTimingFunction: 'linear' }
        ]}
      >
        <Svg width={size} height={size}>
          {/* border-[3px] border-dashed */}
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={size / 2 - ring / 2}
            stroke={palette.gold}
            strokeOpacity={onDark ? 1 : 0.7}
            strokeWidth={ring}
            strokeDasharray={[ring * 3, ring * 2]}
            fill="none"
          />
        </Svg>
      </Animated.View>
      <View
        style={{
          width: disc,
          height: disc,
          borderRadius: disc / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: onDark ? 'rgba(255,255,255,0.15)' : 'rgba(255,175,0,0.2)',
          // shadow-[0_0_40px_-4px_rgb(234_179_0/0.5)]: outside the disc only, as CSS draws it
          boxShadow: onDark ? '0 0 40px -4px rgba(234,179,0,0.5)' : undefined
        }}
      >
        <Icon size={size * 0.36} color={onDark ? palette.gold : palette.goldDeep} strokeWidth={2.2} />
      </View>
    </View>
  )
}
