// The explainer video the tour ends on: the one place to change it.
//
// The prototype's 9:16 tour video (bitcoinsv-wallet-proto/video/README.md)
// ships in the app, so it plays at once and offline. To use a different
// video, replace these three files, or point EXPO_PUBLIC_TOUR_VIDEO_URL at a
// hosted MP4 (H.264) and its subtitles at EXPO_PUBLIC_TOUR_CAPTIONS_URL
// (the prototype's tour-captions.json format); no code changes either way.
import type { VideoSource } from 'expo-video'
import type { ImageSourcePropType } from 'react-native'

export interface TourCaptions {
  duration: number
  /** stretches with no subtitle (title cards) */
  hide: [number, number][]
  pages: { start: number; end: number; lines: { w: string; t: number; e: number }[][] }[]
}

const url = process.env.EXPO_PUBLIC_TOUR_VIDEO_URL
const captionsUrl = process.env.EXPO_PUBLIC_TOUR_CAPTIONS_URL

export const EXPLAINER_VIDEO: {
  source: VideoSource
  poster: ImageSourcePropType
  /** the subtitles drawn over the video; a URL is fetched, null shows none */
  captions: TourCaptions | string | null
} = {
  source: url ? { uri: url } : require('../../assets/videos/tour.mp4'),
  poster: require('../../assets/videos/tour-poster.jpg'),
  // a hosted video without its own subtitles shows none, rather than the bundled video's
  captions: url ? (captionsUrl ?? null) : (require('../../assets/videos/tour-captions.json') as TourCaptions)
}
