// The tour on video (the prototype's components/tour-video.tsx). It covers
// the app; the chevron shrinks it to a small player in the corner that keeps
// playing while you use the app, and Skip ends it. One player throughout,
// mounted once at the root, so shrinking never restarts it. Subtitles are
// drawn over the video (tour-subtitles), and when it ends it asks for a
// review. Which video plays is set in src/config/explainerVideo.ts.
import React, { useEffect, useMemo, useState } from 'react'
import { Image, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { BlurView } from 'expo-blur'
import { useRouter } from 'expo-router'
import { setShowAgain } from './showAgain'
import { CoinTube } from '../art/CoinTube'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useEvent } from 'expo'
import { VideoView, useVideoPlayer } from 'expo-video'
import { loveIt } from '../feedback/feedback'
import { asksFirst } from '../feedback/config'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Captions, CaptionsOff, ChevronDown, Maximize2, Star, X } from 'lucide-react-native'
import { showToast } from '../ui/Toast'
import { EXPLAINER_VIDEO, type TourCaptions } from '../config/explainerVideo'
import { setPref } from '../state/prefs'
import { font, usePalette } from '../theme'
import { GlassButton } from '../ui/GlassButton'
import { enter, starFill, useReducedMotion } from '../ui/motion'
import { BalancedText } from '../ui/BalancedText'

export type TourVideoMode = 'closed' | 'full' | 'mini'

/* ---- open / shrink / close, from anywhere ---- */
let current: TourVideoMode = 'closed'
const listeners = new Set<(m: TourVideoMode) => void>()
export function setTourVideo(mode: TourVideoMode) {
  current = mode
  listeners.forEach(fn => fn(mode))
}
function useTourVideoMode(): TourVideoMode {
  const [mode, setMode] = useState(current)
  useEffect(() => {
    listeners.add(setMode)
    return () => {
      listeners.delete(setMode)
    }
  }, [])
  return mode
}

const VAUL = cubicBezier(0.32, 0.72, 0, 1)
const CC_KEY = 'bitcoinsv.tour.subtitles'

/** Subtitles on or off, remembered on this device. */
function useCaptionsPref(): [boolean, () => void] {
  const [cc, setCC] = useState(true)
  useEffect(() => {
    AsyncStorage.getItem(CC_KEY)
      .then(v => setCC(v !== 'off'))
      .catch(() => {})
  }, [])
  const toggle = () => {
    setCC(v => {
      void AsyncStorage.setItem(CC_KEY, v ? 'off' : 'on').catch(() => {})
      return !v
    })
  }
  return [cc, toggle]
}

