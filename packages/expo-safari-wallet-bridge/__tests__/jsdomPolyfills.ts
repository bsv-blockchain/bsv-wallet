// jsdom lacks TextEncoder/TextDecoder, which @bsv/sdk needs at import time. Import this before anything that loads the SDK.
import { TextDecoder, TextEncoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })
