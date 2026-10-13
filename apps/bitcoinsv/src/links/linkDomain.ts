// The website domain the app answers for (EXPO_PUBLIC_LINK_DOMAIN, e.g.
// bitcoinsv.com), or '' while none is set up: links stay pay links then.
// Its own module: Expo inlines EXPO_PUBLIC_ values, which tests can't load.
export const LINK_DOMAIN = (process.env.EXPO_PUBLIC_LINK_DOMAIN ?? '').trim().toLowerCase()
