// Background (non-persistent). Listeners are registered synchronously at load: that is what wakes it.
import { createBackground } from './lib/backgroundRouter'
import { createNativeClient, type NativeReply, type NativeRequest } from './lib/nativeClient'
import { MAX_BRIDGE_REQUEST_BYTES } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'

const background = createBackground({
  // Safari ignores the application id; the vendor id is only there to be a string.
  native: createNativeClient(
    m => browser.runtime.sendNativeMessage(BRIDGE_VENDOR, m as NativeRequest) as Promise<NativeReply>
  ),
  session: browser.storage.session,
  now: () => Date.now(),
  allowLocalhostHttp,
  tabs: browser.tabs,
  info: {
    name: BRIDGE_NAME,
    scheme: BRIDGE_SCHEME,
    vendor: BRIDGE_VENDOR,
    maxRequestBytes: MAX_BRIDGE_REQUEST_BYTES,
    localhostHttp: allowLocalhostHttp
  }
})

browser.runtime.onMessage.addListener(background.onMessage)
browser.runtime.onConnect.addListener(background.onConnect)
browser.tabs.onRemoved.addListener(background.onTabRemoved)
browser.tabs.onUpdated.addListener(background.onTabUpdated)
