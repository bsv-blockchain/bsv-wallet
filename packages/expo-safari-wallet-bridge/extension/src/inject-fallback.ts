// Fallback injection (spec 6.8): if Safari does not honour `"world": "MAIN"`, this isolated script adds the
// page-world script as a `<script src>` from `web_accessible_resources`. It fails under a strict page CSP,
// which is why `"world": "MAIN"` is the primary route. The manifest uses this entry only when built with
// `injection: 'script-tag'` (see plugin/buildExtension.js).
import { injectProviderScript } from './lib/injectFallback'

injectProviderScript(document, path => browser.runtime.getURL(path))
