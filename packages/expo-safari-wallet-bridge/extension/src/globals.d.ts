// Build constants the plugin's esbuild `define`s (spec 6.3 step 7); the extension reads these, never a plist.
declare const allowLocalhostHttp: boolean
declare const BRIDGE_SCHEME: string
declare const BRIDGE_NAME: string
declare const BRIDGE_VENDOR: string

// WebExtension API surface (Safari exposes `browser`). Typed loosely until the real client lands.
declare const browser: any
