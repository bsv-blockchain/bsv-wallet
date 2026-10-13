// The prototype's motion vocabulary (app/globals.css and its Tailwind
// classes), as Reanimated 4 CSS animations. Keyframes, durations and easing
// curves are copied from the prototype so motion feels the same; they run on
// the UI thread on both platforms.
import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'
import { css, cubicBezier } from 'react-native-reanimated'

/** cubic-bezier(0.22, 1, 0.36, 1): Home's entrance rise. */
export const EASE_OUT_QUINT = cubicBezier(0.22, 1, 0.36, 1)
/** cubic-bezier(0.34, 1.4, 0.64, 1): the card stack's springy shuffle. */
export const EASE_SPRING = cubicBezier(0.34, 1.4, 0.64, 1)
/** cubic-bezier(0.34, 1.56, 0.64, 1): CTA press. */
export const EASE_PRESS = cubicBezier(0.34, 1.56, 0.64, 1)

/** @keyframes enter-rise — Home's sections rise in one after another. */
export const enterRise = css.keyframes({
  from: { opacity: 0, transform: [{ translateY: 10 }] },
  to: { opacity: 1, transform: [{ translateY: 0 }] }
})

/** @keyframes tour-art-a — the tour overlay, on for the first half. */
export const tourArtA = css.keyframes({
  '0%': { opacity: 1 },
  '42%': { opacity: 1 },
  '50%': { opacity: 0 },
  '86%': { opacity: 0 },
  '94%': { opacity: 1 },
  '100%': { opacity: 1 }
})

/** @keyframes tour-art-b — the video frame, on for the second half. */
export const tourArtB = css.keyframes({
  '0%': { opacity: 0 },
  '42%': { opacity: 0 },
  '50%': { opacity: 1 },
  '86%': { opacity: 1 },
  '94%': { opacity: 0 },
  '100%': { opacity: 0 }
})

/** @keyframes play-pulse — a ring swelling out from the play button. */
export const playPulse = css.keyframes({
  '0%': { opacity: 0.55, transform: [{ scale: 1 }] },
  '100%': { opacity: 0, transform: [{ scale: 1.9 }] }
})

/** @keyframes coin-bob — a gentle 7px bob. */
export const coinBob = css.keyframes({
  '0%': { transform: [{ translateY: 0 }] },
  '50%': { transform: [{ translateY: -7 }] },
  '100%': { transform: [{ translateY: 0 }] }
})

/** @keyframes medallion-float — a 7px bob with a breath of scale (the feedback card's dragon). */
export const medallionFloat = css.keyframes({
  '0%': { transform: [{ translateY: 0 }, { scale: 1 }] },
  '50%': { transform: [{ translateY: -7 }, { scale: 1.025 }] },
  '100%': { transform: [{ translateY: 0 }, { scale: 1 }] }
})

/** @keyframes spin */
export const spin = css.keyframes({
  from: { transform: [{ rotate: '0deg' }] },
  to: { transform: [{ rotate: '360deg' }] }
})

/**
 * @keyframes feedback-blob — the card backdrops' drifting light. The
 * prototype moves by percentages of each blob's own size; `size` turns those
 * into points.
 */
export const feedbackBlob = (size: number) =>
  css.keyframes({
    '0%': { transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] },
    '33%': { transform: [{ translateX: size * 0.12 }, { translateY: size * 0.08 }, { scale: 1.12 }] },
    '66%': { transform: [{ translateX: -size * 0.08 }, { translateY: size * 0.12 }, { scale: 0.94 }] },
    '100%': { transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] }
  })

/** The OS "reduce motion" setting, as the prototype's motion-reduce variants. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then(v => alive && setReduced(v))
      .catch(() => {})
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => {
      alive = false
      sub.remove()
    }
  }, [])
  return reduced
}

const ENTER_FRAMES = new Map<string, ReturnType<typeof css.keyframes>>()

/**
 * tw-animate's `animate-in` (fade-in / slide-in-from-* / zoom-in-*): from
 * the given start values to rest. `duration-*`, `delay-*` and the default
 * `ease` come along as animation settings.
 */
export function enter({
  opacity = 0,
  translateY = 0,
  translateX = 0,
  scale = 1,
  rotate = 0,
  duration = 150,
  delay = 0,
  easing = 'ease'
}: {
  opacity?: number
  translateY?: number
  translateX?: number
  scale?: number
  /** spin-in-*: degrees to turn from */
  rotate?: number
  duration?: number
  delay?: number
  easing?: 'ease' | 'ease-out' | 'ease-in-out' | ReturnType<typeof cubicBezier>
}) {
  // one keyframes rule per start state: a fresh object on every render would
  // restart the animation whenever the screen re-renders
  const key = `${opacity}|${translateX}|${translateY}|${scale}|${rotate}`
  let frames = ENTER_FRAMES.get(key)
  if (!frames) {
    frames = css.keyframes({
      from: { opacity, transform: [{ translateX }, { translateY }, { scale }, { rotate: `${rotate}deg` }] },
      to: { opacity: 1, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }, { rotate: '0deg' }] }
    })
    ENTER_FRAMES.set(key, frames)
  }
  return {
    animationName: frames,
    animationDuration: duration,
    animationDelay: delay,
    animationTimingFunction: easing,
    animationFillMode: 'both' as const
  }
}

