// The slice of the WebExtension `browser` namespace the kit uses (Safari exposes it as `browser`).
// Typed minimally so the root `tsc` stays at baseline without pulling in a WebExtension types package.

interface BrowserMessageSender {
  tab?: { id?: number; incognito?: boolean; url?: string }
  frameId?: number
  url?: string
  origin?: string
}

interface BrowserEvent<Cb extends (...args: any[]) => unknown> {
  addListener(cb: Cb): void
  removeListener(cb: Cb): void
}

interface BrowserStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

declare const browser: {
  runtime: {
    sendMessage(message: unknown): Promise<any>
    sendNativeMessage(application: string, message: unknown): Promise<unknown>
    onMessage: BrowserEvent<
      (message: any, sender: BrowserMessageSender, sendResponse: (reply?: unknown) => void) => unknown
    >
  }
  storage: { session: BrowserStorageArea; local: BrowserStorageArea }
  tabs: {
    update(tabId: number, props: { url?: string }): Promise<unknown>
    query(info: Record<string, unknown>): Promise<Array<{ id?: number; url?: string; incognito?: boolean }>>
    onRemoved: BrowserEvent<(tabId: number) => void>
  }
}
