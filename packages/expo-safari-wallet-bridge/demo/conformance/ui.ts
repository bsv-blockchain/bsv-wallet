/**
 * Plain-DOM Conformance panel (no framework): renders the controller's cards and results into `#conformance`.
 * LOCAL file (not vendored). Safari 16 / phone width; the demo page's styles live in index.html.
 */
import type { Card } from './registry'
import type { CardRow, Controller } from './controller'

const GROUP_TITLES: Record<Card['group'], string> = {
  conformance: 'BRC-100 methods (28)',
  branch: 'Branch matrices (no funds)',
  funded: 'Funded workflows (spend real sats)',
  certificate: 'Certificate workflows (may cost fees)'
}

export interface MountOptions {
  /** Test seams. */
  confirm?: (message: string) => boolean
  clipboard?: { writeText(text: string): Promise<void> }
  userAgent?: string
}

export function mountConformance(doc: Document, controller: Controller, opts: MountOptions = {}) {
  const root = doc.getElementById('conformance')
  if (!root) return undefined
  const confirmFn = opts.confirm ?? (typeof confirm === 'function' ? (m: string) => confirm(m) : () => true)
  const open = new Set<string>()

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: { class?: string; text?: string; id?: string } = {},
    children: (Node | undefined)[] = []
  ): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag)
    if (props.class) e.className = props.class
    if (props.id) e.id = props.id
    if (props.text !== undefined) e.textContent = props.text
    for (const c of children) if (c) e.appendChild(c)
    return e
  }
  const button = (label: string, onClick: () => void, id?: string): HTMLButtonElement => {
    const b = el('button', { text: label, id })
    b.type = 'button'
    b.addEventListener('click', onClick)
    return b
  }

  // Static controls are built once so the build-note field keeps focus and text across re-renders.
  const status = el('p', { class: 'cf-status', id: 'cf-status' })
  const build = el('input', { id: 'cf-build' })
  build.setAttribute('aria-label', 'Wallet build')
  build.setAttribute('placeholder', 'Wallet build / commit (goes in the report)')
  const runAll = button('Run all safe', () => void controller.runAllSafe(), 'cf-run-all')
  const stopBtn = button('Stop after current', () => controller.stop(), 'cf-stop')
  const copyBtn = button('Copy report', () => void copyReport(), 'cf-copy')
  const reportBox = el('textarea', { id: 'cf-report' })
  reportBox.readOnly = true
  reportBox.hidden = true
  reportBox.setAttribute('aria-label', 'Report JSON')
  const list = el('div', { id: 'cf-list' })

  root.textContent = ''
  root.appendChild(el('h2', { text: 'Conformance' }))
  root.appendChild(
    el('p', {
      text:
        'fast.brc.dev BRC-100 conformance set and branch matrices, run against the wallet reached through this ' +
        'connection. Run all safe never starts a card that spends sats or may cost fees: those have their own Run button.'
    })
  )
  root.appendChild(status)
  root.appendChild(el('div', { class: 'row' }, [runAll, stopBtn, copyBtn]))
  root.appendChild(el('div', { class: 'row' }, [build]))
  root.appendChild(reportBox)
  root.appendChild(list)

  async function copyReport(): Promise<void> {
    const text = JSON.stringify(
      controller.report({ walletBuild: build.value.trim(), userAgent: opts.userAgent }),
      null,
      2
    )
    const clip =
      opts.clipboard ?? (globalThis as { navigator?: { clipboard?: MountOptions['clipboard'] } }).navigator?.clipboard
    try {
      if (!clip) throw new Error('no clipboard')
      await clip.writeText(text)
      copyBtn.textContent = 'Copied'
    } catch {
      // Safari can refuse the async clipboard outside a gesture: show the JSON to copy by hand.
      reportBox.hidden = false
      reportBox.value = text
      reportBox.select?.()
      copyBtn.textContent = 'Copy report'
    }
  }

  function runCardClick(card: Card): void {
    if (
      card.spending &&
      !confirmFn(`${card.title} spends real mainnet funds or may cost fees:\n\n${card.spending}\n\nRun it?`)
    )
      return
    void controller.runCard(card.id)
  }

  function statusCell(row: { status: string } | undefined, running: boolean): HTMLElement {
    if (running) return el('span', { class: 'cf-st cf-run', text: 'running' })
    if (!row) return el('span', { class: 'cf-st cf-none', text: '-' })
    return el('span', { class: `cf-st cf-${row.status}`, text: row.status })
  }

  function cardNode(card: Card): HTMLElement {
    const row: CardRow | undefined = controller.results.get(card.id)
    const isRunning = controller.running === card.id
    const head = el('div', { class: 'cf-head' }, [
      el('span', { class: 'cf-id', text: card.title }),
      statusCell(row, isRunning),
      el('span', { class: 'cf-ms', text: row ? `${row.durationMs} ms` : '' }),
      el('span', { class: 'cf-code', text: row?.errorCode === undefined ? '' : String(row.errorCode) }),
      button('Run', () => runCardClick(card))
    ])
    head.querySelector('button')!.disabled = controller.running !== undefined
    const node = el('div', { class: 'cf-card' }, [head])
    node.setAttribute('data-card', card.id)
    if (card.spending) node.appendChild(el('p', { class: 'cf-spend', text: card.spending }))
    if (row?.message && row.status !== 'pass') node.appendChild(el('p', { class: 'cf-msg', text: row.message }))
    if (row && row.cases.length) {
      const d = el('details', {}, [
        el('summary', {
          text: `${row.cases.length} cases (${row.cases.filter(c => c.status === 'pass').length} pass, ${
            row.cases.filter(c => c.status === 'fail').length
          } fail, ${row.cases.filter(c => c.status === 'skip').length} skip)`
        })
      ])
      d.open = open.has(card.id)
      d.addEventListener('toggle', () => (d.open ? open.add(card.id) : open.delete(card.id)))
      for (const c of row.cases) {
        d.appendChild(
          el('div', { class: 'cf-case' }, [
            el('span', { class: 'cf-id', text: c.id }),
            statusCell(c, false),
            el('span', { class: 'cf-ms', text: `${c.durationMs} ms` }),
            el('span', { class: 'cf-code', text: c.errorCode === undefined ? '' : String(c.errorCode) })
          ])
        )
      }
      node.appendChild(d)
    }
    return node
  }

  function render(): void {
    const busy = controller.running !== undefined
    status.textContent = controller.connected
      ? busy
        ? `Running ${controller.running}${controller.stopping ? ' (stopping after it)' : ''}`
        : 'Connected. Ready.'
      : 'Not connected: press connect above first.'
    runAll.disabled = busy
    stopBtn.disabled = !busy || controller.stopping
    list.textContent = ''
    for (const group of Object.keys(GROUP_TITLES) as Card['group'][]) {
      const cards = controller.cards.filter(c => c.group === group)
      if (!cards.length) continue
      list.appendChild(el('h3', { text: GROUP_TITLES[group] }))
      for (const c of cards) list.appendChild(cardNode(c))
    }
  }

  render()
  return { render, copyReport }
}