/** @keyframes why-float — Welcome's chips drifting beside the phone. */
export const whyFloat = css.keyframes({
  '0%': { transform: [{ translateY: 0 }] },
  '50%': { transform: [{ translateY: -8 }] },
  '100%': { transform: [{ translateY: 0 }] }
})

/** @keyframes pop-in */
export const popIn = css.keyframes({
  from: { transform: [{ scale: 0 }] },
  to: { transform: [{ scale: 1 }] }
})

/** @keyframes confetti-burst, with this bit's way out. */
export const confettiBurst = (dx: number, dy: number) =>
  css.keyframes({
    '0%': { opacity: 1, transform: [{ translateX: 0 }, { translateY: 0 }, { rotate: '0deg' }] },
    '100%': { opacity: 0, transform: [{ translateX: dx }, { translateY: dy }, { rotate: '160deg' }] }
  })

/** @keyframes tag-swing (rotate about the top: give the view transformOrigin 'top'). */
export const tagSwing = css.keyframes({
  '0%': { transform: [{ rotate: '-6deg' }] },
  '50%': { transform: [{ rotate: '8deg' }] },
  '100%': { transform: [{ rotate: '-6deg' }] }
})

/** @keyframes data-refused — a chip arrives, is refused, drifts away. */
export const dataRefused = css.keyframes({
  '0%': { opacity: 0, transform: [{ translateY: 12 }, { scale: 0.9 }] },
  '12%': { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
  '48%': { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
  '72%': { opacity: 0, transform: [{ translateY: -34 }, { scale: 0.95 }] },
  '100%': { opacity: 0, transform: [{ translateY: -34 }, { scale: 0.95 }] }
})

/** @keyframes data-strike (scaleX from the left: transformOrigin 'left'). */
export const dataStrike = css.keyframes({
  '0%': { transform: [{ scaleX: 0 }] },
  '18%': { transform: [{ scaleX: 0 }] },
  '30%': { transform: [{ scaleX: 1 }] },
  '100%': { transform: [{ scaleX: 1 }] }
})

/** A fill growing from the left edge to full width, for content that mustn't be stretched. */
export const widthFill = css.keyframes({
  from: { width: '0%' },
  to: { width: '100%' }
})

/** @keyframes bar-fill (transformOrigin 'left'). */
export const barFill = css.keyframes({
  from: { transform: [{ scaleX: 0 }] },
  to: { transform: [{ scaleX: 1 }] }
})

/** @keyframes brief-coin-away — a coin leaving for the stranger. */
export const briefCoinAway = css.keyframes({
  '0%': { opacity: 0, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 0.6 }, { rotate: '0deg' }] },
  '12%': { opacity: 1 },
  '100%': { opacity: 0, transform: [{ translateX: 110 }, { translateY: -18 }, { scale: 0.85 }, { rotate: '220deg' }] }
})

/**
 * @keyframes brief-stamp — "Scam", stamped a moment after the message lands.
 * At -20°: the prototype's rotate-[-10deg] class stacks with the keyframe's own.
 */
export const briefStamp = css.keyframes({
  '0%': { opacity: 0, transform: [{ rotate: '-20deg' }, { scale: 2.2 }] },
  '30%': { opacity: 0, transform: [{ rotate: '-20deg' }, { scale: 2.2 }] },
  '42%': { opacity: 1, transform: [{ rotate: '-20deg' }, { scale: 0.92 }] },
  '50%': { opacity: 1, transform: [{ rotate: '-20deg' }, { scale: 1 }] },
  '88%': { opacity: 1, transform: [{ rotate: '-20deg' }, { scale: 1 }] },
  '100%': { opacity: 0, transform: [{ rotate: '-20deg' }, { scale: 1 }] }
})

/** @keyframes brief-write — a line being written (transformOrigin 'left'). */
export const briefWrite = css.keyframes({
  '0%': { transform: [{ scaleX: 0 }] },
  '8%': { transform: [{ scaleX: 1 }] },
  '85%': { transform: [{ scaleX: 1 }] },
  '95%': { transform: [{ scaleX: 0 }] },
  '100%': { transform: [{ scaleX: 0 }] }
})

/** @keyframes brief-drop — the phone slipping away. */
export const briefDrop = css.keyframes({
  '0%': { opacity: 1, transform: [{ translateY: 0 }, { rotate: '0deg' }] },
  '25%': { opacity: 1, transform: [{ translateY: 0 }, { rotate: '0deg' }] },
  '70%': { opacity: 0, transform: [{ translateY: 70 }, { rotate: '-14deg' }] },
  '100%': { opacity: 0, transform: [{ translateY: 0 }, { rotate: '0deg' }] }
})

/** @keyframes wallet-return — an avatar dropping back onto the phone. */
export const walletReturn = css.keyframes({
  '0%': { opacity: 0, transform: [{ translateY: -46 }, { scale: 0.9 }] },
  '60%': { opacity: 1 },
  '100%': { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] }
})

/** @keyframes star-fill — the review prompt's stars filling one after another. */
export const starFill = css.keyframes({
  '0%': { opacity: 0, transform: [{ scale: 0.6 }] },
  '60%': { opacity: 1, transform: [{ scale: 1.22 }] },
  '100%': { opacity: 1, transform: [{ scale: 1 }] }
})

/** @keyframes tour-hint-in — a tour label (or arrowhead) settling in. */
export const tourHintIn = css.keyframes({
  from: { opacity: 0, transform: [{ translateY: 4 }] },
  to: { opacity: 1, transform: [{ translateY: 0 }] }
})
