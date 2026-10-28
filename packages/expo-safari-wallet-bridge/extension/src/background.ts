// Walking-skeleton background: answers `ping` only. Tasks 14 to 16 replace this with the router.
import { MAX_BRIDGE_REQUEST_BYTES } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'

browser.runtime.onMessage.addListener((message: any, _sender: unknown, sendResponse: (reply: unknown) => void) => {
  if (message && message.type === 'ping') {
    sendResponse({
      pong: true,
      name: BRIDGE_NAME,
      scheme: BRIDGE_SCHEME,
      vendor: BRIDGE_VENDOR,
      maxRequestBytes: MAX_BRIDGE_REQUEST_BYTES,
      localhostHttp: allowLocalhostHttp
    })
  }
  return false
})
