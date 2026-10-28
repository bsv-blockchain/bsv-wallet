// Per-frame relay (isolated world). All behaviour is in lib/contentRelay.
import { createContentRelay } from './lib/contentRelay'

createContentRelay({ win: window, runtime: browser.runtime })
