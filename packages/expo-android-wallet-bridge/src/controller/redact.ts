/**
 * Redaction for any text that could reach a log or an error message (spec 8.3). The launch secret `k`, the epoch,
 * the launch URI, the binding headers and base64url secret-like runs are replaced; nothing here is reversible.
 */
const LAUNCH_URI = /(?:bsv-wallet-bridge|intent):\/\/[^\s"'<>]*/gi
const SECRET_HEADER = /(BRC-185-(?:Key|Android-Binding|Android-Ack|Reconnect-Token))(\s*[:=]\s*)[^\s,;"']+/gi
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const LAUNCH_PARAM = /\b([ekn])=[A-Za-z0-9_-]{16,}/g
// 16 bytes is 22 base64url characters: anything at least that long and unbroken is treated as secret-like.
const B64U_RUN = /[A-Za-z0-9_-]{22,}/g

export function redact(text: string): string {
  return String(text)
    .replace(LAUNCH_URI, '[redacted-launch]')
    .replace(SECRET_HEADER, '$1$2[redacted]')
    .replace(LAUNCH_PARAM, '$1=[redacted]')
    .replace(UUID, '[redacted-epoch]')
    .replace(B64U_RUN, '[redacted]')
}
