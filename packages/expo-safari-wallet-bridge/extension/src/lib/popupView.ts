/**
 * The popup (spec 6.8): status and guidance, no approval step. The status is the background's `ping`; the steps
 * are the one-time site-access flow Safari itself asks for.
 */
export const POPUP_STEPS: readonly string[] = [
  'Open a site that offers Bitcoin SV Wallet and tap the puzzle piece in Safari’s address bar.',
  'Choose “Always Allow”, then “Always Allow on Every Website” or this website only.',
  'Return to the site and connect. The wallet app opens when a payment or approval is needed.'
]

export interface PopupDocument {
  getElementById(id: string): { textContent: string | null; appendChild?(n: any): unknown } | null
  createElement?(tag: string): { textContent: string | null }
}

export async function renderPopup(
  doc: PopupDocument,
  runtime: { sendMessage(message: unknown): Promise<any> }
): Promise<void> {
  const status = doc.getElementById('status')
  const steps = doc.getElementById('steps')
  if (steps && doc.createElement && steps.appendChild) {
    for (const text of POPUP_STEPS) {
      const li = doc.createElement('li')
      li.textContent = text
      steps.appendChild(li)
    }
  }
  try {
    const reply = await runtime.sendMessage({ type: 'ping' })
    if (status) status.textContent = reply && reply.pong ? `${reply.name} is on` : 'No answer'
  } catch {
    if (status) status.textContent = 'No answer'
  }
}
