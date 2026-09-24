/**
 * Re-export shim.
 *
 * Share parsing, compatibility checks and recombination are pure TypeScript
 * with no UI dependency, so they moved to `core/recovery/shares.ts` where the
 * headless recovery module (core-only, never imports `ui/`) can reach them
 * without crossing the core→ui boundary. `@bsv/expo-wallet-toolbox/ui`
 * consumers (printRecoveryShares.ts, __tests__/ui/backupShares.test.ts) keep
 * importing from here unaffected. `generatePrintHTML` stays here: it renders
 * HTML/SVG for `expo-print`, which is presentation, not a recovery primitive.
 */
export * from '../core/recovery/shares'

import QRCode from 'qrcode'

/**
 * Generate a QR code as an inline SVG string.
 * Uses the `qrcode` package which does pure-JS SVG string generation.
 */
async function generateQRCodeSVG(data: string, size: number = 180): Promise<string> {
  const svgString = await QRCode.toString(data, {
    type: 'svg',
    width: size,
    margin: 1,
    errorCorrectionLevel: 'M'
  })
  return svgString
}

/**
 * Generate printable HTML with one page per backup share.
 *
 * Layout matches the reference implementation (secure-key-backup-and-recovery):
 *   - Header: "Share N of M" + date stamp
 *   - Share QR code + share text
 *   - Identity Key QR code + identity key text
 *   - Recovery instructions footer
 *
 * Pages are separated by CSS page-break-after for print dialogue.
 */
export async function generatePrintHTML(
  shares: string[],
  identityKey: string,
  format: 'entropy' | 'legacy' = 'entropy',
  appName: string = 'your wallet app'
): Promise<string> {
  const now = new Date()
  const date = now.toISOString().split('T')[0]
  const time = now.toISOString().split('T')[1].split('.')[0]
  const dateStamp = `${date} ${time}`

  // Pre-generate all QR codes
  const shareQRs = await Promise.all(shares.map(s => generateQRCodeSVG(s, 180)))
  const identityQR = await generateQRCodeSVG(identityKey, 150)

  const pages = shares.map(
    (share, i) => `
    <div class="page${i < shares.length - 1 ? '' : ' last'}">
      <div class="header">
        <span class="share-label">Share ${i + 1} of ${shares.length}</span>
        <span class="date-stamp">${dateStamp}</span>
      </div>

      <div class="section">
        <div class="qr-container identity-qr">
          ${identityQR}
        </div>
        <div class="data-label">Identifier</div>
        <div class="data-value">${identityKey}</div>
        <div class="identity-caption">Scan this QR code to send BSV payments to this wallet.</div>
      </div>

      <div class="divider"></div>

      <div class="section">
        <div class="qr-container">
          ${shareQRs[i]}
        </div>
        <div class="data-label">Backup Share</div>
        <div class="data-value share-text">${share}</div>
      </div>

      <div class="divider"></div>

      <div class="instructions">
        <strong>Recovery Instructions</strong>
        <p>This is 1 of ${shares.length} backup shares. You need any ${shares[0].split('.')[2]} shares to recover your wallet.</p>
        <p>Store each share in a separate, secure location. Do not store shares together.</p>
        <p>${
          format === 'entropy'
            ? 'Any two of these pages rebuild your twelve-word recovery phrase, and therefore your entire wallet — everyday balance and vault alike. Treat two pages together as you would the phrase itself.'
            : 'These shares are an older format. They restore your everyday balance but cannot open a vault.'
        }</p>
        <p>To recover: In ${appName}, go to Import Existing Wallet &rarr; Scan Backup Shares.</p>
      </div>
    </div>
  `
  )

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
          font-family: 'Courier New', Courier, monospace;
          font-weight: 700;
          color: #000;
          background: #fff;
        }

        .page {
          width: 100%;
          padding: 12mm 15mm;
          page-break-after: always;
        }
        .page.last {
          page-break-after: auto;
        }

        .header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 6mm;
          padding-bottom: 3mm;
          border-bottom: 1px solid #ccc;
        }
        .share-label {
          font-size: 16pt;
          font-weight: 700;
        }
        .date-stamp {
          font-size: 9pt;
          color: #444;
        }

        .section {
          margin-bottom: 4mm;
        }
        .qr-container {
          margin-bottom: 3mm;
        }
        .qr-container svg {
          width: 50mm;
          height: 50mm;
        }
        .identity-qr svg {
          width: 40mm;
          height: 40mm;
        }

        .data-label {
          font-size: 11pt;
          font-weight: 700;
          color: #000;
          margin-bottom: 1.5mm;
        }
        .data-value {
          font-size: 7pt;
          font-weight: 700;
          word-break: break-all;
          line-height: 1.4;
          color: #000;
        }
        .share-text {
          font-size: 8.2pt;
          word-break: normal;
          white-space: nowrap;
        }

        .identity-caption {
          margin-top: 2mm;
          font-size: 9pt;
          font-weight: 700;
          color: #000;
        }

        .divider {
          border-top: 1px solid #e0e0e0;
          margin: 4mm 0;
        }

        .instructions {
          margin-top: 4mm;
          font-size: 10pt;
          font-weight: 700;
          line-height: 1.6;
          color: #000;
        }
        .instructions strong {
          display: block;
          font-size: 11pt;
          margin-bottom: 2mm;
        }
        .instructions p {
          margin-bottom: 1.5mm;
        }

        @media print {
          body { background: #fff; }
          .page { padding: 10mm 12mm; }
        }
      </style>
    </head>
    <body>
      ${pages.join('\n')}
    </body>
    </html>
  `
}