/** The subtitles file, bundled or fetched. */
function useCaptions(): TourCaptions | null {
  const src = EXPLAINER_VIDEO.captions
  const [data, setData] = useState<TourCaptions | null>(typeof src === 'object' ? src : null)
  useEffect(() => {
    if (typeof src !== 'string') return
    let live = true
    fetch(src)
      .then(r => (r.ok ? r.json() : null))
      .then(d => live && setData(d))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [src])
  return data
}

/** What's on screen at time t: the subtitle, how many of its lines, and the lit word. */
function stateAt(data: TourCaptions | null, t: number) {
  if (!data || data.hide.some(([a, b]) => t >= a && t < b)) return { page: -1, lines: 0, word: -1 }
  const page = data.pages.findIndex(p => t >= p.start && t < p.end)
  if (page < 0) return { page: -1, lines: 0, word: -1 }
  const p = data.pages[page]
  const words = p.lines.flat()
  // a line joins just before the voice reaches it; a word is lit until the next begins
  const lines = p.lines.filter(l => t >= l[0].t - 0.05).length
  const word = words.findIndex((w, i) => t >= w.t && t < (words[i + 1]?.t ?? w.e + 0.15))
  return { page, lines, word }
}

export function TourVideoHost() {
  const router = useRouter()
  const mode = useTourVideoMode()
  const insets = useSafeAreaInsets()
  const { width: W, height: H } = useWindowDimensions()
  const still = useReducedMotion()
  const [cc, toggleCC] = useCaptionsPref()
  const captions = useCaptions()
  const [ended, setEnded] = useState(false)

  const player = useVideoPlayer(EXPLAINER_VIDEO.source, p => {
    p.timeUpdateEventInterval = 0.05
  })
  const { status } = useEvent(player, 'statusChange', { status: player.status })
  const time = useEvent(player, 'timeUpdate', { currentTime: 0, currentLiveTimestamp: null, currentOffsetFromLive: null, bufferedPosition: 0 })
  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      setEnded(true)
      setPref('tourDone', true)
      // in the corner it would go unseen
      if (current === 'mini') setTourVideo('full')
    })
    return () => sub.remove()
  }, [player])

  // opened: from the start, with its voice
  useEffect(() => {
    if (mode === 'closed') {
      player.pause()
      return
    }
    if (!player.playing && !ended) player.play()
  }, [mode, player, ended])

  const close = () => {
    setTourVideo('closed')
    setEnded(false)
    player.pause()
    player.currentTime = 0
    setPref('tourDone', true)
    // and where to find it again: Settings, its row lit up
    setShowAgain({ tourRow: true })
    router.push('/settings')
  }

  const now = useMemo(() => stateAt(captions, time.currentTime), [captions, time.currentTime])
  if (mode === 'closed') return null
  const mini = mode === 'mini'
  const loading = status === 'loading' || status === 'idle'

  // full: the whole screen; mini: a 9:16 player in the corner
  const miniW = 128
  const frame = mini
    ? { left: W - 16 - miniW, top: H - Math.max(16, insets.bottom) - (miniW * 16) / 9, width: miniW, height: (miniW * 16) / 9, borderRadius: 16 }
    : { left: 0, top: 0, width: W, height: H, borderRadius: 0 }
  // the video's own 9:16 area inside the player (letterboxed to fit)
  const boxW = Math.min(frame.width, (frame.height * 9) / 16)

  return (
    <Animated.View
      accessibilityViewIsModal={!mini}
      accessibilityLabel="Tour video"
      style={[
        styles.player,
        frame,
        mini && styles.miniRing,
        still
          ? null
          : {
              transitionProperty: ['left', 'top', 'width', 'height', 'borderRadius'],
              transitionDuration: 500,
              transitionTimingFunction: VAUL
            }
      ]}
    >
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls={!mini && !loading && !ended}
        allowsPictureInPicture={false}
      />

      {/* loading: over the poster */}
      {loading && !ended && (
        <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel="Loading the video">
          <Image source={EXPLAINER_VIDEO.poster} resizeMode="contain" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, styles.dim]} />
          {/* coins filling a tube, again and again (the prototype's, from the landing site) */}
          <CoinTube loop onDark width={mini ? 40 : 112} />
        </View>
      )}

      {/* subtitles over the video; too small to read in the corner player */}
      {cc && !mini && !ended && captions && now.page >= 0 && (
        <Subtitles
          page={captions.pages[now.page]}
          shownLines={now.lines}
          word={now.word}
          width={boxW}
          height={(boxW * 16) / 9}
          left={(frame.width - boxW) / 2}
          top={(frame.height - (boxW * 16) / 9) / 2}
        />
      )}

      {ended && !mini && (
        <ReviewPrompt
          onDone={close}
          onReplay={() => {
            setEnded(false)
            player.currentTime = 0
            player.play()
          }}
        />
      )}

      {mini ? (
        <>
          {/* the whole mini player expands; the X ends it */}
          <Pressable accessibilityRole="button" accessibilityLabel="Expand tour video" onPress={() => setTourVideo('full')} style={styles.expand}>
            <View style={styles.miniButton}>
              <Maximize2 size={14} color="#ffffff" />
            </View>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Close tour video" onPress={close} style={[styles.miniButton, styles.miniClose]}>
            <X size={14} color="#ffffff" />
          </Pressable>
        </>
      ) : (
        !ended && (
          <View style={[styles.bar, { paddingTop: Math.max(16, insets.top) }]}>
            <Pressable onPress={close} accessibilityRole="button" style={styles.skip}>
              <Text style={[font(600), styles.skipText]}>Skip</Text>
            </Pressable>
            <View style={styles.barRight}>
              <Pressable
                onPress={toggleCC}
                accessibilityRole="button"
                accessibilityLabel={cc ? 'Hide subtitles' : 'Show subtitles'}
                accessibilityState={{ selected: cc }}
                style={styles.round}
              >
                {cc ? <Captions size={20} color="#ffffff" /> : <CaptionsOff size={20} color="#ffffff" />}
              </Pressable>
              <Pressable
                onPress={() => setTourVideo('mini')}
                accessibilityRole="button"
                accessibilityLabel="Minimise to picture in picture"
                style={styles.round}
              >
                <ChevronDown size={20} color="#ffffff" />
              </Pressable>
            </View>
          </View>
        )
      )}
    </Animated.View>
  )
}

