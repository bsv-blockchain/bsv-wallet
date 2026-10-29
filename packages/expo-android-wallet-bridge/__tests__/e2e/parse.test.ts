import fs from 'fs'
import path from 'path'

// parse.mjs is a plain ES module for the node driver scripts and jest does not transform .mjs, so the test loads its
// source with the `export` keywords stripped. The file has no imports, so this is a faithful evaluation.
const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/e2e/parse.mjs'), 'utf8')
const names = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1])
// eslint-disable-next-line no-new-func
const parse: Record<string, (...args: any[]) => any> = new Function(
  `${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} }`
)()

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="org.bsvblockchain.wallet" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Approve &amp; connect" resource-id="bridge-approve" class="android.view.View" package="org.bsvblockchain.wallet" content-desc="Approve" clickable="true" bounds="[100,200][300,400]" />
    <node index="1" text="Deny" resource-id="bridge-deny" class="android.view.View" package="org.bsvblockchain.wallet" content-desc="" clickable="true" bounds="[100,500][300,600]" />
    <node index="2" text="" resource-id="" class="android.view.View" package="org.bsvblockchain.wallet" content-desc="Continue" clickable="true" bounds="[0,0][10,10]" />
  </node>
</hierarchy>`

describe('e2e parse helpers', () => {
  it('parseUiAutomator finds bridge-approve by resource-id and returns its center', () => {
    const nodes = parse.parseUiAutomator(XML)
    const n = parse.findById(nodes, 'bridge-approve')
    expect(n).toBeDefined()
    expect(parse.center(n)).toEqual({ x: 200, y: 300 })
    expect(parse.findById(nodes, 'nope')).toBeUndefined()
    expect(parse.findById(nodes, 'bridge-deny').text).toBe('Deny')
    // content-desc is an id fallback
    expect(parse.findById(nodes, 'Continue')).toBeDefined()
  })

  it('findByText matches exact visible text', () => {
    const nodes = parse.parseUiAutomator(XML)
    expect(parse.findByText(nodes, 'Deny')).toBeDefined()
    expect(parse.findByText(nodes, 'Den')).toBeUndefined()
    expect(parse.findByText(nodes, 'Approve & connect')).toBeDefined()
  })

  it('parseVersionName reads versionName from dumpsys package output', () => {
    const out =
      '    versionCode=1 minSdk=29\n    versionName=155.0.8059.79\n    Hidden system packages:\n    versionName=133.0.6943.137\n'
    expect(parse.parseVersionName(out)).toBe('155.0.8059.79')
    expect(parse.parseVersionName('nothing')).toBeUndefined()
  })

  it('chromeAtLeast is false for 141.0.1 and true for 142.0.0 and 150.2', () => {
    expect(parse.chromeAtLeast('141.0.1', 142)).toBe(false)
    expect(parse.chromeAtLeast('142.0.0', 142)).toBe(true)
    expect(parse.chromeAtLeast('150.2', 142)).toBe(true)
    expect(parse.chromeAtLeast('garbage', 142)).toBe(false)
  })

  it('parseTopResumed returns the package of the top resumed activity', () => {
    const out = '  topResumedActivity=ActivityRecord{1a2b3c u0 org.bsvblockchain.wallet/.MainActivity t42}\n'
    expect(parse.parseTopResumed(out)).toBe('org.bsvblockchain.wallet')
    const old =
      '  mResumedActivity: ActivityRecord{9f u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity t7}'
    expect(parse.parseTopResumed(old)).toBe('com.android.chrome')
    expect(parse.parseTopResumed('')).toBeUndefined()
  })

  it('parseNotification returns text and visibility for a channel and undefined when absent', () => {
    const dump = `  NotificationRecord(0x01: pkg=org.bsvblockchain.wallet user=UserHandle{0} id=7 tag=null importance=2 key=k1:
      Notification(channel=bridge-session shortcut=null contentView=null defaults=0x0 flags=0x62 category=service vis=PRIVATE semFlags=0x0)
      extras={
        android.title=String (Wallet bridge)
        android.text=String (A connection is open)
      }
  NotificationRecord(0x02: pkg=org.bsvblockchain.wallet user=UserHandle{0} id=8 tag=null importance=4 key=k2:
      Notification(channel=bridge-attention shortcut=null defaults=0x0 flags=0x10 category=msg vis=PRIVATE)
      extras={
        android.text=String (Approval needed)
      }
`
    const s = parse.parseNotification(dump, 'bridge-session')
    expect(s).toMatchObject({ text: 'A connection is open', visibility: 'PRIVATE' })
    expect(s.raw).toContain('id=7')
    expect(s.raw).not.toContain('id=8')
    expect(parse.parseNotification(dump, 'bridge-attention').text).toBe('Approval needed')
    expect(parse.parseNotification(dump, 'other')).toBeUndefined()
  })
})
