# Files for bitcoinsv.com

So the phone opens `https://bitcoinsv.com/pay/…` and `https://bitcoinsv.com/@…`
links in the app (when it's installed), host these two files on the site,
replacing the placeholders. Builds turn the links on with
`EXPO_PUBLIC_LINK_DOMAIN=bitcoinsv.com` (see app.config.js and
docs/backend-integration.md).

| File | Served at | Replace |
|---|---|---|
| `.well-known/apple-app-site-association` | `https://bitcoinsv.com/.well-known/apple-app-site-association` and `https://www.bitcoinsv.com/…` | `APPLE_TEAM_ID`: the Apple Developer team that signs `com.bitcoinsv.wallet` |
| `.well-known/assetlinks.json` | `https://bitcoinsv.com/.well-known/assetlinks.json` and `https://www.bitcoinsv.com/…` | the SHA-256 fingerprints of the release signing key and, with Play App Signing, Google's app signing key (Play Console → App integrity) |

Both must be served over HTTPS with status 200, no redirects, and
`Content-Type: application/json` (the Apple file has no extension).
