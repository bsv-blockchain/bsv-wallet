// Pure parsers for the emulator driver. No Node built-ins, no I/O: this file is the only part under jest.

const decode = s =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r')
    .replace(/&amp;/g, '&')

/**
 * @typedef {{ text: string, id: string, desc: string, cls: string, pkg: string, clickable: boolean,
 *   bounds: { x1: number, y1: number, x2: number, y2: number } }} UiNode
 */

/** Parse `uiautomator dump` XML into a flat node list (document order). @returns {UiNode[]} */
export function parseUiAutomator(xml) {
  const nodes = []
  const tag = /<node\b([^>]*?)\/?>/g
  let m
  while ((m = tag.exec(xml))) {
    const attrs = {}
    const attr = /([\w:-]+)="([^"]*)"/g
    let a
    while ((a = attr.exec(m[1]))) attrs[a[1]] = decode(a[2])
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds || '')
    if (!b) continue
    nodes.push({
      text: attrs.text || '',
      id: attrs['resource-id'] || '',
      desc: attrs['content-desc'] || '',
      cls: attrs.class || '',
      pkg: attrs.package || '',
      clickable: attrs.clickable === 'true',
      bounds: { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] }
    })
  }
  return nodes
}

/** Match `resource-id` (also its `pkg:id/` suffix form), then `content-desc`. */
export function findById(nodes, id) {
  const byId = nodes.find(n => n.id && (n.id === id || n.id.endsWith('/' + id)))
  return byId || nodes.find(n => n.desc === id)
}

/** Exact visible text (or content-desc when a node has no text). */
export function findByText(nodes, text) {
  return nodes.find(n => n.text === text) || nodes.find(n => !n.text && n.desc === text)
}

export function center(node) {
  const { x1, y1, x2, y2 } = node.bounds
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
}

/** First `versionName=` in `dumpsys package` output (the active package comes before hidden stubs). */
export function parseVersionName(dumpsys) {
  const m = /versionName=([\w.]+)/.exec(dumpsys)
  return m ? m[1] : undefined
}

export function chromeAtLeast(version, major) {
  const m = /^(\d+)(?:\.|$)/.exec(String(version).trim())
  return m ? Number(m[1]) >= major : false
}

/** Package of the top resumed activity from `dumpsys activity activities`. */
export function parseTopResumed(dumpsys) {
  const m = /(?:topResumedActivity=|mResumedActivity:)\s*ActivityRecord\{[^ ]+ u\d+ ([\w.]+)\//.exec(dumpsys)
  return m ? m[1] : undefined
}

/**
 * Component names (`package/class`) of every resumed activity from `dumpsys activity activities`, top first. Reads the
 * "Resumed activities in task display areas (from top to bottom)" rows; dumps without that section fall back to the
 * `ResumedActivity:` / `mResumedActivity:` lines. An empty list is the handover transient (no activity resumed).
 * @returns {string[]}
 */
export function parseResumedActivities(dumpsys) {
  const record = /ActivityRecord\{[^ ]+ u\d+ ([\w.$]+\/[\w.$]+)/
  const lines = String(dumpsys).split('\n')
  const head = lines.findIndex(l => /^\s*Resumed activities in task display areas/.test(l))
  const out = []
  if (head >= 0) {
    for (let i = head + 1; i < lines.length; i++) {
      const m = /^\s*Resumed:\s*(.*)$/.exec(lines[i])
      if (!m) break
      const r = record.exec(m[1])
      if (r) out.push(r[1])
    }
    return out
  }
  for (const l of lines) {
    const m = /^\s*m?ResumedActivity:\s*(.*)$/.exec(l)
    const r = m && record.exec(m[1])
    if (r && !out.includes(r[1])) out.push(r[1])
  }
  return out
}

/**
 * The first notification record whose `channel=<channel>`, from `dumpsys notification [--noredact]`.
 * @returns {{ text: string, visibility: string, raw: string } | undefined}
 */
export function parseNotification(dumpsys, channel) {
  const blocks = dumpsys.split(/(?=^\s*NotificationRecord\()/m).filter(b => /^\s*NotificationRecord\(/.test(b))
  for (const raw of blocks) {
    const ch = /channel=([\w.-]+)/.exec(raw)
    if (!ch || ch[1] !== channel) continue
    const vis = /\bvis=(\w+)/.exec(raw)
    const text = /android\.text=\w+ \(([^\n]*)\)\s*$/m.exec(raw)
    return { text: text ? text[1] : '', visibility: vis ? vis[1] : '', raw: raw.trimEnd() }
  }
  return undefined
}