/**
 * The sentence being spoken, on dark bars, one per line, two lines at most;
 * the second joins when the voice reaches it, and the word being spoken
 * lights up in the wallet's yellow. Sized to the video (5.3% of its width).
 */
function Subtitles({
  page,
  shownLines,
  word,
  width,
  height,
  left,
  top
}: {
  page: TourCaptions['pages'][number]
  shownLines: number
  word: number
  width: number
  height: number
  left: number
  top: number
}) {
  const size = width * 0.053
  const words = page.lines.flat()
  return (
    <View pointerEvents="none" importantForAccessibility="no-hide-descendants" style={[styles.subs, { width, height, left, top }]}>
      <View style={[styles.subLines, { bottom: height * 0.08, gap: size * 0.12 }]}>
        {page.lines.map((line, i) => (
          <Animated.View
            key={`${page.start}-${i}`}
            style={[
              styles.subLine,
              { borderRadius: size * 0.3, paddingHorizontal: size * 0.3, paddingTop: size * 0.06, paddingBottom: size * 0.1 },
              { opacity: i < shownLines ? 1 : 0, transform: [{ translateY: i < shownLines ? 0 : size * 0.15 }] },
              { transitionProperty: ['opacity', 'transform'], transitionDuration: 200, transitionTimingFunction: 'ease-out' }
            ]}
          >
            {line.map((w, j) => {
              const on = words.indexOf(w) === word
              return (
                <React.Fragment key={`${w.t}-${w.w}`}>
                  {/* the space sits between the words, outside the highlight */}
                  {j > 0 && <Text style={[font(700), { fontSize: size, lineHeight: size * 1.2 }]}> </Text>}
                  <Text
                    style={[
                      font(700),
                      { fontSize: size, lineHeight: size * 1.2, color: on ? '#111111' : '#ffffff' },
                      on && { backgroundColor: '#EAB300', borderRadius: size * 0.24 },
                      { paddingHorizontal: size * 0.12, marginHorizontal: -size * 0.07 }
                    ]}
                  >
                    {w.w}
                  </Text>
                </React.Fragment>
              )
            })}
          </Animated.View>
        ))}
      </View>
    </View>
  )
}

/**
 * After the tour video: "Enjoying Bitcoin SV Wallet?" ("Rate Bitcoin SV
 * Wallet" on Android, where Google Play allows no such question), five stars filling
 * with gold one after another, and a way to leave a review: the store's own
 * rating sheet.
 */
