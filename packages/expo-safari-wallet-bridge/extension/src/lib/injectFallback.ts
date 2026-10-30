/** The `<script src>` route to the page world. Pure given its two arguments. */
export interface InjectDocument {
  createElement(tag: string): { src: string; remove?(): void; onload: (() => void) | null }
  documentElement: { appendChild(node: any): unknown }
}

export const PAGE_SCRIPT_PATH = 'provider-main.js'

export function injectProviderScript(doc: InjectDocument, getURL: (path: string) => string): void {
  const script = doc.createElement('script')
  script.src = getURL(PAGE_SCRIPT_PATH)
  script.onload = () => script.remove?.()
  doc.documentElement.appendChild(script)
}
