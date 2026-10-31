/**
 * Raises one BRC-100-style connection prompt on the wallet's PermissionSheet.
 *
 * The in-app browser that would normally raise this lives in the sibling
 * apps. This fixture is how the wallet's own sheet is exercised. It refuses
 * to register anything unless the E2E harness is on.
 */
import type { PendingConsent } from '../bridge/consent'
import { setConsentSheetSource } from '../bridge/consentSheetSource'
import { isE2eBuild } from './mode'

const FIXTURE: PendingConsent = {
  requestId: 'e2e-consent',
  origin: 'https://e2e.example',
  attestation: 'unattested',
  transportId: 'e2e',
  connectedBefore: false,
  walletRevision: 1,
  profileKey: 'e2e'
}

export function presentE2eConsentFixture(): void {
  if (!isE2eBuild()) return
  let pending: PendingConsent[] = [FIXTURE]
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const fn of listeners) fn()
  }
  setConsentSheetSource({
    store: {
      listPending: () => pending,
      answerConsent: async requestId => {
        pending = pending.filter(p => p.requestId !== requestId)
        emit()
        return undefined
      },
      onChange: fn => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      }
    },
    context: () => ({ walletRevision: 1, profileKey: 'e2e' })
  })
}