function ReviewPrompt({ onDone, onReplay }: { onDone: () => void; onReplay: () => void }) {
  const palette = usePalette()
  const still = useReducedMotion()
  // the store's own rating, as after "I love it" (src/feedback)
  const review = async () => {
    onDone()
    if ((await loveIt()) === 'later') showToast('Reviews open once Bitcoin SV Wallet is in the store', { type: 'info' })
  }
  return (
    <Animated.View style={[styles.review, enter({ opacity: 0, duration: 500 })]}>
      {/* bg-black/70 backdrop-blur-sm (iOS: Android can't blur the video's surface) */}
      {Platform.OS === 'ios' && <BlurView intensity={12} tint="dark" style={StyleSheet.absoluteFill} />}
      <View style={[StyleSheet.absoluteFill, styles.reviewDim]} />
      <View style={styles.reviewBox}>
        {/* Google Play allows no question about how it's going before its rating (src/feedback/config.ts) */}
        <BalancedText style={[font(700), styles.reviewTitle]}>{asksFirst(Platform.OS) ? 'Enjoying Bitcoin SV Wallet?' : 'Rate Bitcoin SV Wallet'}</BalancedText>
        <BalancedText style={[font(400), styles.reviewBody]}>A review helps other people find it, and tells us what to make better.</BalancedText>
        <View style={styles.stars} accessibilityLabel="Five stars">
          {[0, 1, 2, 3, 4].map(i => (
            <View key={i} style={styles.star}>
              <Star size={36} color="rgba(255,255,255,0.5)" strokeWidth={1.4} style={StyleSheet.absoluteFill} />
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  // drop-shadow-[0_0_10px_rgba(234,179,0,0.55)]: a glow around the filled star
                  STAR_GLOW,
                  still
                    ? null
                    : { animationName: starFill, animationDuration: 450, animationDelay: 400 + i * 130, animationTimingFunction: 'ease-out', animationFillMode: 'both' }
                ]}
              >
                <Star size={36} color={palette.gold} fill={palette.gold} strokeWidth={1.4} />
              </Animated.View>
            </View>
          ))}
        </View>
        <View style={styles.full}>
          <GlassButton label="Leave a review" onPress={() => void review()} />
        </View>
        <View style={styles.reviewRow}>
          <Pressable onPress={onReplay} accessibilityRole="button" style={[styles.reviewButton, styles.reviewGhost]}>
            <Text style={[font(600), styles.reviewButtonText]}>Watch again</Text>
          </Pressable>
          <Pressable onPress={onDone} accessibilityRole="button" style={styles.reviewButton}>
            <Text style={[font(600), styles.reviewButtonText, { color: 'rgba(255,255,255,0.8)' }]}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  )
}

/**
 * The filled stars' glow. iOS shadows follow a transparent view's content;
 * Android draws a CSS drop-shadow filter.
 */
const STAR_GLOW = Platform.select({
  ios: { shadowColor: '#EAB300', shadowOpacity: 0.55, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } },
  default: { filter: [{ dropShadow: { offsetX: 0, offsetY: 0, standardDeviation: 5, color: 'rgba(234,179,0,0.55)' } }] }
})

const styles = StyleSheet.create({
  player: { position: 'absolute', zIndex: 70, overflow: 'hidden', backgroundColor: '#000000', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)' },
  miniRing: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  loading: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  dim: { backgroundColor: 'rgba(0,0,0,0.55)' },
  expand: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end', alignItems: 'flex-start', padding: 8 },
  miniButton: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  miniClose: { position: 'absolute', right: 6, top: 6 },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 32,
    experimental_backgroundImage: 'linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)'
  },
  skip: { height: 40, justifyContent: 'center', paddingHorizontal: 12 },
  skipText: { fontSize: 15, lineHeight: 20, color: 'rgba(255,255,255,0.85)' },
  barRight: { flexDirection: 'row', gap: 8 },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)'
  },
  subs: { position: 'absolute' },
  subLines: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  subLine: { flexDirection: 'row', backgroundColor: 'rgba(22,22,24,0.84)', boxShadow: '0 0 20px rgba(0,0,0,0.22)' },
  review: { ...StyleSheet.absoluteFill, zIndex: 10, alignItems: 'center', justifyContent: 'center', padding: 24 },
  reviewDim: { backgroundColor: 'rgba(0,0,0,0.7)' },
  reviewBox: { width: '100%', maxWidth: 320, alignItems: 'center', gap: 16 },
  reviewTitle: { textAlign: 'center', fontSize: 24, lineHeight: 32, letterSpacing: -0.6, color: '#ffffff' },
  reviewBody: { textAlign: 'center', fontSize: 14, lineHeight: 23, color: 'rgba(255,255,255,0.7)' },
  stars: { flexDirection: 'row', gap: 8, paddingVertical: 4 },
  star: { width: 36, height: 36 },
  full: { alignSelf: 'stretch' },
  reviewRow: { alignSelf: 'stretch', flexDirection: 'row', gap: 8 },
  reviewButton: { flex: 1, height: 44, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  reviewGhost: { backgroundColor: 'rgba(255,255,255,0.15)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  reviewButtonText: { fontSize: 14, lineHeight: 20, color: '#ffffff' }
})
