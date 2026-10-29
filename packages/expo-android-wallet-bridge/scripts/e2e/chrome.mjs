// Chrome on the emulator driven over CDP (puppeteer-core, no browser download).
import puppeteer from 'puppeteer-core'
import { adb, shell, sleep, tapText, waitForNode, tapXY } from './adb.mjs'
import { center, findByText } from './parse.mjs'

const CHROME = 'com.android.chrome'

/** Command-line flags so a fresh emulator Chrome skips first-run UI, and a persistent debug app so DevTools is reachable. */
export async function setupChrome() {
  await shell(
    `echo "chrome --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line && chmod 755 /data/local/tmp/chrome-command-line`
  )
  await shell(`am set-debug-app --persistent ${CHROME}`)
  await shell(`am force-stop ${CHROME}`)
}

export async function startChrome(url = 'about:blank') {
  await shell(`am start -a android.intent.action.VIEW -d '${url}' ${CHROME}`)
  await sleep(1500)
}

export async function forwardDevtools(port = 9222) {
  await adb(['forward', `tcp:${port}`, 'localabstract:chrome_devtools_remote'])
  return port
}

/** Attach puppeteer to the running Chrome; retries while DevTools starts. */
export async function connect(port = 9222, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now()
  for (;;) {
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw e
      await sleep(700)
    }
  }
}

/** The visible page tab (several tabs can be open: only the foreground one gets real input), else the last, else a new one. */
export async function firstPage(browser) {
  const pages = await browser.pages()
  for (const p of [...pages].reverse()) {
    const visible = await p.evaluate(() => document.visibilityState === 'visible').catch(() => false)
    if (visible) return p
  }
  return pages[pages.length - 1] || (await browser.newPage())
}

/** A trusted click (user activation) at the centre of `selector`, via CDP `Input.dispatchMouseEvent`. */
export async function clickGesture(page, selector) {
  const el = await page.waitForSelector(selector, { visible: true, timeout: 15000 })
  await el.evaluate(e => e.scrollIntoView({ block: 'center' }))
  const box = await el.boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const cdp = await page.createCDPSession()
  try {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1
      })
    }
  } finally {
    await cdp.detach().catch(() => {})
  }
}

/**
 * Grant the loopback permission for `origin`. Tries the CDP names in order (`loopbackNetwork`, then
 * `localNetworkAccess`); if neither is accepted, taps the Chrome permission dialog through uiautomator.
 * Resolves with how it was granted: 'cdp:<name>' | 'dialog' | 'none'.
 */
export async function grantLoopback(browser, origin, { dialogTimeoutMs = 4000 } = {}) {
  // Chrome 155's CDP names are camelCase (`loopbackNetwork`, `localNetworkAccess`); the kebab-case names are the
  // Permissions API names and `Browser.grantPermissions` refuses them ("Unknown permission type").
  // puppeteer's overridePermissions only knows its own list, so the call goes straight to the browser session.
  const session = await browser.target().createCDPSession()
  try {
    for (const name of ['loopbackNetwork', 'localNetworkAccess']) {
      try {
        await session.send('Browser.grantPermissions', { origin, permissions: [name] })
        return `cdp:${name}`
      } catch {
        // not a known permission name in this Chrome: try the next
      }
    }
  } finally {
    await session.detach().catch(() => {})
  }
  try {
    const n = await waitForNode(nodes => findByText(nodes, 'Allow'), {
      timeoutMs: dialogTimeoutMs,
      what: 'permission dialog'
    })
    await tapXY(center(n))
    return 'dialog'
  } catch {
    return 'none'
  }
}

export { tapText }
