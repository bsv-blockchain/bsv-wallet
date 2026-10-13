// The iOS launch screen's pieces: Home's top as it first draws (the bar, the
// total with its figure to come, Pay and Get paid), so a launch opens straight
// onto Home's layout (plugins/withHomeLaunchScreen.js lays them out). Each is
// drawn here as Home draws it (src/home/TopBar.tsx, BalanceHero.tsx,
// QuickActions.tsx; the palette in src/theme/tokens.ts), light and dark, at 2x
// and 3x, with Chrome, into assets/images/launch/<name>.imageset. The pieces
// that stretch with the screen (the search box, the buttons) are sliced: their
// ends stay, their middle stretches.
//
// Run from apps/bitcoinsv: node scripts/launch-home.js
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'assets/images/launch')
const FONTS = path.join(ROOT, '../../node_modules/@expo-google-fonts/nunito')
const ICONS = path.join(ROOT, '../../node_modules/lucide-react-native/dist/esm/icons')

const PALETTE = {
  light: {
    bg: '#f4f3f0',
    fg: '#262628',
    muted: '#636368',
    secondary: '#e8e7e4',
    border: '#e0dedb',
    card: '#ffffffb3',
    shadow: '0 2px 22px -2px rgba(20,24,40,0.16)'
  },
  dark: {
    bg: '#0b0b0d',
    fg: '#f3f3f1',
    muted: '#98989c',
    secondary: '#252528',
    border: '#ffffff17',
    card: '#161619b3',
    shadow: '0 2px 26px -2px rgba(255,255,255,0.10)'
  }
}

/** A lucide icon as Home draws it: 24-unit paths, stroke 2, round ends. */
function icon(name, size, color) {
  const src = fs.readFileSync(path.join(ICONS, `${name}.mjs`), 'utf8')
  const nodes = [...src.matchAll(/\[\s*"(\w+)",\s*\{([^}]*)\}\s*\]/g)].map(([, tag, attrs]) => {
    const pairs = [...attrs.matchAll(/(\w+): "([^"]*)"/g)].filter(([, k]) => k !== 'key')
    return `<${tag} ${pairs.map(([, k, v]) => `${k}="${v}"`).join(' ')}/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${nodes.join('')}</svg>`
}

// the search box's soft shadow reaches this far round it
const SHADOW = 24
// a sliced piece: this much at each end stays, the 1pt between stretches
const cap = r => r

const PIECES = {
  // the avatar's place, until it draws
  LaunchAvatar: {
    w: 32,
    h: 32,
    html: c => `<div style="width:32px;height:32px;border-radius:16px;background:${c.secondary}"></div>`
  },
  LaunchScan: { w: 20, h: 20, html: c => icon('scan-qr-code', 20, c.fg) },
  LaunchHelp: { w: 20, h: 20, html: c => icon('message-circle-question-mark', 20, c.fg) },
  LaunchSettings: { w: 20, h: 20, html: c => icon('settings', 20, c.fg) },
  // the search box (ring-1 ring-border, the soft lift), sliced across
  LaunchSearch: {
    w: 2 * (SHADOW + 20) + 1,
    h: 40 + 2 * SHADOW,
    slice: { left: SHADOW + 20, right: SHADOW + 20 },
    html: c =>
      `<div style="margin:${SHADOW}px;width:41px;height:40px;border-radius:20px;background:${c.card};box-shadow:0 0 0 1px ${c.border}, ${c.shadow}"></div>`
  },
  LaunchSearchIcon: { w: 16, h: 16, html: c => icon('search', 16, c.muted) },
  // TOTAL BALANCE and its eye, centred
  LaunchTotal: {
    w: 200,
    h: 16,
    html: c =>
      `<div style="width:200px;height:16px;display:flex;align-items:center;justify-content:center;gap:6px"><span style="font:600 12px/16px Nunito;letter-spacing:1.2px;color:${c.muted}">TOTAL BALANCE</span>${icon('eye', 14, c.muted)}</div>`
  },
  // the figure's place (BalanceHero's placeholder)
  LaunchFigure: {
    w: 168,
    h: 40,
    html: c => `<div style="width:168px;height:40px;border-radius:19.04px;background:${c.secondary}"></div>`
  },
  // a button's tile, sliced across
  LaunchTile: {
    w: 2 * cap(20) + 1,
    h: 80,
    slice: { left: 20, right: 20 },
    html: c => `<div style="width:41px;height:80px;border-radius:20px;background:${c.secondary}"></div>`
  },
  LaunchPay: { w: 120, h: 54, html: c => tileLabel(c, 'arrow-up-right', 'Pay') },
  LaunchGetPaid: { w: 120, h: 54, html: c => tileLabel(c, 'arrow-down-left', 'Get paid') }
}

function tileLabel(c, name, label) {
  return `<div style="width:120px;height:54px;display:flex;flex-direction:column;align-items:center;gap:8px">${icon(name, 24, c.fg)}<span style="font:700 15px/22px Nunito;color:${c.fg}">${label}</span></div>`
}

function page(piece, c) {
  const face = (w, file) =>
    `@font-face{font-family:Nunito;font-weight:${w};src:url("file://${path.join(FONTS, file)}")}`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${face(600, '600SemiBold/Nunito_600SemiBold.ttf')}${face(700, '700Bold/Nunito_700Bold.ttf')}
html,body{margin:0;padding:0;background:transparent;width:${piece.w}px;height:${piece.h}px;overflow:hidden}
body>*{display:block}
</style></head><body>${piece.html(c)}</body></html>`
}

/** Chrome writes the screenshot, then lingers: wait for the file, then stop it. */
async function shoot(html, out, piece, scale, tmp) {
  fs.rmSync(out, { force: true })
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--user-data-dir=${path.join(tmp, 'chrome')}`,
      '--no-first-run',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--force-device-scale-factor=${scale}`,
      `--window-size=${piece.w},${piece.h}`,
      `--screenshot=${out}`,
      `file://${html}`
    ],
    { stdio: 'ignore' }
  )
  const t0 = Date.now()
  while (!(fs.existsSync(out) && fs.statSync(out).size > 0)) {
    if (Date.now() - t0 > 20000) throw new Error(`no screenshot: ${out}`)
    await new Promise(r => setTimeout(r, 100))
  }
  await new Promise(r => setTimeout(r, 200))
  chrome.kill('SIGKILL')
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-home-'))
  for (const [name, piece] of Object.entries(PIECES)) {
    const dir = path.join(OUT, `${name}.imageset`)
    fs.mkdirSync(dir, { recursive: true })
    const images = []
    for (const mode of ['light', 'dark']) {
      const html = path.join(tmp, `${name}-${mode}.html`)
      fs.writeFileSync(html, page(piece, PALETTE[mode]))
      for (const scale of [2, 3]) {
        const file = `${name}${mode === 'dark' ? '-dark' : ''}@${scale}x.png`
        await shoot(html, path.join(dir, file), piece, scale, tmp)
        const entry = { idiom: 'universal', filename: file, scale: `${scale}x` }
        if (mode === 'dark') entry.appearances = [{ appearance: 'luminosity', value: 'dark' }]
        if (piece.slice) {
          entry.resizing = {
            mode: '3-part-horizontal',
            center: { mode: 'stretch', width: scale },
            'cap-insets': { left: piece.slice.left * scale, right: piece.slice.right * scale }
          }
        }
        images.push(entry)
      }
    }
    fs.writeFileSync(
      path.join(dir, 'Contents.json'),
      JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2) + '\n'
    )
    console.log(name)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
